import { NotFoundError } from '../../../shared/errors.ts';
import type { PlatformAdminRepository, PlatformTenant } from '../../../domain/contracts/platform-admin.ts';
import type { SubscriptionPlan } from '../../../domain/contracts/subscription-plans.ts';
import { TENANT_SUPER_ADMIN_ROLE_NAME } from '../../../domain/contracts/system-roles.ts';
import type { WithTenantContext } from '../tenant-context.ts';
interface Row { id:string; name:string; status:string; subscription_plan_id:string|null; subscription_status: PlatformTenant['subscriptionStatus']; subscription_started_at:Date|null; subscription_ends_at:Date|null; }
const map=(r:Row):PlatformTenant=>({id:r.id,name:r.name,status:r.status,subscriptionPlanId:r.subscription_plan_id,subscriptionStatus:r.subscription_status,subscriptionStartedAt:r.subscription_started_at,subscriptionEndsAt:r.subscription_ends_at});
export class PostgresPlatformAdminRepository implements PlatformAdminRepository {
  constructor(private readonly withTenantContext: WithTenantContext, private readonly platformTenantId: string) {}
  async createTenant(tenantId:string,name:string): Promise<void> { await this.withTenantContext(tenantId, async (q) => { await q.query('INSERT INTO tenants (id, name) VALUES ($1, $2)', [tenantId, name]); await q.query('INSERT INTO roles (tenant_id, name, is_system) VALUES ($1, $2, true)', [tenantId, TENANT_SUPER_ADMIN_ROLE_NAME]); }, { verifyTenantExists:false }); }
  async setTenantStatus(tenantId:string,status:'active'|'suspended'): Promise<void> { await this.withTenantContext(this.platformTenantId, async q=>{ const r=await q.query('UPDATE tenants SET status=$2 WHERE id=$1',[tenantId,status]); if(r.rowCount!==1) throw new NotFoundError(`tenant ${tenantId} not found`); }); }
  async listTenants(excluded:string): Promise<readonly PlatformTenant[]> { return this.withTenantContext(this.platformTenantId, async q=>(await q.query<Row>('SELECT id,name,status,subscription_plan_id,subscription_status,subscription_started_at,subscription_ends_at FROM tenants WHERE id <> $1 ORDER BY created_at,id',[excluded])).rows.map(map)); }
  async getTenant(id:string): Promise<PlatformTenant | null> { return this.withTenantContext(this.platformTenantId, async q=>{const r=await q.query<Row>('SELECT id,name,status,subscription_plan_id,subscription_status,subscription_started_at,subscription_ends_at FROM tenants WHERE id=$1',[id]);return r.rows[0]?map(r.rows[0]):null;}); }
  async assignSubscription(tenantId:string,plan:SubscriptionPlan,startsAt:Date,endsAt:Date): Promise<void> { await this.withTenantContext(this.platformTenantId,async q=>{const r=await q.query('UPDATE tenants SET subscription_plan_id=$2,subscription_status=$3,subscription_started_at=$4,subscription_ends_at=$5 WHERE id=$1',[tenantId,plan.id,plan.isTrial?'trial':'active',startsAt,endsAt]);if(r.rowCount!==1)throw new NotFoundError(`tenant ${tenantId} not found`);}); }
}
