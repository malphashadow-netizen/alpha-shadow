import { ConflictError, NotFoundError } from '../../../shared/errors.ts';
import type { CreateSubscriptionPlanInput, SubscriptionPlan, SubscriptionPlansRepository, UpdateSubscriptionPlanInput } from '../../../domain/contracts/subscription-plans.ts';

export class InMemorySubscriptionPlansRepository implements SubscriptionPlansRepository {
  private readonly plans = new Map<string, SubscriptionPlan>();
  createPlan(input: CreateSubscriptionPlanInput): Promise<SubscriptionPlan> {
    if (this.plans.has(input.id)) throw new ConflictError(`subscription plan ${input.id} already exists`);
    const now = new Date(); const plan: SubscriptionPlan = { id: input.id, name: input.name, priceAmountMinor: input.priceAmountMinor, priceCurrencyCode: input.priceCurrencyCode, durationDays: input.durationDays, isTrial: input.isTrial ?? false, isActive: true, createdAt: now, updatedAt: now };
    this.plans.set(plan.id, plan); return Promise.resolve(plan);
  }
  updatePlan(id: string, input: UpdateSubscriptionPlanInput): Promise<SubscriptionPlan> { const old = this.plans.get(id); if (!old) throw new NotFoundError(`subscription plan ${id} not found`); const plan = { ...old, ...input, updatedAt: new Date() }; this.plans.set(id, plan); return Promise.resolve(plan); }
  deactivatePlan(id: string): Promise<void> { const plan = this.plans.get(id); if (!plan) throw new NotFoundError(`subscription plan ${id} not found`); this.plans.set(id, { ...plan, isActive: false, updatedAt: new Date() }); return Promise.resolve(); }
  listPlans(includeInactive = false): Promise<readonly SubscriptionPlan[]> { return Promise.resolve([...this.plans.values()].filter((p) => includeInactive || p.isActive)); }
  getPlanById(id: string): Promise<SubscriptionPlan | null> { return Promise.resolve(this.plans.get(id) ?? null); }
}
