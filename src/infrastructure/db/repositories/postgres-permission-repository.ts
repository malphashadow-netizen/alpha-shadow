/**
 * Postgres implementations of the permission repository contracts.
 *
 * Every method runs through the injected `withTenantContext` (the only
 * sanctioned DB entry point); these classes NEVER touch pg.Pool directly.
 * int8 / numeric values arrive as canonical strings (pool type parsers) and are
 * converted with `minorUnitsFromDb` / `minorUnitsToDb` — money is BigInt only.
 *
 * The TENANT_SUPER_ADMIN protection is implemented as the spec mandates:
 * `SELECT … FOR UPDATE` on the tenant's active super-admin rows INSIDE the
 * same transaction as the delete/deactivate/disable, refusing when the target
 * is the last active holder. The same lock + check guards BOTH the user_roles
 * mutations and `UPDATE users.is_active = false`.
 */

import { ConflictError, NotFoundError, ValidationError } from '../../../shared/errors.ts';
import { minorUnitsFromDb, minorUnitsToDb } from '../../../shared/money.ts';
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
import type { TenantQuery, WithTenantContext } from '../tenant-context.ts';
import { getCoveredPermissionKeys } from './shared/permission-queries.ts';

interface ActiveUserRoleRow {
  readonly role_id: string;
  readonly role_version: number;
  readonly scope_type: ScopeType;
  readonly scope_id: string | null;
}

interface GrantRow {
  readonly role_id: string;
  readonly role_version: number;
  readonly scope_type: ScopeType;
  readonly scope_id: string | null;
  readonly max_amount_minor_units: string | null;
  readonly is_sensitive: boolean;
}

export interface PostgresPermissionRepositoryDependencies {
  readonly withTenantContext: WithTenantContext;
}

export class PostgresPermissionReadRepository implements IPermissionReadRepository {
  private readonly withTenantContext: WithTenantContext;

  constructor(dependencies: PostgresPermissionRepositoryDependencies) {
    this.withTenantContext = dependencies.withTenantContext;
  }

  async isUserActive(tenantId: string, userId: string): Promise<boolean> {
    return this.withTenantContext(tenantId, async (q) => {
      const result = await q.query<{ is_active: boolean }>(
        'SELECT is_active FROM users WHERE tenant_id = $1 AND id = $2',
        [tenantId, userId],
      );
      return result.rows[0]?.is_active ?? false;
    });
  }

  async getUserBranchId(tenantId: string, userId: string): Promise<string | null> {
    return this.withTenantContext(tenantId, async (q) => {
      const result = await q.query<{ branch_id: string | null }>(
        'SELECT branch_id FROM users WHERE tenant_id = $1 AND id = $2',
        [tenantId, userId],
      );
      return result.rows[0]?.branch_id ?? null;
    });
  }

  async getSecurityVersion(tenantId: string, userId: string): Promise<number> {
    return this.withTenantContext(tenantId, async (q) => {
      const result = await q.query<{ security_version: number }>(
        'SELECT security_version FROM users WHERE tenant_id = $1 AND id = $2',
        [tenantId, userId],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new NotFoundError(`user ${userId} not found in tenant ${tenantId}`);
      }
      return row.security_version;
    });
  }

  async listActiveUserRoles(tenantId: string, userId: string): Promise<readonly ActiveUserRole[]> {
    return this.withTenantContext(tenantId, async (q) => {
      const result = await q.query<ActiveUserRoleRow>(
        `SELECT ur.role_id, r.role_version, ur.scope_type, ur.scope_id
           FROM user_roles ur
           JOIN roles r ON r.id = ur.role_id
          WHERE ur.tenant_id = $1 AND ur.user_id = $2 AND ur.is_active = true
          ORDER BY ur.role_id, ur.scope_id`,
        [tenantId, userId],
      );
      return result.rows.map((row) => ({
        roleId: row.role_id,
        roleVersion: row.role_version,
        scopeType: row.scope_type,
        scopeId: row.scope_id,
      }));
    });
  }

  async getPermissionAttributes(tenantId: string, permissionKey: string): Promise<PermissionAttributes | null> {
    return this.withTenantContext(tenantId, async (q) => {
      const result = await q.query<{ key: string; category: string; is_sensitive: boolean }>(
        'SELECT key, category, is_sensitive FROM permissions_registry WHERE key = $1',
        [permissionKey],
      );
      const row = result.rows[0];
      if (row === undefined) return null;
      return { key: row.key, category: row.category, isSensitive: row.is_sensitive };
    });
  }

