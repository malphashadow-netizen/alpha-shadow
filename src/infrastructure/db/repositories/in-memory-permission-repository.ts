/* eslint-disable @typescript-eslint/require-await --
 * The InMemory adapters satisfy an ASYNC contract (IPermission*Repository) over
 * synchronous Map lookups. They stay Promise-shaped so callers (the engine,
 * tests) treat both adapters identically; there is nothing to await. */
/**
 * InMemory implementations of the permission repository contracts.
 *
 * They exist for UNIT TESTS ONLY. A runtime guard refuses them under
 * NODE_ENV=production with an explicit ConfigurationError — the composition
 * root must select the Postgres implementations in production.
 *
 * The shared `InMemoryPermissionStore` is the single mutable source of truth;
 * the read and write repositories are SEPARATE classes over the same store
 * (mirroring the split contracts). Tests may also seed users directly through
 * the store's maps (there is deliberately no createUser on the write contract).
 */

import { ConfigurationError, ConflictError, NotFoundError, ValidationError } from '../../../shared/errors.ts';
import type {
  ActiveUserRole,
  IPermissionReadRepository,
  IPermissionWriteRepository,
  PermissionAttributes,
  PermissionGrant,
  ScopeType,
} from '../../../domain/contracts/permission-repository.ts';
import { isLastActiveMember } from '../../../domain/contracts/super-admin-guard.ts';
import { TENANT_SUPER_ADMIN_ROLE_NAME } from '../../../domain/contracts/system-roles.ts';

export interface InMemoryTenantRecord {
  readonly id: string;
  readonly name: string;
}

export interface InMemoryUserRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly branchId: string | null;
  readonly isActive: boolean;
  readonly securityVersion: number;
}

export interface InMemoryRoleRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly roleVersion: number;
  readonly isSystem: boolean;
}

export interface InMemoryPermissionRecord {
  readonly key: string;
  readonly category: string;
  readonly isSensitive: boolean;
}

export interface InMemoryRolePermissionRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly roleId: string;
  readonly permissionKey: string;
  readonly maxAmountMinorUnits: bigint | null;
}

export interface InMemoryUserRoleRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly roleId: string;
  readonly scopeType: ScopeType;
  readonly scopeId: string | null;
  readonly isActive: boolean;
}

function assertInMemoryNotInProduction(): void {
  if (process.env['NODE_ENV'] === 'production') {
    throw new ConfigurationError(
      'InMemory permission repository is forbidden under NODE_ENV=production; use the Postgres implementation.',
      'NODE_ENV',
    );
  }
}

