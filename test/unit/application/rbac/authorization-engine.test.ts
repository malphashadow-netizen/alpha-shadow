/**
 * AuthorizationEngine unit tests (InMemory adapters, no I/O).
 *
 * Covers:
 *   - ABAC (a): actor in branch A is denied on a resource in branch B despite
 *     holding the permission (acceptance criterion 7a).
 *   - ABAC (b): an amount above max_amount_minor_units is denied despite the
 *     permission (acceptance criterion 7b).
 *   - L1 cache: is_sensitive = true is NEVER read from the cache — grant AND
 *     denial — under any circumstances (acceptance criterion 5), plus a
 *     non-sensitive control proving the cache actually memoises.
 *   - sec_v token verification inside the engine.
 */
import { describe, expect, it } from 'vitest';

import { AuthorizationEngine } from '../../../../src/application/engines/rbac/authorization-engine.ts';
import { L1PermissionCache } from '../../../../src/application/engines/rbac/l1-permission-cache.ts';
import { deriveSecV } from '../../../../src/domain/contracts/sec-v.ts';
import {
  InMemoryPermissionReadRepository,
  InMemoryPermissionStore,
  InMemoryPermissionWriteRepository,
} from '../../../../src/infrastructure/db/repositories/in-memory-permission-repository.ts';
import { sha256Hex } from '../../../../src/shared/crypto.ts';
import { AuthorizationError, ForbiddenError } from '../../../../src/shared/errors.ts';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = 'user-1';
const BRANCH_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BRANCH_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

interface Scenario {
  readonly store: InMemoryPermissionStore;
  readonly read: InMemoryPermissionReadRepository;
  readonly write: InMemoryPermissionWriteRepository;
}

function makeScenario(): Scenario {
  const store = new InMemoryPermissionStore();
  const read = new InMemoryPermissionReadRepository(store);
  const write = new InMemoryPermissionWriteRepository(store);
  return { store, read, write };
}

function seedActiveBranchUser(scenario: Scenario): void {
  scenario.store.users.set(USER, {
    id: USER,
    tenantId: TENANT,
    branchId: BRANCH_A,
    isActive: true,
    securityVersion: 1,
  });
}

/** Seeds a tenant + user + permission + role + grant + assignment. */
async function seedGrant(
  scenario: Scenario,
  permissionKey: string,
  isSensitive: boolean,
  maxAmountMinorUnits: bigint | null,
  scopeType: 'tenant' | 'branch' = 'tenant',
  scopeId: string | null = null,
): Promise<void> {
  await scenario.write.createTenantWithSystemRole(TENANT, 'tenant-a');
  seedActiveBranchUser(scenario);
  await scenario.write.createPermission(TENANT, permissionKey, 'test', isSensitive);
  const roleId = await scenario.write.createRole(TENANT, 'operator');
  await scenario.write.assignRolePermission(TENANT, roleId, permissionKey, maxAmountMinorUnits);
  await scenario.write.assignUserRole(TENANT, USER, roleId, scopeType, scopeId);
}

function makeEngine(scenario: Scenario, cache?: L1PermissionCache): AuthorizationEngine {
  const base = { read: scenario.read, hash: sha256Hex };
  return cache === undefined ? new AuthorizationEngine(base) : new AuthorizationEngine({ ...base, cache });
}

