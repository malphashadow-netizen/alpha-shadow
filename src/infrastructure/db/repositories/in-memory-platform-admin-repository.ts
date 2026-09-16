import { NotFoundError } from '../../../shared/errors.ts';
import type { PlatformAdminRepository, PlatformTenant } from '../../../domain/contracts/platform-admin.ts';
import type { SubscriptionPlan } from '../../../domain/contracts/subscription-plans.ts';
import type { InMemoryPermissionStore } from './in-memory-permission-repository.ts';

export class InMemoryPlatformAdminRepository implements PlatformAdminRepository {
  private readonly tenants = new Map<string, PlatformTenant>();
  constructor(private readonly permissionStore?: InMemoryPermissionStore) {}
  createTenant(id: string, name: string): Promise<void> { this.tenants.set(id, { id, name, status: 'active', subscriptionPlanId: null, subscriptionStatus: 'active', subscriptionStartedAt: null, subscriptionEndsAt: null }); this.permissionStore?.tenants.set(id, { id, name, status: 'active' }); return Promise.resolve(); }
  async setTenantStatus(id: string, status: 'active' | 'suspended'): Promise<void> { const tenant = this.tenants.get(id); if (!tenant) throw new NotFoundError(`tenant ${id} not found`); this.tenants.set(id, { ...tenant, status }); const permissionTenant=this.permissionStore?.tenants.get(id); if(permissionTenant)this.permissionStore?.tenants.set(id,{...permissionTenant,status}); }
  async listTenants(excludedTenantId: string): Promise<readonly PlatformTenant[]> { return [...this.tenants.values()].filter((tenant) => tenant.id !== excludedTenantId); }
  async getTenant(id: string): Promise<PlatformTenant | null> { return this.tenants.get(id) ?? null; }
  async assignSubscription(id: string, plan: SubscriptionPlan, startsAt: Date, endsAt: Date): Promise<void> { const tenant = this.tenants.get(id); if (!tenant) throw new NotFoundError(`tenant ${id} not found`); this.tenants.set(id, { ...tenant, subscriptionPlanId: plan.id, subscriptionStatus: plan.isTrial ? 'trial' : 'active', subscriptionStartedAt: startsAt, subscriptionEndsAt: endsAt }); }
}
