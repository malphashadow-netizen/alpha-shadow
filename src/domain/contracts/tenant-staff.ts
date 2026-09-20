import type { ScopeType } from './permission-repository.ts';
export interface TenantStaffActor { readonly tenantId: string; readonly userId: string; readonly tokenSecV?: string; }
export interface CreateStaffUserInput { readonly userId: string; readonly email: string; readonly branchId?: string | null; readonly staffCode?: string | null; }
export interface StaffPermissionAssignment { readonly roleId: string; readonly scopeType: ScopeType; readonly scopeId: string | null; }
export interface TenantStaffRepository {
  /** True only when the branch is owned by the supplied tenant. */
  branchBelongsToTenant(tenantId: string, branchId: string): Promise<boolean>;
  createStaffUser(tenantId: string, input: CreateStaffUserInput): Promise<void>;
  assignPermissions(tenantId: string, userId: string, assignments: readonly StaffPermissionAssignment[]): Promise<void>;
  deactivateStaffUser(tenantId: string, userId: string): Promise<void>;
}