describe('AuthorizationEngine — ABAC stage', () => {
  it('(7a) denies an actor in branch A acting on a resource in branch B despite holding the permission', async () => {
    const scenario = makeScenario();
    await seedGrant(scenario, 'order:void', false, null);
    const engine = makeEngine(scenario);

    await expect(
      engine.check({
        tenantId: TENANT,
        userId: USER,
        permissionKey: 'order:void',
        context: {
          hasResource: true,
          actorBranchId: BRANCH_A,
          resourceBranchId: BRANCH_B,
          isSensitivePermission: false,
        },
      }),
    ).rejects.toThrow(ForbiddenError);
  });

  it('allows the same permission when actor and resource are in the same branch', async () => {
    const scenario = makeScenario();
    await seedGrant(scenario, 'order:void', false, null);
    const engine = makeEngine(scenario);

    await expect(
      engine.check({
        tenantId: TENANT,
        userId: USER,
        permissionKey: 'order:void',
        context: {
          hasResource: true,
          actorBranchId: BRANCH_A,
          resourceBranchId: BRANCH_A,
          isSensitivePermission: false,
        },
      }),
    ).resolves.toMatchObject({ allowed: true });
  });

  it('(7b) denies an amount exceeding max_amount_minor_units despite holding the permission', async () => {
    const scenario = makeScenario();
    await seedGrant(scenario, 'payment:refund', false, 1000n);
    const engine = makeEngine(scenario);

    await expect(
      engine.check({
        tenantId: TENANT,
        userId: USER,
        permissionKey: 'payment:refund',
        context: {
          hasResource: true,
          actorBranchId: BRANCH_A,
          resourceBranchId: BRANCH_A,
          resourceAmountMinorUnits: 1500n,
          isSensitivePermission: false,
        },
      }),
    ).rejects.toThrow(ForbiddenError);
  });

  it('allows an amount within the financial cap', async () => {
    const scenario = makeScenario();
    await seedGrant(scenario, 'payment:refund', false, 1000n);
    const engine = makeEngine(scenario);

    await expect(
      engine.check({
        tenantId: TENANT,
        userId: USER,
        permissionKey: 'payment:refund',
        context: {
          hasResource: true,
          actorBranchId: BRANCH_A,
          resourceBranchId: BRANCH_A,
          resourceAmountMinorUnits: 500n,
          isSensitivePermission: false,
        },
      }),
    ).resolves.toMatchObject({ allowed: true });
  });

  it('applies no cap when the grant is uncapped (null max)', async () => {
    const scenario = makeScenario();
    await seedGrant(scenario, 'order:void', false, null);
    const engine = makeEngine(scenario);

    await expect(
      engine.check({
        tenantId: TENANT,
        userId: USER,
        permissionKey: 'order:void',
        context: {
          hasResource: true,
          actorBranchId: BRANCH_A,
          resourceBranchId: BRANCH_A,
          resourceAmountMinorUnits: 9_000_000_000_000_000n,
          isSensitivePermission: false,
        },
      }),
    ).resolves.toMatchObject({ allowed: true });
  });
});

