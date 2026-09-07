/**
 * Postgres adapters for the authentication ports — Phase 3.
 *
 * Every method runs through the injected `withTenantContext` (the ONLY
 * sanctioned tenant-scoped DB entry point). These classes never import pg and
 * never run a cross-tenant query: lookups are always
 * `WHERE tenant_id = $1 AND …`, so an email that exists in another tenant is
 * simply invisible → null → the same uniform INVALID_CREDENTIALS outcome.
 *
 * Concurrency (acceptance #4 — no lost updates, exactly one lock):
 *   Failed attempts and success resets are ONE atomic UPDATE statement each.
 *   The failed-attempt UPDATE recomputes `locked_until` inside the same
 *   statement (`now() + interval`) when the new counter crosses the limit, so
 *   two concurrent wrong passwords at the threshold both increment (the row
 *   lock serialises them) and the account is locked exactly once.
 *
 * Refresh rotation is ONE transaction: lock the presented token row FOR
 * UPDATE; if it was already revoked → revoke the whole family (replay); if
 * fresh → verify the account is active and unlocked, revoke the old row,
 * insert the replacement row — all atomically under RLS.
 */
import type {
  AuthUserRecord,
  IAuthRepository,
  IRefreshTokenStore,
  RefreshRotation,
  RegisterSuccessResult,
} from '../../domain/contracts/auth.ts';
import type { ActiveUserRole } from '../../domain/contracts/permission-repository.ts';
import type { WithTenantContext } from '../db/tenant-context.ts';

interface AuthUserRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly email: string;
  readonly staff_code: string | null;
  readonly password_hash: string | null;
  readonly pin_hash: string | null;
  readonly is_active: boolean;
  readonly locked_until: Date | null;
}

interface FailureUpdateRow {
  readonly failed_login_attempts: number;
  readonly locked_until: Date | null;
  readonly now_locked: boolean;
}

interface SecVRoleRow {
  readonly role_id: string;
  readonly role_version: number;
  readonly scope_type: ActiveUserRole['scopeType'];
  readonly scope_id: string | null;
}

function mapUser(row: AuthUserRow): AuthUserRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    email: row.email,
    staffCode: row.staff_code,
    passwordHash: row.password_hash,
    pinHash: row.pin_hash,
    isActive: row.is_active,
    lockedUntil: row.locked_until,
  };
}

function mapRoles(rows: readonly SecVRoleRow[]): RegisterSuccessResult['activeRoles'] {
  return rows.map((row) => ({
    roleId: row.role_id,
    roleVersion: row.role_version,
    scopeType: row.scope_type,
    scopeId: row.scope_id,
  }));
}

const USER_COLUMNS = `id, tenant_id, email, staff_code, password_hash, pin_hash, is_active, locked_until`;
const SECV_ROLE_SELECT = `SELECT ur.role_id AS role_id, r.role_version AS role_version, ur.scope_type AS scope_type, ur.scope_id AS scope_id
   FROM user_roles ur
   JOIN roles r ON r.id = ur.role_id
  WHERE ur.tenant_id = $1 AND ur.user_id = $2 AND ur.is_active = true
  ORDER BY ur.role_id, ur.scope_id`;

export interface PostgresAuthRepositoryDeps {
  readonly withTenantContext: WithTenantContext;
}

export class PostgresAuthRepository implements IAuthRepository {
  private readonly withTenantContext: WithTenantContext;

  constructor(deps: PostgresAuthRepositoryDeps) {
    this.withTenantContext = deps.withTenantContext;
  }

  async findByEmail(tenantId: string, email: string): Promise<AuthUserRecord | null> {
    return this.withTenantContext(tenantId, async (q) => {
      const result = await q.query<AuthUserRow>(
        `SELECT ${USER_COLUMNS} FROM users WHERE tenant_id = $1 AND lower(email) = lower($2) LIMIT 1`,
        [tenantId, email],
      );
      const row = result.rows[0];
      return row === undefined ? null : mapUser(row);
    });
  }

