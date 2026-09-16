import { NotFoundError } from '../../../shared/errors.ts';
import type { CreateSubscriptionPlanInput, SubscriptionPlan, SubscriptionPlansRepository, UpdateSubscriptionPlanInput } from '../../../domain/contracts/subscription-plans.ts';
import type { TenantQuery, WithTenantContext } from '../tenant-context.ts';
interface Row { id: string; name: string; price_amount_minor: number; price_currency_code: string; duration_days: number; is_trial: boolean; is_active: boolean; created_at: Date; updated_at: Date; }
const map = (r: Row): SubscriptionPlan => ({ id: r.id, name: r.name, priceAmountMinor: r.price_amount_minor, priceCurrencyCode: r.price_currency_code, durationDays: r.duration_days, isTrial: r.is_trial, isActive: r.is_active, createdAt: r.created_at, updatedAt: r.updated_at });
/** Global-table adapter: the supplied platform context is only an audit/isolation boundary. */
export class PostgresSubscriptionPlansRepository implements SubscriptionPlansRepository {
  constructor(private readonly withTenantContext: WithTenantContext, private readonly platformTenantId: string) {}
  private query<T>(work: (q: TenantQuery) => Promise<T>): Promise<T> { return this.withTenantContext(this.platformTenantId, work); }
  async createPlan(i: CreateSubscriptionPlanInput) { return this.query(async q => { const r = await q.query<Row>('INSERT INTO subscription_plans (id,name,price_amount_minor,price_currency_code,duration_days,is_trial) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [i.id,i.name,i.priceAmountMinor,i.priceCurrencyCode,i.durationDays,i.isTrial ?? false]); return map(r.rows[0]!); }); }
  async updatePlan(id: string, i: UpdateSubscriptionPlanInput) { return this.query(async q => { const r = await q.query<Row>('UPDATE subscription_plans SET name=COALESCE($2,name), price_amount_minor=COALESCE($3,price_amount_minor), price_currency_code=COALESCE($4,price_currency_code), duration_days=COALESCE($5,duration_days), is_trial=COALESCE($6,is_trial), updated_at=now() WHERE id=$1 RETURNING *', [id,i.name ?? null,i.priceAmountMinor ?? null,i.priceCurrencyCode ?? null,i.durationDays ?? null,i.isTrial ?? null]); if (!r.rows[0]) throw new NotFoundError(`subscription plan ${id} not found`); return map(r.rows[0]); }); }
  async deactivatePlan(id: string) { await this.query(async q => { const r = await q.query('UPDATE subscription_plans SET is_active=false, updated_at=now() WHERE id=$1', [id]); if (r.rowCount !== 1) throw new NotFoundError(`subscription plan ${id} not found`); }); }
  async listPlans(includeInactive = false) { return this.query(async q => (await q.query<Row>(`SELECT * FROM subscription_plans ${includeInactive ? '' : 'WHERE is_active=true'} ORDER BY name,id`)).rows.map(map)); }
  async getPlanById(id: string) { return this.query(async q => { const r = await q.query<Row>('SELECT * FROM subscription_plans WHERE id=$1', [id]); return r.rows[0] ? map(r.rows[0]) : null; }); }
}
