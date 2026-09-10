/**
 * Permission repository contracts (ports) for the RBAC/ABAC engine.
 *
 * `IPermissionReadRepository` and `IPermissionWriteRepository` are deliberately
 * SPLIT (CQS): the authorization engine only ever reads; role/permission/scope
 * mutations and the TENANT_SUPER_ADMIN protection live on the write side. Each
 * port has an InMemory and a Postgres implementation (see
 * src/infrastructure/db/repositories/). Money travels as BigInt minor units —
 * never number/float — and is converted from/to the canonical string form by
 * the Postgres adapter.
 */

export type ScopeType = 'tenant' | 'branch';

/** A row of the global permissions_registry (no tenant scope). */
export interface PermissionAttributes {
  readonly key: string;
  readonly category: string;
  readonly isSensitive: boolean;
}

/**
 * An active `user_roles` row plus the `roles.role_version` it needs for the
 * `sec_v` derivation. This is exactly the tuple
 * `(roleId, roleVersion, scopeType, scopeId)` the spec mandates.
 */
export interface ActiveUserRole {
  readonly roleId: string;
  readonly roleVersion: number;
  readonly scopeType: ScopeType;
  readonly scopeId: string | null;
}

/** One applicable permission grant (user_roles × role_permissions × registry). */
export interface PermissionGrant {
  readonly roleId: string;
  readonly roleVersion: number;
  readonly scopeType: ScopeType;
  readonly scopeId: string | null;
  readonly maxAmountMinorUnits: bigint | null;
  readonly isSensitive: boolean;
}

/** Result of the Permission-Check stage (cached for non-sensitive keys). */
export interface PermissionCheckOutcome {
  readonly allowed: boolean;
  readonly effectiveMaxAmountMinorUnits: bigint | null;
}

export interface IPermissionReadRepository {
  /** True only when the user exists in the tenant AND users.is_active is true. */
  isUserActive(tenantId: string, userId: string): Promise<boolean>;

  /** users.branch_id (null = the user is not branch-scoped). */
  getUserBranchId(tenantId: string, userId: string): Promise<string | null>;

  /** users.security_version — an input of the sec_v derivation. */
  getSecurityVersion(tenantId: string, userId: string): Promise<number>;

  /**
   * Every active user_roles row (`is_active = true`) for the user, joined to
   * roles.role_version, ordered deterministically by (roleId, scopeId).
   */
  listActiveUserRoles(tenantId: string, userId: string): Promise<readonly ActiveUserRole[]>;

  /** permissions_registry lookup (global). */
  getPermissionAttributes(tenantId: string, permissionKey: string): Promise<PermissionAttributes | null>;

  /**
   * Effective grants for (user, permissionKey) whose scope covers the
   * relevant branch: scope_type='tenant' always applies; scope_type='branch'
   * applies only when scope_id equals `relevantBranch`.
   */
  getApplicableGrants(
    tenantId: string,
    userId: string,
    permissionKey: string,
    relevantBranch: string | null,
  ): Promise<readonly PermissionGrant[]>;

  /** Candidate permission keys whose active role scope covers the branch. */
  getCoveredPermissionKeys(
    tenantId: string,
    userId: string,
    branchId: string,
    candidateKeys: readonly string[],
  ): Promise<readonly string[]>;
}

export interface IPermissionWriteRepository {
  /**
   * The single tenant-creation path: inserts the tenant row AND seeds the
   * TENANT_SUPER_ADMIN system role (is_system = true) in the SAME transaction.
   * Seeding is part of tenant creation, never a static migration.
   */
  createTenantWithSystemRole(tenantId: string, tenantName: string): Promise<void>;

  /** Registers a "resource:action" permission in the global registry. */
  createPermission(tenantId: string, permissionKey: string, category: string, isSensitive: boolean): Promise<void>;

  /** Creates a tenant-scoped role (is_system = false). Returns the role id. */
  createRole(tenantId: string, name: string): Promise<string>;

  /** Grants a permission to a role with an optional financial cap (null = uncapped). */
  assignRolePermission(
    tenantId: string,
    roleId: string,
    permissionKey: string,
    maxAmountMinorUnits: bigint | null,
  ): Promise<void>;

  /**
   * Assigns a role to a user with a scope. scope_type='tenant' ⇒ scope_id must
   * be null; scope_type='branch' ⇒ scope_id is mandatory (validated). Returns
   * the user_roles row id.
   */
  assignUserRole(
    tenantId: string,
    userId: string,
    roleId: string,
    scopeType: ScopeType,
    scopeId: string | null,
  ): Promise<string>;

  /**
   * Removes (DELETE) a user_roles assignment, protected by the
   * TENANT_SUPER_ADMIN lock: within the same transaction it takes
   * `SELECT … FOR UPDATE` on the tenant's active super-admin assignments and
   * refuses when `userRoleId` is the LAST active one.
   */
  removeUserRoleAssignment(tenantId: string, userRoleId: string): Promise<void>;

  /**
   * Deactivates (UPDATE is_active = false) a user_roles assignment, protected
   * by the exact same lock + last-active check as `removeUserRoleAssignment`.
   */
  deactivateUserRoleAssignment(tenantId: string, userRoleId: string): Promise<void>;

  /**
   * Disables a user account (UPDATE users.is_active = false), protected by the
   * SAME lock + last-active check: refuses when this user is the last active
   * holder of TENANT_SUPER_ADMIN. No user disable may pass without this check.
   */
  disableUser(tenantId: string, userId: string): Promise<void>;
}