  async findByPinIdentifier(tenantId: string, userIdOrStaffCode: string): Promise<AuthUserRecord | null> {
    return this.withTenantContext(tenantId, async (q) => {
      // Explicit identifier only — UUID (user id) OR staff_code. Never a scan.
      const isUuid =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(userIdOrStaffCode);
      const result = await q.query<AuthUserRow>(
        `SELECT ${USER_COLUMNS}
           FROM users
          WHERE tenant_id = $1
            AND (($4::boolean = true AND id = $2::uuid) OR lower(staff_code) = lower($3))
          LIMIT 1`,
        [tenantId, isUuid ? userIdOrStaffCode : '00000000-0000-0000-0000-000000000000', userIdOrStaffCode, isUuid],
      );
      const row = result.rows[0];
      return row === undefined ? null : mapUser(row);
    });
  }

  async registerFailedAttempt(params: {
    tenantId: string;
    userId: string;
    limit: number;
    lockWindowMs: number;
  }): Promise<{ failedLoginAttempts: number; lockedUntil: Date | null; nowLocked: boolean }> {
    const { tenantId, userId, limit, lockWindowMs } = params;
    return this.withTenantContext(tenantId, async (q) => {
      // ONE atomic statement: increment; set locked_until the moment the new
      // count reaches the limit (only if not already locked); report whether
      // THIS statement transitioned the account into the locked state.
      const result = await q.query<FailureUpdateRow & { prev_attempts: number; was_unlocked: boolean }>(
        `UPDATE users
            SET failed_login_attempts = failed_login_attempts + 1,
                locked_until = CASE
                  WHEN failed_login_attempts + 1 >= $3
                       AND (locked_until IS NULL OR locked_until <= now())
                  THEN now() + make_interval(secs => $4 / 1000.0)
                  ELSE locked_until
                END
          WHERE tenant_id = $1 AND id = $2
        RETURNING failed_login_attempts,
                  locked_until,
                  (failed_login_attempts + 1 >= $3
                     AND (locked_until IS NULL OR locked_until <= now())) AS now_locked`,
        [tenantId, userId, limit, lockWindowMs],
      );
      const row = result.rows[0];
      if (row === undefined) {
        return { failedLoginAttempts: 0, lockedUntil: null, nowLocked: false };
      }
      return { failedLoginAttempts: row.failed_login_attempts, lockedUntil: row.locked_until, nowLocked: row.now_locked };
    });
  }

  async registerSuccessfulLogin(tenantId: string, userId: string): Promise<RegisterSuccessResult> {
    return this.withTenantContext(tenantId, async (q) => {
      // Atomic success reset — ONE UPDATE for the counter and lock.
      const reset = await q.query<{ security_version: number }>(
        `UPDATE users
            SET failed_login_attempts = 0,
                locked_until = NULL
          WHERE tenant_id = $1 AND id = $2
        RETURNING security_version`,
        [tenantId, userId],
      );
      const securityVersion = reset.rows[0]?.security_version;
      if (securityVersion === undefined) {
        throw new Error('successful login reset returned no row');
      }
      const roles = await q.query<SecVRoleRow>(SECV_ROLE_SELECT, [tenantId, userId]);
      return { userId, securityVersion, activeRoles: mapRoles(roles.rows) };
    });
  }

  async getActiveSecVInputs(
    tenantId: string,
    userId: string,
  ): Promise<(RegisterSuccessResult & { isActive: boolean }) | null> {
    return this.withTenantContext(tenantId, async (q) => {
      const user = await q.query<{ is_active: boolean; security_version: number }>(
        'SELECT is_active, security_version FROM users WHERE tenant_id = $1 AND id = $2',
        [tenantId, userId],
      );
      const userRow = user.rows[0];
      if (userRow === undefined) {
        return null; // unknown user OR user lives in a different tenant — identical.
      }
      const roles = await q.query<SecVRoleRow>(SECV_ROLE_SELECT, [tenantId, userId]);
      return {
        userId,
        isActive: userRow.is_active,
        securityVersion: userRow.security_version,
        activeRoles: mapRoles(roles.rows),
      };
    });
  }
}

