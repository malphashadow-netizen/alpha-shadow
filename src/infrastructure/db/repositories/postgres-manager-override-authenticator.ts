/**
 * Live manager-override PIN challenge (Phase 7, spec 2.4 + the security
 * additions: live challenge + brute-force rate limiting).
 *
 * A manager override is NEVER a name picked from a list. At the exact moment
 * of the void, the approving manager's OWN separate PIN is verified against
 * the existing credential store (users.pin_hash — the Phase-3 HMAC-SHA256
 * scheme keyed by PIN_HASH_PEPPER and bound to tenant+user, so a hash from
 * one tenant/user cannot be replayed against another). The challenge returns
 * the authentication timestamp, which the void engine stores in
 * order_voids.override_authenticated_at as the proof that the live
 * verification happened at that moment — never before, never after.
 *
 * The PIN itself is never stored, never logged and never returned.
 *
 * ── Rate limiting (security patch) ─────────────────────────────────────────
 *
 * Repeated guessing is counted and hard-locked, in ONE transaction per
 * challenge, with row locks always taken in the FIXED order ACTOR → MANAGER
 * (no deadlock):
 *
 *   1. Lock the initiating actor's counter row (upsert + SELECT … FOR UPDATE).
 *      Active actor lock → audited as rejected_locked, refused IMMEDIATELY
 *      (users is not even read), not re-counted, not extended.
 *   2. Lock the target manager's counter row. Active manager lock → same
 *      immediate rejection.
 *   3. No active lock: run the live verification exactly (pin_hash/is_active
 *      + verifyPin). A wrong PIN AND an unknown/inactive manager BOTH count
 *      as failures — probing manager_user_ids must not escape the budget.
 *   4. Append the attempt to manager_override_attempts (permanent ledger).
 *   5. Update the manager counter: failure → +1 (or a fresh window when the
 *      old 15-minute window expired); at 5 → locked_until = now() + 15 min.
 *      Success → reset to zero (manager counter only).
 *   6. Update the actor counter with the same window logic (threshold 10,
 *      30-minute lock). NEVER reset by a success — the threat shape here is
 *      one employee trying MANY managers.
 *   7. If THIS transaction activated the actor lock → append the mandatory
 *      high-severity security event to audit_log (Phase 4):
 *      security.manager_override_actor_locked with tenant_id, actor_id, the
 *      attempt count and the distinct managers tried during the window.
 *
 * A locked challenge throws ManagerOverrideRateLimitedError AFTER the
 * transaction commits (the rejected_locked audit row must survive); a wrong
 * PIN throws ManagerOverrideAuthenticationError the same way. Both errors are
 * raised outside the tenant transaction because withTenantContext rolls back
 * on any throw — the audit/counters commit first, the error surfaces after.
 */
import type { ManagerOverrideAuthenticator } from '../../../domain/contracts/orders.ts';
import { verifyPin } from '../../../shared/auth/pin.ts';
import { ManagerOverrideAuthenticationError, ManagerOverrideRateLimitedError } from '../../../shared/errors.ts';
import type { TenantQuery, WithTenantContext } from '../tenant-context.ts';

export interface PostgresManagerOverrideAuthenticatorDependencies {
  readonly withTenantContext: WithTenantContext;
  /** Decoded PIN_HASH_PEPPER key material (≥ 32 bytes), injected at boot. */
  readonly pepper: Buffer;
}

// ── Non-negotiable constants (fail-closed) ──────────────────────────────────
/** Per-manager: 5 consecutive failures … */
const PER_MANAGER_FAILURE_THRESHOLD = 5;
/** … inside a renewing 15-minute count window … */
const COUNT_WINDOW_MS = 15 * 60_000;
/** … → 15-minute hard lock. */
const MANAGER_LOCK_MS = 15 * 60_000;
/** Per-actor across ALL managers: 10 failures in the window … */
const PER_ACTOR_FAILURE_THRESHOLD = 10;
/** … → 30-minute hard lock + a high-severity security audit event. */
const ACTOR_LOCK_MS = 30 * 60_000;
const SECURITY_EVENT_ACTION = 'security.manager_override_actor_locked';

type AttemptOutcome = 'succeeded' | 'failed_wrong_pin' | 'failed_unknown_or_inactive_manager' | 'rejected_locked';

/** What the single challenge transaction decided; errors are thrown AFTER commit. */
type ChallengeDecision =
  | { readonly kind: 'authenticated'; readonly authenticatedAt: Date }
  | { readonly kind: 'rate_limited'; readonly retryAfterMs: number }
  | { readonly kind: 'failed_authentication' };

interface LockoutStateRow {
  readonly consecutive_failures: number;
  readonly window_started_at: Date | null;
  readonly locked_until: Date | null;
}

export class PostgresManagerOverrideAuthenticator implements ManagerOverrideAuthenticator {
  private readonly dependencies: PostgresManagerOverrideAuthenticatorDependencies;