describe('AuthorizationEngine — L1 cache and the sensitive bypass', () => {
  it('(5) is_sensitive = true is never read from the cache — denial AND grant', async () => {
    const scenario = makeScenario();
    await scenario.write.createTenantWithSystemRole(TENANT, 'tenant-a');
    seedActiveBranchUser(scenario);
    await scenario.write.createPermission(TENANT, 'payment:refund', 'payments', true);
    const roleId = await scenario.write.createRole(TENANT, 'refunder');
    await scenario.write.assignRolePermission(TENANT, roleId, 'payment:refund', null);

    const engine = makeEngine(scenario, new L1PermissionCache());
    const input = {
      tenantId: TENANT,
      userId: USER,
      permissionKey: 'payment:refund',
      context: { hasResource: false, actorBranchId: BRANCH_A, isSensitivePermission: true },
    } as const;

    // 1. No assignment yet → denied (must not be cached).
    await expect(engine.check(input)).rejects.toThrow(ForbiddenError);

    // 2. Grant it → the FRESH read must see the grant (a cached denial would still deny).
    const userRoleId = await scenario.write.assignUserRole(TENANT, USER, roleId, 'tenant', null);
    await expect(engine.check(input)).resolves.toMatchObject({ allowed: true });

    // 3. Revoke it → the FRESH read must see the revocation (a cached grant would still allow).
    await scenario.write.deactivateUserRoleAssignment(TENANT, userRoleId);
    await expect(engine.check(input)).rejects.toThrow(ForbiddenError);
  });

  it('control: non-sensitive permission IS cached (the cache is real)', async () => {
    const scenario = makeScenario();
    await scenario.write.createTenantWithSystemRole(TENANT, 'tenant-a');
    seedActiveBranchUser(scenario);
    await scenario.write.createPermission(TENANT, 'order:void', 'orders', false);
    const roleId = await scenario.write.createRole(TENANT, 'operator');
    await scenario.write.assignRolePermission(TENANT, roleId, 'order:void', null);
    const userRoleId = await scenario.write.assignUserRole(TENANT, USER, roleId, 'tenant', null);

    const engine = makeEngine(scenario, new L1PermissionCache());
    const input = {
      tenantId: TENANT,
      userId: USER,
      permissionKey: 'order:void',
      context: { hasResource: false, actorBranchId: BRANCH_A, isSensitivePermission: false },
    } as const;

    // First check populates the cache.
    await expect(engine.check(input)).resolves.toMatchObject({ allowed: true });
    // Revoke the assignment — the cache must still answer "allowed" within the TTL.
    await scenario.write.deactivateUserRoleAssignment(TENANT, userRoleId);
    await expect(engine.check(input)).resolves.toMatchObject({ allowed: true });
  });

  it('F-D: order:workflow:admin is never served from the L1 cache — grant AND denial stay live', async () => {
    const scenario = makeScenario();
    await scenario.write.createTenantWithSystemRole(TENANT, 'tenant-a');
    seedActiveBranchUser(scenario);
    await scenario.write.createPermission(TENANT, 'order:workflow:admin', 'orders', true);
    const roleId = await scenario.write.createRole(TENANT, 'workflow-admin');
    await scenario.write.assignRolePermission(TENANT, roleId, 'order:workflow:admin', null);

    const engine = makeEngine(scenario, new L1PermissionCache());
    const input = {
      tenantId: TENANT,
      userId: USER,
      permissionKey: 'order:workflow:admin',
      context: { hasResource: false, actorBranchId: BRANCH_A, isSensitivePermission: true },
    } as const;

    // 1. No assignment yet → denied (must not be cached).
    await expect(engine.check(input)).rejects.toThrow(ForbiddenError);

    // 2. Grant it → the FRESH read must see the grant (a cached denial would still deny).
    const userRoleId = await scenario.write.assignUserRole(TENANT, USER, roleId, 'tenant', null);
    await expect(engine.check(input)).resolves.toMatchObject({ allowed: true });

    // 3. Revoke it → the FRESH read must see the revocation (a cached grant would still allow).
    await scenario.write.deactivateUserRoleAssignment(TENANT, userRoleId);
    await expect(engine.check(input)).rejects.toThrow(ForbiddenError);
  });
});

describe('AuthorizationEngine — tenant guard and sec_v token verification', () => {
  it('denies an inactive user at the tenant-guard stage', async () => {
    const scenario = makeScenario();
    await seedGrant(scenario, 'order:void', false, null);
    const engine = makeEngine(scenario);
    const user = scenario.store.users.get(USER);
    if (user === undefined) throw new Error('fixture user missing');
    scenario.store.users.set(USER, { ...user, isActive: false });

    await expect(
      engine.check({
        tenantId: TENANT,
        userId: USER,
        permissionKey: 'order:void',
        context: { hasResource: false, actorBranchId: BRANCH_A, isSensitivePermission: false },
      }),
    ).rejects.toThrow(ForbiddenError);
  });

  it('rejects a stale token whose sec_v does not match the current role set', async () => {
    const scenario = makeScenario();
    await seedGrant(scenario, 'order:void', false, null);
    const engine = makeEngine(scenario);

    const currentRoles = await scenario.read.listActiveUserRoles(TENANT, USER);
    const securityVersion = await scenario.read.getSecurityVersion(TENANT, USER);
    const goodToken = deriveSecV(currentRoles, securityVersion, sha256Hex);
    const staleToken = deriveSecV(
      [{ roleId: 'some-other-role', roleVersion: 1, scopeType: 'tenant', scopeId: null }],
      securityVersion,
      sha256Hex,
    );

    const input = {
      tenantId: TENANT,
      userId: USER,
      permissionKey: 'order:void',
      context: { hasResource: false, actorBranchId: BRANCH_A, isSensitivePermission: false },
    } as const;

    await expect(engine.check({ ...input, tokenSecV: staleToken })).rejects.toThrow(AuthorizationError);
    await expect(engine.check({ ...input, tokenSecV: goodToken })).resolves.toMatchObject({ allowed: true });
  });
});