export class PostgresRefreshTokenStore implements IRefreshTokenStore {
  private readonly withTenantContext: WithTenantContext;

  constructor(deps: PostgresAuthRepositoryDeps) {
    this.withTenantContext = deps.withTenantContext;
  }

  async store(params: {
    tenantId: string;
    userId: string;
    tokenHash: string;
    familyId: string;
    expiresAt: Date;
  }): Promise<void> {
    await this.withTenantContext(params.tenantId, async (q) => {
      await q.query(
        `INSERT INTO auth_refresh_tokens (tenant_id, user_id, token_hash, family_id, expires_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [params.tenantId, params.userId, params.tokenHash, params.familyId, params.expiresAt.toISOString()],
      );
    });
  }

  async rotate(params: {
    tenantId: string;
    oldTokenHash: string;
    newTokenHash: string;
    familyId: string;
    newExpiresAt: Date;
    now: Date;
  }): Promise<RefreshRotation> {
    const { tenantId, oldTokenHash, newTokenHash, familyId, newExpiresAt, now } = params;
    return this.withTenantContext(tenantId, async (q) => {
      // (1) Lock the presented token row FOR UPDATE (serialises concurrent
      //     replays/rotations on the same token).
      const found = await q.query<{
        id: string;
        user_id: string;
        tenant_id: string;
        family_id: string;
        revoked_at: Date | null;
      }>(
        `SELECT id, user_id, tenant_id, family_id, revoked_at
           FROM auth_refresh_tokens
          WHERE tenant_id = $1 AND token_hash = $2
         FOR UPDATE`,
        [tenantId, oldTokenHash],
      );
      const row = found.rows[0];
      if (row === undefined) {
        return { status: 'invalid' };
      }

      // (2) Already revoked → REPLAY. Revoke every still-active token of the
      //     SAME family in one UPDATE (the attacker's stolen token AND the
      //     legitimate user's newer chain are both killed).
      if (row.revoked_at !== null) {
        await q.query(
          `UPDATE auth_refresh_tokens
              SET revoked_at = $3
            WHERE tenant_id = $1 AND family_id = $2 AND revoked_at IS NULL`,
          [tenantId, row.family_id, now.toISOString()],
        );
        return { status: 'replayed' };
      }

      // (3) Fresh token. Verify the account is currently active and unlocked
      //     INSIDE this same transaction/lock window.
      const account = await q.query<{ is_active: boolean; locked_until: Date | null }>(
        'SELECT is_active, locked_until FROM users WHERE tenant_id = $1 AND id = $2 FOR SHARE',
        [tenantId, row.user_id],
      );
      const accountRow = account.rows[0];
      if (accountRow === undefined) {
        return { status: 'invalid' };
      }
      const locked = accountRow.locked_until !== null && accountRow.locked_until > now;
      if (!accountRow.is_active || locked) {
        return { status: 'account_blocked' };
      }

      // (4) Rotate: revoke the old row, insert its replacement (same family).
      await q.query(
        `UPDATE auth_refresh_tokens
            SET revoked_at = $3
          WHERE tenant_id = $1 AND id = $2`,
        [tenantId, row.id, now.toISOString()],
      );
      await q.query(
        `INSERT INTO auth_refresh_tokens (tenant_id, user_id, token_hash, family_id, expires_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [tenantId, row.user_id, newTokenHash, familyId, newExpiresAt.toISOString()],
      );
      return { status: 'rotated', userId: row.user_id, tenantId: row.tenant_id };
    });
  }
}
