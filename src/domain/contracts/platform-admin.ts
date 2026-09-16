import type { SubscriptionPlan } from './subscription-plans.ts';

export type SubscriptionStatus = 'trial' | 'active' | 'suspended' | 'cancelled';
export interface PlatformTenant {
  readonly id: string; readonly name: string; readonly status: string;
  readonly subscriptionPlanId: string | null; readonly subscriptionStatus: SubscriptionStatus;
  readonly subscriptionStartedAt: Date | null; readonly subscriptionEndsAt: Date | null;
}
export interface PlatformAdminRepository {
  createTenant(tenantId: string, name: string): Promise<void>;
  setTenantStatus(tenantId: string, status: 'active' | 'suspended'): Promise<void>;
  listTenants(excludedTenantId: string): Promise<readonly PlatformTenant[]>;
  getTenant(tenantId: string): Promise<PlatformTenant | null>;
  assignSubscription(tenantId: string, plan: SubscriptionPlan, startsAt: Date, endsAt: Date): Promise<void>;
}
