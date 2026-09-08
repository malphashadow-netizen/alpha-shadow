/**
 * B5 — suspended tenant enforcement (LIVE, real PostgreSQL).
 *
 * The tenant-status probe lives in `withTenantContext` (existence + active
 * status in ONE in-transaction query), so every operation flowing through
 * the choke point fails closed for a suspended tenant — while login/refresh
 * fold the suspension into the uniform 401 (tenant status must never be
 * enumerable through authentication). This file wires the PRODUCTION shape
 * (verify-enabled context — unlike the auth harness, which disables the
 * probe) and proves, on a real database:
 *
 * - T1 (login): correct-password login on a suspended tenant fails with the
 *   SAME 401 INVALID_CREDENTIALS as a wrong password — and succeeds again
 *   on reactivation (the 401s were the suspension, not breakage).
 * - T2 (ops): a plain operation through the choke point fails with the
 *   distinct `tenant.suspended` shape (→ HTTP 403 via the central mapping).
 * - T3 (permissions): an authorization check fails closed even with a WARM
 *   L1 grant cache — the uncached Tenant Guard fires first.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { LoginEngine } from '../../src/application/engines/auth/login-engine.ts';
import { AuthorizationEngine } from '../../src/application/engines/rbac/authorization-engine.ts';
import { L1PermissionCache } from '../../src/application/engines/rbac/l1-permission-cache.ts';
import { PostgresAuthAuditSink, createAuditPool, type AuditPool } from '../../src/infrastructure/db/auth-audit.ts';
import { createWithTenantContext, type TenantPool, type WithTenantContext } from '../../src/infrastructure/db/tenant-context.ts';
import { PostgresPermissionReadRepository, PostgresPermissionWriteRepository } from '../../src/infrastructure/db/repositories/postgres-permission-repository.ts';
import { PostgresAuthRepository, PostgresRefreshTokenStore } from '../../src/infrastructure/security/postgres-auth-repository.ts';
import { decodePinPepper } from '../../src/shared/auth/pin.ts';
import { HmacPinHasher, ScryptPasswordHasher } from '../../src/shared/auth/hashers.ts';
import { loadPrivateKey, loadPublicKey } from '../../src/shared/auth/jwt.ts';
import { JwtTokenService } from '../../src/shared/auth/token-service.ts';
import { sha256Hex } from '../../src/shared/crypto.ts';
import { InvalidCredentialsError, TenantSuspendedError } from '../../src/shared/errors.ts';
import { seedUser } from '../support/auth-harness.ts';
import { generatePassword, generatePepper, generateRsaKeypair } from '../support/auth-secrets.ts';
import { testDatabaseUrl } from '../support/database.ts';

// Fast scrypt parameters for the integration suite only (mirrors auth-harness).
const FAST_SCRYPT = { N: 16, r: 8, p: 1 } as const;
const ctx = { ipAddress: '203.0.113.99', userAgent: 'b5-suspended-tenant' };

describe('B5 suspended tenant (live)', () => {
  let pool: pg.Pool;
  let client: pg.Client;
  let auditPool: AuditPool;
  let withVerify: WithTenantContext;
  let login: LoginEngine;
  let passwordHasher: ScryptPasswordHasher;

  beforeAll(async () => {
    const url = testDatabaseUrl();
    pool = new pg.Pool({ connectionString: url, max: 8 });
    client = new pg.Client({ connectionString: url });
    await client.connect();
    auditPool = createAuditPool(url);
    const auditSink = new PostgresAuthAuditSink(auditPool);

    const keys = generateRsaKeypair();
    const tokenService = new JwtTokenService({
      privateKey: loadPrivateKey(keys.privateKeyPem),
      publicKey: loadPublicKey(keys.publicKeyPem),
      algorithm: 'RS256',
      accessTokenTtlSeconds: 900,
      refreshTokenTtlSeconds: 86_400,
    });

    passwordHasher = new ScryptPasswordHasher(FAST_SCRYPT);
    const pinHasher = new HmacPinHasher(decodePinPepper(generatePepper(32)));

    // PRODUCTION-SHAPED context: the tenant probe (existence + status) ON.
    const tenantPool: TenantPool = {
      connect: async () => pool.connect(),
    };
    withVerify = createWithTenantContext(tenantPool, { verifyTenantExists: true });

    const authRepository = new PostgresAuthRepository({ withTenantContext: withVerify });
    const refreshTokenStore = new PostgresRefreshTokenStore({ withTenantContext: withVerify });

    login = new LoginEngine({
      authRepository,
      refreshTokenStore,
      auditSink,
      tokenService,
      passwordHasher,
      pinHasher,
      refreshTtlSeconds: 86_400,
      ipRateLimit: 200,
      accountRateLimit: 200,
    });
  });

  afterAll(async () => {
    await client?.end();
    await pool?.end();
    await auditPool?.end();
  });

  async function suspend(tenantId: string): Promise<void> {
    await client.query("UPDATE tenants SET status = 'suspended' WHERE id = $1", [tenantId]);
  }

  async function reactivate(tenantId: string): Promise<void> {
    await client.query("UPDATE tenants SET status = 'active' WHERE id = $1", [tenantId]);
  }

  it('T1 login on a suspended tenant fails with the uniform 401, and succeeds again on reactivation', async () => {
    const tenantId = randomUUID();
    const password = generatePassword();
    const user = await seedUser(client, { tenantId, password, passwordHasher });

    // Sanity: the active tenant logs in.
    const ok = await login.login({ mode: 'password', tenantId, email: user.email, password }, ctx);
    expect(ok.status).toBe('ok');

    await suspend(tenantId);

    // Correct credentials on a suspended tenant: the SAME 401 as a wrong
    // password — the status never leaks.
    const failure = await login
      .login({ mode: 'password', tenantId, email: user.email, password }, ctx)
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(InvalidCredentialsError);
    expect(failure).toMatchObject({ code: 'INVALID_CREDENTIALS' });
    // Wrong password: identical outcome (uniformity both directions).
    await expect(
      login.login({ mode: 'password', tenantId, email: user.email, password: generatePassword() }, ctx),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);

    // Reactivation restores access — the 401s were the suspension, not breakage.
    await reactivate(tenantId);
    const revived = await login.login({ mode: 'password', tenantId, email: user.email, password }, ctx);
    expect(revived.status).toBe('ok');
  });

  it('T2 operations through the choke point fail with the distinct tenant.suspended shape', async () => {
    const tenantId = randomUUID();
    await seedUser(client, { tenantId, password: generatePassword(), passwordHasher });

    const probe = () => withVerify(tenantId, async (q) => (await q.query<{ one: number }>('SELECT 1 AS one')).rows[0]?.one);
    await expect(probe()).resolves.toBe(1);

    await suspend(tenantId);

    const failure = await probe().then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(TenantSuspendedError);
    expect(failure).toMatchObject({ code: 'tenant.suspended', status: 'suspended' });
  });

  it('T3 permission checks fail closed even with a warm L1 grant cache', async () => {
    const tenantId = randomUUID();
    const user = await seedUser(client, { tenantId, password: generatePassword(), passwordHasher });
    const write = new PostgresPermissionWriteRepository({ withTenantContext: withVerify });
    const read = new PostgresPermissionReadRepository({ withTenantContext: withVerify });
    await write.createPermission(tenantId, 'orders:create', 'orders', false);
    const roleId = await write.createRole(tenantId, 'cashier');
    await write.assignRolePermission(tenantId, roleId, 'orders:create', null);
    await write.assignUserRole(tenantId, user.userId, roleId, 'tenant', null);

    const authorization = new AuthorizationEngine({ read, hash: sha256Hex, cache: new L1PermissionCache() });
    const input = {
      tenantId,
      userId: user.userId,
      permissionKey: 'orders:create',
      context: { hasResource: false, actorBranchId: null, isSensitivePermission: false } as const,
    };
    const allowed = await authorization.check(input);
    expect(allowed.allowed).toBe(true); // warms the L1 grant cache

    await suspend(tenantId);

    // The Tenant Guard (Stage 1, never cached) fires before the warm L1
    // entry is even consulted.
    const failure = await authorization.check(input).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(TenantSuspendedError);
    expect(failure).toMatchObject({ code: 'tenant.suspended' });
  });
});
