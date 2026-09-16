export interface SubscriptionPlan {
  readonly id: string;
  readonly name: string;
  readonly priceAmountMinor: number;
  readonly priceCurrencyCode: string;
  readonly durationDays: number;
  readonly isTrial: boolean;
  readonly isActive: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
export interface CreateSubscriptionPlanInput {
  readonly id: string;
  readonly name: string;
  readonly priceAmountMinor: number;
  readonly priceCurrencyCode: string;
  readonly durationDays: number;
  readonly isTrial?: boolean;
}
export interface UpdateSubscriptionPlanInput {
  readonly name?: string;
  readonly priceAmountMinor?: number;
  readonly priceCurrencyCode?: string;
  readonly durationDays?: number;
  readonly isTrial?: boolean;
}
export interface SubscriptionPlansRepository {
  createPlan(input: CreateSubscriptionPlanInput): Promise<SubscriptionPlan>;
  updatePlan(id: string, input: UpdateSubscriptionPlanInput): Promise<SubscriptionPlan>;
  deactivatePlan(id: string): Promise<void>;
  listPlans(includeInactive?: boolean): Promise<readonly SubscriptionPlan[]>;
  getPlanById(id: string): Promise<SubscriptionPlan | null>;
}
