/**
 * Live manager-override PIN challenge (Phase 7, spec 2.4 + the security
 * addition).
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
 */
import type { ManagerOverrideAuthenticator } from '../../../domain/contracts/orders.ts';
import { verifyPin } from '../../../shared/auth/pin.ts';
import { ManagerOverrideAuthenticationError } from '../../../shared/errors.ts';
import type { WithTenantContext } from '../tenant-context.ts';

export interface PostgresManagerOverrideAuthenticatorDependencies {
  readonly withTenantContext: WithTenantContext;
  /** Decoded PIN_HASH_PEPPER key material (≥ 32 bytes), injected at boot. */
  readonly pepper: Buffer;
}

export class PostgresManagerOverrideAuthenticator implements ManagerOverrideAuthenticator {
  private readonly dependencies: PostgresManagerOverrideAuthenticatorDependencies;

  constructor(dependencies: PostgresManagerOverrideAuthenticatorDependencies) {
    this.dependencies = dependencies;
  }

  async verifyLiveChallenge(tenantId: string, managerUserId: string, managerOverridePin: string): Promise<Date> {
    if (managerOverridePin.trim() === '') {
      throw new ManagerOverrideAuthenticationError('Manager override rejected: a live PIN challenge is required (an empty PIN is never accepted)');
    }
    // Fresh, tenant-scoped read of the CURRENT credential — a stale session or
    // a previously verified identity can never substitute for the live check.
    return this.dependencies.withTenantContext(tenantId, async (q) => {
      const result = await q.query<{ pin_hash: string | null; is_active: boolean }>(
        'SELECT pin_hash, is_active FROM users WHERE tenant_id = $1 AND id = $2',
        [tenantId, managerUserId],
      );
      const row = result.rows[0];
      if (row === undefined || !row.is_active || row.pin_hash === null) {
        throw new ManagerOverrideAuthenticationError('Manager override rejected: unknown, inactive or PIN-less manager');
      }
      if (!verifyPin(this.dependencies.pepper, tenantId, managerUserId, managerOverridePin, row.pin_hash)) {
        throw new ManagerOverrideAuthenticationError('Manager override rejected: the live PIN challenge failed');
      }
      return new Date();
    });
  }
}
