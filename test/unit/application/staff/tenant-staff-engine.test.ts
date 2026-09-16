import { describe, expect, it } from 'vitest';
import { TenantStaffEngine } from '../../../../src/application/engines/staff/tenant-staff-engine.ts';
import { AuthorizationEngine } from '../../../../src/application/engines/rbac/authorization-engine.ts';
import { InMemoryPermissionReadRepository, InMemoryPermissionStore, InMemoryPermissionWriteRepository } from '../../../../src/infrastructure/db/repositories/in-memory-permission-repository.ts';
import { InMemoryTenantStaffRepository } from '../../../../src/infrastructure/db/repositories/in-memory-tenant-staff-repository.ts';
import { sha256Hex } from '../../../../src/shared/crypto.ts';
const TENANT='tenant', OWNER='owner';
describe('TenantStaffEngine using the real AuthorizationEngine', () => { it('creates staff only after staff:manage is granted', async () => {
  const store=new InMemoryPermissionStore(); const write=new InMemoryPermissionWriteRepository(store); await write.createTenantWithSystemRole(TENANT,'Restaurant');
  store.users.set(OWNER,{id:OWNER,tenantId:TENANT,branchId:null,isActive:true,securityVersion:1}); await write.createPermission(TENANT,'staff:manage','staff',true); const role=await write.createRole(TENANT,'owner'); await write.assignRolePermission(TENANT,role,'staff:manage',null); await write.assignUserRole(TENANT,OWNER,role,'tenant',null);
  const engine=new TenantStaffEngine(new AuthorizationEngine({read:new InMemoryPermissionReadRepository(store),hash:sha256Hex}),new InMemoryTenantStaffRepository(store));
  await engine.createStaffUser({tenantId:TENANT,userId:OWNER},{userId:'staff',email:'staff@example.test'}); expect(store.users.get('staff')?.isActive).toBe(true);
}); });