  async getApplicableGrants(
    tenantId: string,
    userId: string,
    permissionKey: string,
    relevantBranch: string | null,
  ): Promise<readonly PermissionGrant[]> {
    return this.withTenantContext(tenantId, async (q) => {
      const result = await q.query<GrantRow>(
        `SELECT r.id AS role_id, r.role_version, ur.scope_type, ur.scope_id,
                rp.max_amount_minor_units, pr.is_sensitive
           FROM user_roles ur
           JOIN roles r ON r.id = ur.role_id
           JOIN role_permissions rp ON rp.role_id = r.id AND rp.permission_key = $3
           JOIN permissions_registry pr ON pr.key = rp.permission_key
          WHERE ur.tenant_id = $1 AND ur.user_id = $2 AND ur.is_active = true
            AND (ur.scope_type = 'tenant' OR (ur.scope_type = 'branch' AND ur.scope_id = $4))`,
        [tenantId, userId, permissionKey, relevantBranch],
      );
      return result.rows.map((row) => ({
        roleId: row.role_id,
        roleVersion: row.role_version,
        scopeType: row.scope_type,
        scopeId: row.scope_id,
        maxAmountMinorUnits: row.max_amount_minor_units === null ? null : minorUnitsFromDb(row.max_amount_minor_units),
        isSensitive: row.is_sensitive,
      }));
    });
  }

  async getCoveredPermissionKeys(
    tenantId: string,
    userId: string,
    branchId: string,
    candidateKeys: readonly string[],
  ): Promise<readonly string[]> {
    return this.withTenantContext(tenantId, (q) => getCoveredPermissionKeys(q, tenantId, userId, branchId, candidateKeys));
  }
}

export class PostgresPermissionWriteRepository implements IPermissionWriteRepository {
  private readonly withTenantContext: WithTenantContext;

  constructor(dependencies: PostgresPermissionRepositoryDependencies) {
    this.withTenantContext = dependencies.withTenantContext;
  }

  async createTenantWithSystemRole(tenantId: string, tenantName: string): Promise<void> {
    // The new tenant does not exist yet, so the existence probe is disabled for
    // this one call. The tenant row AND the system role land in ONE transaction.
    await this.withTenantContext(
      tenantId,
      async (q) => {
        await q.query('INSERT INTO tenants (id, name) VALUES ($1, $2)', [tenantId, tenantName]);
        await q.query('INSERT INTO roles (tenant_id, name, is_system) VALUES ($1, $2, true)', [
          tenantId,
          TENANT_SUPER_ADMIN_ROLE_NAME,
        ]);
      },
      { verifyTenantExists: false },
    );
  }

  async createPermission(tenantId: string, permissionKey: string, category: string, isSensitive: boolean): Promise<void> {
    await this.withTenantContext(tenantId, async (q) => {
      await q.query(
        `INSERT INTO permissions_registry (key, category, is_sensitive)
         VALUES ($1, $2, $3)
         ON CONFLICT (key) DO UPDATE SET category = EXCLUDED.category, is_sensitive = EXCLUDED.is_sensitive`,
        [permissionKey, category, isSensitive],
      );
    });
  }

  async createRole(tenantId: string, name: string): Promise<string> {
    return this.withTenantContext(tenantId, async (q) => {
      const result = await q.query<{ id: string }>(
        'INSERT INTO roles (tenant_id, name) VALUES ($1, $2) RETURNING id',
        [tenantId, name],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new Error('INSERT INTO roles returned no row');
      }
      return row.id;
    });
  }

  async assignRolePermission(
    tenantId: string,
    roleId: string,
    permissionKey: string,
    maxAmountMinorUnits: bigint | null,
  ): Promise<void> {
    await this.withTenantContext(tenantId, async (q) => {
      await q.query(
        `INSERT INTO role_permissions (tenant_id, role_id, permission_key, max_amount_minor_units)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (role_id, permission_key)
         DO UPDATE SET max_amount_minor_units = EXCLUDED.max_amount_minor_units`,
        [tenantId, roleId, permissionKey, maxAmountMinorUnits === null ? null : minorUnitsToDb(maxAmountMinorUnits)],
      );
    });
  }