  constructor(dependencies: PostgresManagerOverrideAuthenticatorDependencies) {
    this.dependencies = dependencies;
  }

  async verifyLiveChallenge(
    tenantId: string,
    managerUserId: string,
    managerOverridePin: string,
    initiatingActorUserId: string,
    orderId?: string,
  ): Promise<Date> {
    const decision = await this.dependencies.withTenantContext(tenantId, async (q) => {
      // ONE clock source for the whole transaction: window_started_at is
      // written as a JS parameter while created_at/locked_until come from the
      // DB now() — using the DB clock here keeps the >= comparisons exact.
      const nowRow = await q.query<{ now: Date }>('SELECT now()');
      const now = must(nowRow.rows[0], 'database clock').now;

      // ── Step 1: the INITIATING ACTOR's counter, locked first (fixed order:
      // actor → manager; upsert-then-lock so a first attempt creates its row).
      await q.query(
        `INSERT INTO manager_override_actor_lockout_state (tenant_id, initiating_actor_user_id, consecutive_failures, window_started_at)
         VALUES ($1, $2, 0, NULL) ON CONFLICT DO NOTHING`,
        [tenantId, initiatingActorUserId],
      );
      const actorState = await lockStateRow(
        q,
        'manager_override_actor_lockout_state',
        'initiating_actor_user_id',
        tenantId,
        initiatingActorUserId,
      );
      if (isActiveLock(actorState, now)) {
        // Refuse IMMEDIATELY — users is not even read. Audited, but neither
        // re-counted nor extended (a hammering employee cannot keep a lock
        // open forever; the actor lock is what stops the hammering itself).
        await appendAttempt(q, tenantId, managerUserId, initiatingActorUserId, orderId, 'rejected_locked');
        return { kind: 'rate_limited', retryAfterMs: must(actorState.locked_until, 'actor locked_until').getTime() - now.getTime() } satisfies ChallengeDecision;
      }

      // ── Step 2: the TARGET MANAGER's counter, locked second.
      await q.query(
        `INSERT INTO manager_override_lockout_state (tenant_id, manager_user_id, consecutive_failures, window_started_at)
         VALUES ($1, $2, 0, NULL) ON CONFLICT DO NOTHING`,
        [tenantId, managerUserId],
      );
      const managerState = await lockStateRow(q, 'manager_override_lockout_state', 'manager_user_id', tenantId, managerUserId);
      if (isActiveLock(managerState, now)) {
        await appendAttempt(q, tenantId, managerUserId, initiatingActorUserId, orderId, 'rejected_locked');
        return { kind: 'rate_limited', retryAfterMs: must(managerState.locked_until, 'manager locked_until').getTime() - now.getTime() } satisfies ChallengeDecision;
      }

      // ── Step 3: the live verification itself (no active lock).
      const result = await q.query<{ pin_hash: string | null; is_active: boolean }>(
        'SELECT pin_hash, is_active FROM users WHERE tenant_id = $1 AND id = $2',
        [tenantId, managerUserId],
      );
      const user = result.rows[0];
      let outcome: AttemptOutcome;
      if (user === undefined || !user.is_active || user.pin_hash === null) {
        // Manager enumeration probes count EXACTLY like wrong PINs.
        outcome = 'failed_unknown_or_inactive_manager';
      } else if (
        managerOverridePin.trim() === ''
        || !verifyPin(this.dependencies.pepper, tenantId, managerUserId, managerOverridePin, user.pin_hash)
      ) {
        outcome = 'failed_wrong_pin';
      } else {
        outcome = 'succeeded';
      }

      // ── Step 4: permanent audit ledger (committed even when the challenge
      // ultimately fails — that is the point of the ledger).
      await appendAttempt(q, tenantId, managerUserId, initiatingActorUserId, orderId, outcome);

      // ── Step 5: manager counter. Success resets ONLY this counter.
      if (outcome === 'succeeded') {
        await q.query(
          `UPDATE manager_override_lockout_state
              SET consecutive_failures = 0, window_started_at = NULL, locked_until = NULL
            WHERE tenant_id = $1 AND manager_user_id = $2`,
          [tenantId, managerUserId],
        );
      } else {
        const next = advanceWindow(managerState, now);
        // The lock decision is computed in TypeScript and passed as an
        // explicit boolean: reusing a numeric parameter in both an assignment
        // and a parameter-to-parameter comparison makes PostgreSQL's type
        // inference ambiguous ("inconsistent types deduced for parameter").
        const lockActivates = next.failures >= PER_MANAGER_FAILURE_THRESHOLD;
        await q.query(
          `UPDATE manager_override_lockout_state
              SET consecutive_failures = $3,
                  window_started_at = $4,
                  locked_until = CASE WHEN $5 THEN now() + make_interval(secs => $6) ELSE locked_until END
            WHERE tenant_id = $1 AND manager_user_id = $2`,
          [tenantId, managerUserId, next.failures, next.windowStartedAt, lockActivates, MANAGER_LOCK_MS / 1000],
        );
      }

      // ── Step 6: actor counter — same window logic, threshold 10, 30-minute
      // lock, and NEVER reset by a success.
      if (outcome !== 'succeeded') {
        const next = advanceWindow(actorState, now);
        const actorLockActivated = next.failures >= PER_ACTOR_FAILURE_THRESHOLD;
        await q.query(
          `UPDATE manager_override_actor_lockout_state
              SET consecutive_failures = $3,
                  window_started_at = $4,
                  locked_until = CASE WHEN $5 THEN now() + make_interval(secs => $6) ELSE locked_until END
            WHERE tenant_id = $1 AND initiating_actor_user_id = $2`,
          [tenantId, initiatingActorUserId, next.failures, next.windowStartedAt, actorLockActivated, ACTOR_LOCK_MS / 1000],
        );

        // ── Step 7: the lock ACTIVATED in this transaction → the mandatory
        // high-severity security event, in the SAME transaction (Phase 4
        // audit_log; app_login already holds INSERT from roles/004).
        if (actorLockActivated) {
          const tried = await q.query<{ target_manager_user_id: string }>(
            `SELECT DISTINCT target_manager_user_id FROM manager_override_attempts
              WHERE tenant_id = $1 AND initiating_actor_user_id = $2 AND created_at >= $3`,
            [tenantId, initiatingActorUserId, must(next.windowStartedAt, 'actor window start')],
          );
          await q.query(
            `INSERT INTO audit_log (tenant_id, user_id, action, resource, "before", "after", "timestamp")
             VALUES ($1, $2, $3, $4, NULL, $5::jsonb, now())`,
            [
              tenantId,
              initiatingActorUserId,
              SECURITY_EVENT_ACTION,
              'manager_override_challenge',
              JSON.stringify({
                severity: 'high',
                tenant_id: tenantId,
                actor_id: initiatingActorUserId,
                attempt_count: next.failures,
                distinct_managers_tried: tried.rows.map((r) => r.target_manager_user_id).sort(),
                lock_duration_minutes: ACTOR_LOCK_MS / 60_000,
              }),
            ],
          );
        }
      }

      return outcome === 'succeeded'
        ? { kind: 'authenticated', authenticatedAt: now } satisfies ChallengeDecision
        : { kind: 'failed_authentication' } satisfies ChallengeDecision;
    });

    // Errors are thrown AFTER the transaction committed: the attempt ledger
    // row and the counters must survive the failure they record.
    if (decision.kind === 'rate_limited') {
      throw new ManagerOverrideRateLimitedError(Math.max(1, Math.ceil(decision.retryAfterMs / 1000)));
    }
    if (decision.kind === 'failed_authentication') {
      // ONE indistinguishable message for wrong-PIN and unknown-manager: the
      // client must never learn which one it was.
      throw new ManagerOverrideAuthenticationError('Manager override rejected: the live PIN challenge failed');
    }
    return decision.authenticatedAt;
  }
}

