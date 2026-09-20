import { NotFoundError, ValidationError } from '../../../shared/errors.ts';
import type { CreateStaffUserInput, StaffPermissionAssignment, TenantStaffRepository } from '../../../domain/contracts/tenant-staff.ts';
import type { WithTenantContext } from '../tenant-context.ts';
export class PostgresTenantStaffRepository implements TenantStaffRepository {
  constructor(private readonly withTenantContext: WithTenantContext) {}
  async branchBelongsToTenant(tenantId: string, branchId: string): Promise<boolean> {
    return this.withTenantContext(tenantId, async (q) => {
      const result = await q.query(
        'SELECT 1 AS one FROM branches WHERE tenant_id = $1 AND id = $2',
        [tenantId, branchId],
      );
      return result.rows.length > 0;
    });
  }
  async createStaffUser(tenantId:string,input:CreateStaffUserInput):Promise<void> { await this.withTenantContext(tenantId,q=>q.query('INSERT INTO users (id,tenant_id,branch_id,email,staff_code,is_active) VALUES ($1,$2,$3,$4,$5,true)',[input.userId,tenantId,input.branchId ?? null,input.email,input.staffCode ?? null])); }
  async assignPermissions(tenantId:string,userId:string,assignments:readonly StaffPermissionAssignment[]):Promise<void> { await this.withTenantContext(tenantId,async q=>{for(const a of assignments){if(a.scopeType==='tenant'&&a.scopeId!==null)throw new ValidationError('tenant scope must not have scopeId','scopeId');if(a.scopeType==='branch'&&a.scopeId===null)throw new ValidationError('branch scope requires scopeId','scopeId');const r=await q.query('INSERT INTO user_roles (tenant_id,user_id,role_id,scope_type,scope_id) SELECT $1,$2,r.id,$4,$5 FROM roles r WHERE r.id=$3 AND r.tenant_id=$1 ON CONFLICT DO NOTHING',[tenantId,userId,a.roleId,a.scopeType,a.scopeId]);if(r.rowCount===0)throw new NotFoundError(`role ${a.roleId} not found in tenant ${tenantId}`);}}); }
  async deactivateStaffUser(tenantId:string,userId:string):Promise<void> { await this.withTenantContext(tenantId,async q=>{const r=await q.query('UPDATE users SET is_active=false WHERE tenant_id=$1 AND id=$2',[tenantId,userId]);if(r.rowCount!==1)throw new NotFoundError(`user ${userId} not found in tenant ${tenantId}`);}); }
}