  async assignUserRole(
    tenantId: string,
    userId: string,
    roleId: string,
    scopeType: ScopeType,
    scopeId: string | null,
  ): Promise<string> {
    if (scopeType === 'tenant' && scopeId !== null) {
      throw new ValidationError('scope_id must be null when scope_type is tenant', 'scopeId');
    }
    if (scopeType === 'branch' && scopeId === null) {
      throw new ValidationError('scope_id is required when scope_type is branch', 'scopeId');
    }
    return this.withTenantContext(tenantId, async (q) => {
      const result = await q.query<{ id: string }>(
        `INSERT INTO user_roles (tenant_id, user_id, role_id, scope_type, scope_id)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [tenantId, userId, roleId, scopeType, scopeId],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new Error('INSERT INTO user_roles returned no row');
      }
      return row.id;
    });
  }

  async removeUserRoleAssignment(tenantId: string, userRoleId: string): Promise<void> {
    await this.withTenantContext(tenantId, async (q) => {
      const systemRoleId = await this.systemRoleId(q, tenantId);
      if (systemRoleId === null) {
        await q.query('DELETE FROM user_roles WHERE id = $1', [userRoleId]);
        return;
      }
      // Lock every active super-admin assignment FOR UPDATE (serializes
      // concurrent removals); then refuse if this is the last one.
      const locked = await q.query<{ id: string }>(
        'SELECT id FROM user_roles WHERE tenant_id = $1 AND role_id = $2 AND is_active = true FOR UPDATE',
        [tenantId, systemRoleId],
      );
      const activeIds = locked.rows.map((row) => row.id);
      if (isLastActiveMember(activeIds, userRoleId)) {
        throw new ConflictError('refusing to remove the last active system administrator assignment');
      }
      await q.query('DELETE FROM user_roles WHERE id = $1', [userRoleId]);
    });
  }

  async deactivateUserRoleAssignment(tenantId: string, userRoleId: string): Promise<void> {
    await this.withTenantContext(tenantId, async (q) => {
      const systemRoleId = await this.systemRoleId(q, tenantId);
      if (systemRoleId === null) {
        await q.query('UPDATE user_roles SET is_active = false WHERE id = $1', [userRoleId]);
        return;
      }
      const locked = await q.query<{ id: string }>(
        'SELECT id FROM user_roles WHERE tenant_id = $1 AND role_id = $2 AND is_active = true FOR UPDATE',
        [tenantId, systemRoleId],
      );
      const activeIds = locked.rows.map((row) => row.id);
      if (isLastActiveMember(activeIds, userRoleId)) {
        throw new ConflictError('refusing to deactivate the last active system administrator assignment');
      }
      await q.query('UPDATE user_roles SET is_active = false WHERE id = $1', [userRoleId]);
    });
  }

  async disableUser(tenantId: string, userId: string): Promise<void> {
    await this.withTenantContext(tenantId, async (q) => {
      const systemRoleId = await this.systemRoleId(q, tenantId);
      if (systemRoleId === null) {
        await q.query('UPDATE users SET is_active = false WHERE id = $1', [userId]);
        return;
      }
      // (1) Lock the super-admin ASSIGNMENT rows (serialization point).
      const assignments = await q.query<{ user_id: string }>(
        'SELECT user_id FROM user_roles WHERE tenant_id = $1 AND role_id = $2 AND is_active = true FOR UPDATE',
        [tenantId, systemRoleId],
      );
      const assignedUserIds = assignments.rows.map((row) => row.user_id);
      // (2) Fresh snapshot (a NEW statement): which of those holders still have
      // an ACTIVE account. This must not rely on the (stale) join snapshot.
      let activeHolderIds: string[] = [];
      if (assignedUserIds.length > 0) {
        const activeAccounts = await q.query<{ id: string }>(
          'SELECT id FROM users WHERE tenant_id = $1 AND is_active = true AND id = ANY($2::uuid[])',
          [tenantId, assignedUserIds],
        );
        activeHolderIds = activeAccounts.rows.map((row) => row.id);
      }
      if (isLastActiveMember(activeHolderIds, userId)) {
        throw new ConflictError('refusing to disable the last active system administrator account');
      }
      await q.query('UPDATE users SET is_active = false WHERE id = $1', [userId]);
    });
  }

  private async systemRoleId(q: TenantQuery, tenantId: string): Promise<string | null> {
    const result = await q.query<{ id: string }>(
      'SELECT id FROM roles WHERE tenant_id = $1 AND is_system = true LIMIT 1',
      [tenantId],
    );
    return result.rows[0]?.id ?? null;
  }
}