/** Locks and returns the (pre-existing, just-upserted) counter row. */
async function lockStateRow(
  q: TenantQuery,
  table: 'manager_override_actor_lockout_state' | 'manager_override_lockout_state',
  idColumn: 'initiating_actor_user_id' | 'manager_user_id',
  tenantId: string,
  userId: string,
): Promise<LockoutStateRow> {
  const result = await q.query<LockoutStateRow>(
    `SELECT consecutive_failures, window_started_at, locked_until FROM ${table}
      WHERE tenant_id = $1 AND ${idColumn} = $2 FOR UPDATE`,
    [tenantId, userId],
  );
  return must(result.rows[0], `${table} row after upsert`);
}

function isActiveLock(state: LockoutStateRow, now: Date): boolean {
  return state.locked_until !== null && state.locked_until.getTime() > now.getTime();
}

/**
 * Renewing-window counter advance: a failure inside the open 15-minute window
 * increments; a failure after the window expired starts a FRESH window at 1
 * (the counter never accumulates forever — test invariant 6).
 */
function advanceWindow(state: LockoutStateRow, now: Date): { failures: number; windowStartedAt: Date } {
  const startedAt = state.window_started_at;
  if (startedAt === null || now.getTime() - startedAt.getTime() >= COUNT_WINDOW_MS) {
    return { failures: 1, windowStartedAt: now };
  }
  return { failures: state.consecutive_failures + 1, windowStartedAt: startedAt };
}

async function appendAttempt(
  q: TenantQuery,
  tenantId: string,
  targetManagerUserId: string,
  initiatingActorUserId: string,
  orderId: string | undefined,
  outcome: AttemptOutcome,
): Promise<void> {
  await q.query(
    `INSERT INTO manager_override_attempts
       (tenant_id, target_manager_user_id, initiating_actor_user_id, order_id, outcome)
     VALUES ($1, $2, $3, $4, $5)`,
    [tenantId, targetManagerUserId, initiatingActorUserId, orderId ?? null, outcome],
  );
}

function must<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) throw new Error(`Expected ${what}`);
  return value;
}
