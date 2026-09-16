import type { AuthorizationEngine } from '../rbac/authorization-engine.ts';
import { ValidationError } from '../../../shared/errors.ts';
import { PLATFORM_TENANT_ID } from '../../../domain/contracts/system-roles.ts';
import type { CreateSubscriptionPlanInput, SubscriptionPlansRepository, UpdateSubscriptionPlanInput } from '../../../domain/contracts/subscription-plans.ts';

export interface PlatformActor { readonly userId: string; readonly tokenSecV?: string; }
const context = { hasResource: false, actorBranchId: null, resourceBranchId: null, isSensitivePermission: true } as const;
function validate(input: Partial<CreateSubscriptionPlanInput | UpdateSubscriptionPlanInput>): void {
  if (input.name !== undefined && input.name.trim() === '') throw new ValidationError('name must be non-empty', 'name');
  if (input.priceAmountMinor !== undefined && (!Number.isInteger(input.priceAmountMinor) || input.priceAmountMinor < 0)) throw new ValidationError('priceAmountMinor must be a non-negative integer', 'priceAmountMinor');
  if (input.durationDays !== undefined && (!Number.isInteger(input.durationDays) || input.durationDays <= 0)) throw new ValidationError('durationDays must be a positive integer', 'durationDays');
  if (input.priceCurrencyCode !== undefined && !/^[A-Z]{3}$/.test(input.priceCurrencyCode)) throw new ValidationError('priceCurrencyCode must be an ISO 4217 code', 'priceCurrencyCode');
}
export class SubscriptionPlansEngine {
  constructor(private readonly authorization: AuthorizationEngine, private readonly repository: SubscriptionPlansRepository) {}
  private async authorize(actor: PlatformActor): Promise<void> {
    await this.authorization.check({ tenantId: PLATFORM_TENANT_ID, userId: actor.userId, permissionKey: 'platform:subscription_plan:manage', context, ...(actor.tokenSecV === undefined ? {} : { tokenSecV: actor.tokenSecV }) });
  }
  async createPlan(actor: PlatformActor, input: CreateSubscriptionPlanInput) { await this.authorize(actor); validate(input); return this.repository.createPlan(input); }
  async updatePlan(actor: PlatformActor, id: string, input: UpdateSubscriptionPlanInput) { await this.authorize(actor); validate(input); return this.repository.updatePlan(id, input); }
  async deactivatePlan(actor: PlatformActor, id: string) { await this.authorize(actor); return this.repository.deactivatePlan(id); }
  async listPlans(actor: PlatformActor, includeInactive = false) { await this.authorize(actor); return this.repository.listPlans(includeInactive); }
  async getPlanById(actor: PlatformActor, id: string) { await this.authorize(actor); return this.repository.getPlanById(id); }
}
