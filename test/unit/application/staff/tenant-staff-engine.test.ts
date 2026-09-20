import { describe, expect, it, vi } from 'vitest';
import { TenantStaffEngine } from '../../../../src/application/engines/staff/tenant-staff-engine.ts';
import { AuthorizationEngine } from '../../../../src/application/engines/rbac/authorization-engine.ts';
import {
  InMemoryPermissionReadRepository,
  InMemoryPermissionStore,
  InMemoryPermissionWriteRepository,
} from '../../../../src/infrastructure/db/repositories/in-memory-permission-repository.ts';
import { InMemoryTenantStaffRepository } from '../../../../src/infrastructure/db/repositories/in-memory-tenant-staff-repository.ts';
import { sha256Hex } from '../../../../src/shared/crypto.ts';

const TENANT = 'tenant';
const OTHER_TENANT = 'other-tenant';
const OWNER = 'owner';

async function setup(): Promise<{
  readonly engine: TenantStaffEngine;
  readonly repository: InMemoryTenantStaffRepository;
  readonly store: InMemoryPermissionStore;
}> {
  const store = new InMemoryPermissionStore();
  const write = new InMemoryPermissionWriteRepository(store);
  await write.createTenantWithSystemRole(TENANT, 'Restaurant');
  store.users.set(OWNER, { id: OWNER, tenantId: TENANT, branchId: null, isActive: true, securityVersion: 1 });
  await write.createPermission(TENANT, 'staff:manage', 'staff', true);
  const role = await write.createRole(TENANT, 'owner');
  await write.assignRolePermission(TENANT, role, 'staff:manage', null);
  await write.assignUserRole(TENANT, OWNER, role, 'tenant', null);
  const repository = new InMemoryTenantStaffRepository(store);
  const engine = new TenantStaffEngine(
    new AuthorizationEngine({ read: new InMemoryPermissionReadRepository(store), hash: sha256Hex }),
    repository,
  );
  return { engine, repository, store };
}

describe('TenantStaffEngine using the real AuthorizationEngine', () => {
  it('creates staff only after staff:manage is granted', async () => {
    const { engine, store } = await setup();

    await engine.createStaffUser(
      { tenantId: TENANT, userId: OWNER },
      { userId: 'staff', email: 'staff@example.test' },
    );

    expect(store.users.get('staff')?.isActive).toBe(true);
  });

  it('rejects a caller-supplied branch owned by another tenant before insertion', async () => {
    const { engine, repository, store } = await setup();
    store.branches.set('foreign-branch', {
      id: 'foreign-branch', tenantId: OTHER_TENANT, name: 'Foreign', baseCurrency: 'SAR',
      timezone: 'Asia/Riyadh', countryCode: 'SA',
    });
    const insert = vi.spyOn(repository, 'createStaffUser');

    await expect(engine.createStaffUser(
      { tenantId: TENANT, userId: OWNER },
      { userId: 'staff', email: 'staff@example.test', branchId: 'foreign-branch' },
    )).rejects.toThrow(`branch foreign-branch not found in tenant ${TENANT}`);
    expect(insert).not.toHaveBeenCalled();
  });
});
