import { describe, expect, it } from 'vitest';
import { PlatformAdminEngine } from '../../../../src/application/engines/platform/platform-admin-engine.ts';
import { SubscriptionPlansEngine } from '../../../../src/application/engines/platform/subscription-plans-engine.ts';
import { AuthorizationEngine } from '../../../../src/application/engines/rbac/authorization-engine.ts';
import { PLATFORM_TENANT_ID } from '../../../../src/domain/contracts/system-roles.ts';
import { InMemoryPermissionReadRepository, InMemoryPermissionStore, InMemoryPermissionWriteRepository } from '../../../../src/infrastructure/db/repositories/in-memory-permission-repository.ts';
import { InMemoryPlatformAdminRepository } from '../../../../src/infrastructure/db/repositories/in-memory-platform-admin-repository.ts';
import { InMemorySubscriptionPlansRepository } from '../../../../src/infrastructure/db/repositories/in-memory-subscription-plans-repository.ts';
import { sha256Hex } from '../../../../src/shared/crypto.ts';
import { ForbiddenError } from '../../../../src/shared/errors.ts';

const OWNER = 'platform-owner';
async function authorization(keys: readonly string[]) {
  const store = new InMemoryPermissionStore(); const write = new InMemoryPermissionWriteRepository(store);
  await write.createTenantWithSystemRole(PLATFORM_TENANT_ID, 'platform');
  store.users.set(OWNER, { id: OWNER, tenantId: PLATFORM_TENANT_ID, branchId: null, isActive: true, securityVersion: 1 });
  const role = await write.createRole(PLATFORM_TENANT_ID, 'operator');
  for (const key of keys) { await write.createPermission(PLATFORM_TENANT_ID, key, 'platform', true); await write.assignRolePermission(PLATFORM_TENANT_ID, role, key, null); }
  await write.assignUserRole(PLATFORM_TENANT_ID, OWNER, role, 'tenant', null);
  return new AuthorizationEngine({ read: new InMemoryPermissionReadRepository(store), hash: sha256Hex });
}
describe('platform engines using the real AuthorizationEngine', () => {
  it('authorizes subscription-plan management through platform:subscription_plan:manage', async () => {
    const plans = new InMemorySubscriptionPlansRepository();
    const engine = new SubscriptionPlansEngine(await authorization(['platform:subscription_plan:manage']), plans);
    await expect(engine.createPlan({ userId: OWNER }, { id: 'plan', name: 'Flexible', priceAmountMinor: 1500, priceCurrencyCode: 'SAR', durationDays: 30 })).resolves.toMatchObject({ name: 'Flexible' });
  });
  it('rejects a tenant super-admin without PLATFORM_OWNER grants when suspending a tenant', async () => {
    const repository = new InMemoryPlatformAdminRepository(); await repository.createTenant('restaurant', 'Restaurant');
    const engine = new PlatformAdminEngine(await authorization([]), repository, new InMemorySubscriptionPlansRepository());
    await expect(engine.suspendTenant({ userId: OWNER }, 'restaurant')).rejects.toThrow(ForbiddenError);
  });
});
