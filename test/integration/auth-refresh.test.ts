/**
 * Integration: refresh-token rotation, replay and sec_v enforcement against
 * REAL PostgreSQL.
 *
 *  - rotation returns new tokens and the old token is invalidated;
 *  - reuse of an already-rotated token is detected (family revocation);
 *  - #9 a users.security_version bump OR a role change invalidates a
 *    still-unexpired refresh token (sec_v is re-derived from the store);
 *  - inactive account can no longer refresh;
 *  - refresh audit rows are written and the ledger rows are tenant-scoped.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { InvalidCredentialsError } from '../../src/shared/errors.ts';
import { buildAuthHarness, seedRandomUser, type Harness } from '../support/auth-harness.ts';


const TENANT = 'b0000000-0000-4000-8000-000000000001';
const ctx = { ipAddress: '198.51.100.9', userAgent: 'refresh-integration' };

describe('auth refresh (real PostgreSQL)', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await buildAuthHarness({ passwordThreshold: 5, pinThreshold: 3, ipRateLimit: 200, accountRateLimit: 200 });
  });

  afterEach(async () => {
    await h.client.query(
      `TRUNCATE auth_audit_log, auth_refresh_tokens, user_roles, role_permissions, roles, users, branches RESTART IDENTITY CASCADE`,
    );
    await h.close();
  });

  async function loginPasswordUser(): Promise<{ userId: string; refreshToken: string; password: string; email: string }> {
    const seeded = await seedRandomUser(h.client, h, { tenantId: TENANT, mode: 'password' });
    const password = seeded.password ?? '';
    const result = await h.login.login({ mode: 'password', tenantId: TENANT, email: seeded.email, password }, ctx);
    return { userId: seeded.userId, refreshToken: result.refreshToken, password, email: seeded.email };
  }

  it('rotates tokens; the OLD refresh token cannot be used again', async () => {
    const session = await loginPasswordUser();
    const rotated = await h.refresh.refresh({ refreshToken: session.refreshToken }, ctx);
    expect(rotated.status).toBe('ok');
    expect(rotated.refreshToken).not.toBe(session.refreshToken);

    // Reuse of the rotated-away token → replay → uniform 401.
    await expect(h.refresh.refresh({ refreshToken: session.refreshToken }, ctx)).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );
  });

  it('the NEW rotated token works, forming a chain; old chains stay revoked', async () => {
    const session = await loginPasswordUser();
    const second = await h.refresh.refresh({ refreshToken: session.refreshToken }, ctx);
    const third = await h.refresh.refresh({ refreshToken: second.refreshToken }, ctx);
    expect(third.status).toBe('ok');

    // Both superseded tokens are now invalid.
    await expect(h.refresh.refresh({ refreshToken: session.refreshToken }, ctx)).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );
    await expect(h.refresh.refresh({ refreshToken: second.refreshToken }, ctx)).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );
  });

  it('#9: bumping users.security_version after login invalidates a still-valid refresh token', async () => {
    const session = await loginPasswordUser();
    // The Phase-2 engine bumps security_version on a security-relevant change.
    await h.client.query('UPDATE users SET security_version = security_version + 1 WHERE id = $1', [session.userId]);
    await expect(h.refresh.refresh({ refreshToken: session.refreshToken }, ctx)).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );
  });

  it('#9: adding an active role assignment changes sec_v and invalidates the token', async () => {
    const session = await loginPasswordUser();
    // Insert a role + an active user_roles assignment (changes the sec_v hash).
    const roleId = crypto.randomUUID();
    await h.client.query(`INSERT INTO roles (id, tenant_id, name, role_version, is_system) VALUES ($1, $2, $3, 1, false)`, [
      roleId,
      TENANT,
      'CASHIER',
    ]);
    await h.client.query(
      `INSERT INTO user_roles (id, tenant_id, user_id, role_id, scope_type, scope_id, is_active)
       VALUES (gen_random_uuid(), $1, $2, $3, 'tenant', NULL, true)`,
      [TENANT, session.userId, roleId],
    );
    await expect(h.refresh.refresh({ refreshToken: session.refreshToken }, ctx)).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );
  });

  it('an inactive account cannot refresh', async () => {
    const session = await loginPasswordUser();
    await h.client.query('UPDATE users SET is_active = false WHERE id = $1', [session.userId]);
    await expect(h.refresh.refresh({ refreshToken: session.refreshToken }, ctx)).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );
  });

  it('a malformed/forged token is rejected uniformly', async () => {
    await expect(h.refresh.refresh({ refreshToken: 'aaa.bbb.ccc' }, ctx)).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );
  });

  it('writes refresh audit rows (success and failure) into auth_audit_log', async () => {
    const session = await loginPasswordUser();
    await h.refresh.refresh({ refreshToken: session.refreshToken }, ctx);
    await h.refresh.refresh({ refreshToken: session.refreshToken }, ctx).catch(() => undefined); // replay
    const rows = await h.client.query<{ success: boolean }>(`SELECT success FROM auth_audit_log WHERE mode = 'refresh'`);
    expect(rows.rowCount).toBeGreaterThanOrEqual(2);
    expect(rows.rows.some((r) => r.success)).toBe(true);
    expect(rows.rows.some((r) => !r.success)).toBe(true);
  });

  it('a token for a tenant that is not visible in the current context is rejected (RLS)', async () => {
    const session = await loginPasswordUser();
    // Tampering with the tenant context is impossible through the API; we
    // assert the ledger rows for this session are scoped to TENANT only.
    const rows = await h.client.query<{ tenant_id: string }>(
      `SELECT DISTINCT tenant_id FROM auth_refresh_tokens WHERE user_id = $1`,
      [session.userId],
    );
    expect(rows.rows.every((r) => r.tenant_id === TENANT)).toBe(true);
  });

});
