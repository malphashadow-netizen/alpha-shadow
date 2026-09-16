import type { AuthorizationEngine } from '../rbac/authorization-engine.ts';
import { ForbiddenError, NotFoundError, ValidationError } from '../../../shared/errors.ts';
import { PLATFORM_TENANT_ID } from '../../../domain/contracts/system-roles.ts';
import type { PlatformAdminRepository, PlatformTenant } from '../../../domain/contracts/platform-admin.ts';
import type { SubscriptionPlansRepository } from '../../../domain/contracts/subscription-plans.ts';
import type { PlatformActor } from './subscription-plans-engine.ts';
const context = { hasResource: false, actorBranchId: null, resourceBranchId: null, isSensitivePermission: true } as const;
export class PlatformAdminEngine {
  constructor(private readonly authorization: AuthorizationEngine, private readonly repository: PlatformAdminRepository, private readonly plans: SubscriptionPlansRepository, private readonly now: () => Date = () => new Date()) {}
  private async authorize(actor: PlatformActor, permissionKey: string): Promise<void> {
    await this.authorization.check({ tenantId: PLATFORM_TENANT_ID, userId: actor.userId, permissionKey, context, ...(actor.tokenSecV === undefined ? {} : { tokenSecV: actor.tokenSecV }) });
  }
  private rejectPlatform(tenantId: string): void { if (tenantId === PLATFORM_TENANT_ID) throw new ForbiddenError('platform bootstrap tenant cannot be administered'); }
  async registerTenant(actor: PlatformActor, tenantId: string, name: string): Promise<void> { await this.authorize(actor, 'platform:tenant:create'); if (name.trim() === '') throw new ValidationError('name must be non-empty', 'name'); this.rejectPlatform(tenantId); await this.repository.createTenant(tenantId, name); }
  async suspendTenant(actor: PlatformActor, tenantId: string): Promise<void> { await this.authorize(actor, 'platform:tenant:suspend'); this.rejectPlatform(tenantId); await this.repository.setTenantStatus(tenantId, 'suspended'); }
  async reactivateTenant(actor: PlatformActor, tenantId: string): Promise<void> { await this.authorize(actor, 'platform:tenant:reactivate'); this.rejectPlatform(tenantId); await this.repository.setTenantStatus(tenantId, 'active'); }
  async listTenants(actor: PlatformActor): Promise<readonly PlatformTenant[]> { await this.authorize(actor, 'platform:tenant:list'); return this.repository.listTenants(PLATFORM_TENANT_ID); }
  async getTenantDetails(actor: PlatformActor, tenantId: string): Promise<PlatformTenant> { await this.authorize(actor, 'platform:tenant:view'); this.rejectPlatform(tenantId); const tenant = await this.repository.getTenant(tenantId); if (tenant === null) throw new NotFoundError(`tenant ${tenantId} not found`); return tenant; }
  async assignSubscriptionPlan(actor: PlatformActor, tenantId: string, planId: string): Promise<void> { await this.authorize(actor, 'platform:subscription:assign'); this.rejectPlatform(tenantId); const plan = await this.plans.getPlanById(planId); if (!plan?.isActive) throw new NotFoundError(`active subscription plan ${planId} not found`); const startsAt = this.now(); const endsAt = new Date(startsAt.getTime() + plan.durationDays * 86_400_000); await this.repository.assignSubscription(tenantId, plan, startsAt, endsAt); }
}