function compareScope(left: string | null, right: string | null): number {
  if (left === right) return 0;
  if (left === null) return -1;
  if (right === null) return 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

/** A branch-scoped grant covers `relevantBranch`; a tenant-scoped grant covers everything. */
function scopeCovers(scopeType: ScopeType, scopeId: string | null, relevantBranch: string | null): boolean {
  if (scopeType === 'tenant') return true;
  return scopeId === relevantBranch;
}

export class InMemoryPermissionStore {
  private idCounter = 0;

  readonly tenants = new Map<string, InMemoryTenantRecord>();
  readonly users = new Map<string, InMemoryUserRecord>();
  readonly roles = new Map<string, InMemoryRoleRecord>();
  readonly permissions = new Map<string, InMemoryPermissionRecord>();
  readonly rolePermissions = new Map<string, InMemoryRolePermissionRecord>();
  readonly userRoles = new Map<string, InMemoryUserRoleRecord>();

  nextId(prefix: string): string {
    this.idCounter += 1;
    return `${prefix}-${this.idCounter}`;
  }
}

export class InMemoryPermissionReadRepository implements IPermissionReadRepository {
  private readonly store: InMemoryPermissionStore;

  constructor(store: InMemoryPermissionStore) {
    assertInMemoryNotInProduction();
    this.store = store;
  }

  async isUserActive(tenantId: string, userId: string): Promise<boolean> {
    const user = this.store.users.get(userId);
    return user?.tenantId === tenantId && user.isActive;
  }

  async getUserBranchId(tenantId: string, userId: string): Promise<string | null> {
    const user = this.store.users.get(userId);
    if (user === undefined) return null;
    if (user.tenantId !== tenantId) return null;
    return user.branchId;
  }

  async getSecurityVersion(tenantId: string, userId: string): Promise<number> {
    const user = this.store.users.get(userId);
    if (user === undefined) {
      throw new NotFoundError(`user ${userId} not found in tenant ${tenantId}`);
    }
    if (user.tenantId !== tenantId) {
      throw new NotFoundError(`user ${userId} not found in tenant ${tenantId}`);
    }
    return user.securityVersion;
  }

  async listActiveUserRoles(tenantId: string, userId: string): Promise<readonly ActiveUserRole[]> {
    const result: ActiveUserRole[] = [];
    for (const userRole of this.store.userRoles.values()) {
      if (userRole.tenantId !== tenantId || userRole.userId !== userId || !userRole.isActive) continue;
      const role = this.store.roles.get(userRole.roleId);
      if (role === undefined) continue;
      result.push({
        roleId: userRole.roleId,
        roleVersion: role.roleVersion,
        scopeType: userRole.scopeType,
        scopeId: userRole.scopeId,
      });
    }
    result.sort((a, b) => {
      if (a.roleId !== b.roleId) return a.roleId < b.roleId ? -1 : 1;
      return compareScope(a.scopeId, b.scopeId);
    });
    return result;
  }

  async getPermissionAttributes(tenantId: string, permissionKey: string): Promise<PermissionAttributes | null> {
    const permission = this.store.permissions.get(permissionKey);
    if (permission === undefined) return null;
    return { key: permission.key, category: permission.category, isSensitive: permission.isSensitive };
  }

  async getApplicableGrants(
    tenantId: string,
    userId: string,
    permissionKey: string,
    relevantBranch: string | null,
  ): Promise<readonly PermissionGrant[]> {
    const grants: PermissionGrant[] = [];
    for (const userRole of this.store.userRoles.values()) {
      if (userRole.tenantId !== tenantId || userRole.userId !== userId || !userRole.isActive) continue;
      if (!scopeCovers(userRole.scopeType, userRole.scopeId, relevantBranch)) continue;
      const role = this.store.roles.get(userRole.roleId);
      if (role === undefined) continue;
      for (const rolePermission of this.store.rolePermissions.values()) {
        if (rolePermission.roleId !== userRole.roleId || rolePermission.permissionKey !== permissionKey) continue;
        const permission = this.store.permissions.get(permissionKey);
        grants.push({
          roleId: userRole.roleId,
          roleVersion: role.roleVersion,
          scopeType: userRole.scopeType,
          scopeId: userRole.scopeId,
          maxAmountMinorUnits: rolePermission.maxAmountMinorUnits,
          isSensitive: permission?.isSensitive ?? false,
        });
      }
    }
    return grants;
  }

  async getCoveredPermissionKeys(
    tenantId: string,
    userId: string,
    branchId: string,
    candidateKeys: readonly string[],
  ): Promise<readonly string[]> {
    const candidateSet = new Set(candidateKeys);
    const covered = new Set<string>();
    const user = this.store.users.get(userId);
    if (user?.tenantId !== tenantId || !user.isActive) return [];
    for (const userRole of this.store.userRoles.values()) {
      if (userRole.tenantId !== tenantId || userRole.userId !== userId || !userRole.isActive) continue;
      if (!scopeCovers(userRole.scopeType, userRole.scopeId, branchId)) continue;
      const role = this.store.roles.get(userRole.roleId);
      if (role?.tenantId !== tenantId) continue;
      for (const rolePermission of this.store.rolePermissions.values()) {
        if (rolePermission.tenantId !== tenantId || rolePermission.roleId !== role.id) continue;
        if (candidateSet.has(rolePermission.permissionKey)) covered.add(rolePermission.permissionKey);
      }
    }
    return candidateKeys.filter((key, index) => covered.has(key) && candidateKeys.indexOf(key) === index);
  }
}

export class InMemoryPermissionWriteRepository implements IPermissionWriteRepository {
  private readonly store: InMemoryPermissionStore;

  constructor(store: InMemoryPermissionStore) {
    assertInMemoryNotInProduction();
    this.store = store;
  }

  async createTenantWithSystemRole(tenantId: string, tenantName: string): Promise<void> {
    this.store.tenants.set(tenantId, { id: tenantId, name: tenantName });
    const roleId = this.store.nextId('role');
    this.store.roles.set(roleId, {
      id: roleId,
      tenantId,
      name: TENANT_SUPER_ADMIN_ROLE_NAME,
      roleVersion: 1,
      isSystem: true,
    });
  }

  async createPermission(tenantId: string, permissionKey: string, category: string, isSensitive: boolean): Promise<void> {
    this.requireTenant(tenantId);
    this.store.permissions.set(permissionKey, { key: permissionKey, category, isSensitive });
  }

  async createRole(tenantId: string, name: string): Promise<string> {
    this.requireTenant(tenantId);
    const id = this.store.nextId('role');
    this.store.roles.set(id, { id, tenantId, name, roleVersion: 1, isSystem: false });
    return id;
  }

  async assignRolePermission(
    tenantId: string,
    roleId: string,
    permissionKey: string,
    maxAmountMinorUnits: bigint | null,
  ): Promise<void> {
    this.requireTenant(tenantId);
    this.requireRole(tenantId, roleId);
    const permission = this.store.permissions.get(permissionKey);
    if (permission === undefined) {
      throw new NotFoundError(`permission ${permissionKey} is not registered`);
    }
    const id = this.store.nextId('role-permission');
    this.store.rolePermissions.set(id, {
      id,
      tenantId,
      roleId,
      permissionKey,
      maxAmountMinorUnits,
    });
  }

  async assignUserRole(
    tenantId: string,
    userId: string,
    roleId: string,
    scopeType: ScopeType,
    scopeId: string | null,
  ): Promise<string> {
    this.requireTenant(tenantId);
    if (scopeType === 'tenant' && scopeId !== null) {
      throw new ValidationError('scope_id must be null when scope_type is tenant', 'scopeId');
    }
    if (scopeType === 'branch' && scopeId === null) {
      throw new ValidationError('scope_id is required when scope_type is branch', 'scopeId');
    }
    this.requireRole(tenantId, roleId);
    const user = this.store.users.get(userId);
    if (user === undefined) {
      throw new NotFoundError(`user ${userId} not found in tenant ${tenantId}`);
    }
    if (user.tenantId !== tenantId) {
      throw new NotFoundError(`user ${userId} not found in tenant ${tenantId}`);
    }
    const id = this.store.nextId('user-role');
    this.store.userRoles.set(id, {
      id,
      tenantId,
      userId,
      roleId,
      scopeType,
      scopeId,
      isActive: true,
    });
    return id;
  }

  async removeUserRoleAssignment(tenantId: string, userRoleId: string): Promise<void> {
    this.requireTenant(tenantId);
    if (isLastActiveMember(this.activeSuperAdminAssignmentIds(tenantId), userRoleId)) {
      throw new ConflictError('refusing to remove the last active system administrator assignment');
    }
    this.store.userRoles.delete(userRoleId);
  }

  async deactivateUserRoleAssignment(tenantId: string, userRoleId: string): Promise<void> {
    this.requireTenant(tenantId);
    if (isLastActiveMember(this.activeSuperAdminAssignmentIds(tenantId), userRoleId)) {
      throw new ConflictError('refusing to deactivate the last active system administrator assignment');
    }
    const userRole = this.store.userRoles.get(userRoleId);
    if (userRole !== undefined) {
      this.store.userRoles.set(userRoleId, { ...userRole, isActive: false });
    }
  }

  async disableUser(tenantId: string, userId: string): Promise<void> {
    this.requireTenant(tenantId);
    if (isLastActiveMember(this.activeSuperAdminHolderUserIds(tenantId), userId)) {
      throw new ConflictError('refusing to disable the last active system administrator account');
    }
    const user = this.store.users.get(userId);
    if (user !== undefined) {
      this.store.users.set(userId, { ...user, isActive: false });
    }
  }

  private requireTenant(tenantId: string): void {
    if (!this.store.tenants.has(tenantId)) {
      throw new NotFoundError(`tenant ${tenantId} does not exist`);
    }
  }

  private requireRole(tenantId: string, roleId: string): void {
    const role = this.store.roles.get(roleId);
    if (role === undefined) {
      throw new NotFoundError(`role ${roleId} not found in tenant ${tenantId}`);
    }
    if (role.tenantId !== tenantId) {
      throw new NotFoundError(`role ${roleId} not found in tenant ${tenantId}`);
    }
  }

  private activeSuperAdminAssignmentIds(tenantId: string): string[] {
    const ids: string[] = [];
    for (const userRole of this.store.userRoles.values()) {
      if (userRole.tenantId !== tenantId || !userRole.isActive) continue;
      const role = this.store.roles.get(userRole.roleId);
      if (role?.isSystem === true) ids.push(userRole.id);
    }
    return ids;
  }

  private activeSuperAdminHolderUserIds(tenantId: string): string[] {
    const ids: string[] = [];
    for (const userRole of this.store.userRoles.values()) {
      if (userRole.tenantId !== tenantId || !userRole.isActive) continue;
      const role = this.store.roles.get(userRole.roleId);
      if (!(role?.isSystem === true)) continue;
      const user = this.store.users.get(userRole.userId);
      if (user?.isActive === true) ids.push(userRole.userId);
    }
    return ids;
  }
}
