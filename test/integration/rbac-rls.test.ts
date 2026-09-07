/**
 * Integration: tenant isolation on the Phase-2 RBAC tables (roles,
 * role_permissions, user_roles) — enforced by RLS itself, not by
 * withTenantContext() (acceptance criterion 6, same technique as Phase 1).
 *
 * A raw client from a tenant-B connection of the same NOBYPASSRLS app pool must
 * see ZERO tenant-A rows, affect nothing on UPDATE/DELETE, and be REJECTED with
 * a hard error when a write would land a row in another tenant (WITH CHECK).
 * A raw SELECT with NO tenant context fails closed (unrecognized GUC / invalid
 * uuid), never silently returning zero rows.
 */
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createWithTenantContext, type WithTenantContext } from '../../src/infrastructure/db/tenant-context.ts';
import { testDatabaseUrl } from '../support/database.ts';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

const ROLE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001';
const ROLE_B = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000002';
const USER_A = 'cccccccc-cccc-4ccc-8ccc-000000000001';
const USER_B = 'cccccccc-cccc-4ccc-8ccc-000000000002';
const ROLE_PERM_A = 'dddddddd-dddd-4ddd-8ddd-000000000001';
const ROLE_PERM_B = 'dddddddd-dddd-4ddd-8ddd-000000000002';
const USER_ROLE_A = 'eeeeeeee-eeee-4eee-8eee-000000000001';
const USER_ROLE_B = 'eeeeeeee-eeee-4eee-8eee-000000000002';

const APP_LOGIN_TEST_PASSWORD = 'app_login_test_pwd';
const FAIL_CLOSED_MESSAGE = /unrecognized configuration parameter|invalid input syntax for type uuid/;

async function bindTenant(client: pg.PoolClient, tenantId: string): Promise<void> {
  await client.query('BEGIN');
  await client.query('SELECT set_config($1, $2, true)', ['app.current_tenant_id', tenantId]);
}

async function commitAndDiscard(client: pg.PoolClient): Promise<void> {
  await client.query('COMMIT');
  await client.query('DISCARD ALL');
}

describe('integration: RLS isolation on roles/role_permissions/user_roles (real PostgreSQL)', () => {
  let ownerPool: pg.Pool;
  let appPool: pg.Pool;
  let withAppCtx: WithTenantContext;

  beforeAll(async () => {
    ownerPool = new pg.Pool({ connectionString: testDatabaseUrl(), max: 3 });

    const owner = await ownerPool.connect();
    try {
      // The Phase-2 tables must exist (applied from migrations/0004 by the
      // global setup). If they do not, fail loudly.
      const tables = await owner.query<{ relname: string }>(
        "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])",
        [['roles', 'role_permissions', 'user_roles', 'permissions_registry']],
      );
      const found = new Set(tables.rows.map((r) => r.relname));
      for (const table of ['roles', 'role_permissions', 'user_roles', 'permissions_registry']) {
        expect(found.has(table), `migration 0004 must have created public.${table}`).toBe(true);
      }

      // Global registry fixtures (shared, idempotent).
      await owner.query(
        `INSERT INTO permissions_registry (key, category, is_sensitive)
         VALUES ('order:void', 'orders', false), ('inventory:adjust', 'inventory', false)
         ON CONFLICT (key) DO NOTHING`,
      );

      // Provision the non-superuser application role (idempotent), like
      // migrations/roles/001_app_login.sql + 002_app_login_rbac.sql.
      await owner.query(
        `DO $$ BEGIN
           IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_login') THEN
             CREATE ROLE app_login LOGIN PASSWORD '${APP_LOGIN_TEST_PASSWORD}'
               NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
           END IF;
         END $$`,
      );
      await owner.query(
        `ALTER ROLE app_login WITH LOGIN PASSWORD '${APP_LOGIN_TEST_PASSWORD}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
      );
      await owner.query('GRANT USAGE ON SCHEMA public TO app_login');
      await owner.query('GRANT SELECT ON tenants TO app_login');
      await owner.query('GRANT SELECT ON permissions_registry TO app_login');
      await owner.query('GRANT SELECT, INSERT, UPDATE, DELETE ON branches TO app_login');
      await owner.query('GRANT SELECT, INSERT, UPDATE, DELETE ON users TO app_login');
      await owner.query('GRANT SELECT, INSERT, UPDATE, DELETE ON roles TO app_login');
      await owner.query('GRANT SELECT, INSERT, UPDATE, DELETE ON role_permissions TO app_login');
      await owner.query('GRANT SELECT, INSERT, UPDATE, DELETE ON user_roles TO app_login');
    } finally {
      owner.release();
    }

    const url = new URL(testDatabaseUrl());
    url.username = 'app_login';
    url.password = APP_LOGIN_TEST_PASSWORD;
    appPool = new pg.Pool({ connectionString: url.toString(), max: 5 });

    const check = await appPool.connect();
    try {
      const r = await check.query<{ bypass: boolean; super: boolean }>(
        "SELECT rolbypassrls AS bypass, rolsuper AS super FROM pg_roles WHERE rolname = 'app_login'",
      );
      expect(r.rows[0]?.bypass).toBe(false);
      expect(r.rows[0]?.super).toBe(false);
    } finally {
      check.release();
    }

    withAppCtx = createWithTenantContext(appPool);
  });

  afterAll(async () => {
    await appPool?.end();
    await ownerPool?.end();
  });

  beforeEach(async () => {
    const owner = await ownerPool.connect();
    try {
      await owner.query('TRUNCATE user_roles, role_permissions, roles, users');
    } finally {
      owner.release();
    }
  });

  /** Seeds roles/role_permissions/user_roles + one user for a tenant. */
  async function seedTenant(
    tenantId: string,
    userId: string,
    roleId: string,
    rolePermId: string,
    userRoleId: string,
  ): Promise<void> {
    await withAppCtx(tenantId, async (q) => {
      await q.query(
        'INSERT INTO users (id, tenant_id, email, password_hash) VALUES ($1, $2, $3, $4)',
        [userId, tenantId, `rbac-${userId}@example.com`, 'hash-placeholder'],
      );
      await q.query('INSERT INTO roles (id, tenant_id, name) VALUES ($1, $2, $3)', [roleId, tenantId, 'cashier']);
      await q.query(
        'INSERT INTO role_permissions (id, tenant_id, role_id, permission_key) VALUES ($1, $2, $3, $4)',
        [rolePermId, tenantId, roleId, 'order:void'],
      );
      await q.query(
        "INSERT INTO user_roles (id, tenant_id, user_id, role_id, scope_type) VALUES ($1, $2, $3, $4, 'tenant')",
        [userRoleId, tenantId, userId, roleId],
      );
    });
  }

  it('withTenantContext can insert and read its own RBAC rows as the NOBYPASSRLS app role', async () => {
    await seedTenant(TENANT_A, USER_A, ROLE_A, ROLE_PERM_A, USER_ROLE_A);
    await seedTenant(TENANT_B, USER_B, ROLE_B, ROLE_PERM_B, USER_ROLE_B);

    const rows = await withAppCtx(TENANT_A, async (q) => {
      const roles = await q.query<{ id: string }>('SELECT id FROM roles ORDER BY id');
      const rolePerms = await q.query<{ id: string }>('SELECT id FROM role_permissions ORDER BY id');
      const userRoles = await q.query<{ id: string }>('SELECT id FROM user_roles ORDER BY id');
      return { roles: roles.rows, rolePerms: rolePerms.rows, userRoles: userRoles.rows };
    });

    expect(rows.roles.map((r) => r.id)).toEqual([ROLE_A]);
    expect(rows.rolePerms.map((r) => r.id)).toEqual([ROLE_PERM_A]);
    expect(rows.userRoles.map((r) => r.id)).toEqual([USER_ROLE_A]);
  });

  it('raw SELECT from a tenant-B connection returns ZERO tenant-A rows on all three tables', async () => {
    await seedTenant(TENANT_A, USER_A, ROLE_A, ROLE_PERM_A, USER_ROLE_A);

    const raw = await appPool.connect();
    try {
      await bindTenant(raw, TENANT_B);
      const roles = await raw.query('SELECT id FROM roles');
      expect(roles.rowCount).toBe(0);
      const rolePerms = await raw.query('SELECT id FROM role_permissions');
      expect(rolePerms.rowCount).toBe(0);
      const userRoles = await raw.query('SELECT id FROM user_roles');
      expect(userRoles.rowCount).toBe(0);
      await commitAndDiscard(raw);
    } finally {
      raw.release();
    }
  });

  it('raw UPDATE/DELETE of tenant-A rows from a tenant-B connection affects nothing', async () => {
    await seedTenant(TENANT_A, USER_A, ROLE_A, ROLE_PERM_A, USER_ROLE_A);

    const raw = await appPool.connect();
    try {
      await bindTenant(raw, TENANT_B);
      const updRole = await raw.query('UPDATE roles SET name = $1 WHERE id = $2', ['pwned', ROLE_A]);
      expect(updRole.rowCount).toBe(0);
      const delRole = await raw.query('DELETE FROM roles WHERE id = $1', [ROLE_A]);
      expect(delRole.rowCount).toBe(0);
      const updRolePerm = await raw.query('UPDATE role_permissions SET max_amount_minor_units = 1 WHERE id = $1', [
        ROLE_PERM_A,
      ]);
      expect(updRolePerm.rowCount).toBe(0);
      const delUserRole = await raw.query('DELETE FROM user_roles WHERE id = $1', [USER_ROLE_A]);
      expect(delUserRole.rowCount).toBe(0);
      await commitAndDiscard(raw);
    } finally {
      raw.release();
    }

    const intact = await withAppCtx(TENANT_A, async (q) => {
      const roles = await q.query<{ name: string }>('SELECT name FROM roles WHERE id = $1', [ROLE_A]);
      const userRoles = await q.query<{ id: string }>('SELECT id FROM user_roles WHERE id = $1', [USER_ROLE_A]);
      return { roleName: roles.rows[0]?.name, userRoleId: userRoles.rows[0]?.id };
    });
    expect(intact.roleName).toBe('cashier');
    expect(intact.userRoleId).toBe(USER_ROLE_A);
  });

  it('writes that would land a row in another tenant are rejected by the WITH CHECK clause (hard error)', async () => {
    await seedTenant(TENANT_A, USER_A, ROLE_A, ROLE_PERM_A, USER_ROLE_A);
    await seedTenant(TENANT_B, USER_B, ROLE_B, ROLE_PERM_B, USER_ROLE_B);

    const raw = await appPool.connect();
    try {
      // roles: plain cross-tenant INSERT (only tenants FK, which is global).
      await bindTenant(raw, TENANT_B);
      await expect(
        raw.query('INSERT INTO roles (id, tenant_id, name) VALUES ($1, $2, $3)', [
          'aaaaaaaa-aaaa-4aaa-8aaa-000000000009',
          TENANT_A,
          'sneaky-role',
        ]),
      ).rejects.toThrow(/row-level security policy/);
      await raw.query('ROLLBACK');

      // role_permissions: cross-tenant INSERT (FKs resolve under B; only RLS rejects).
      await bindTenant(raw, TENANT_B);
      await expect(
        raw.query(
          'INSERT INTO role_permissions (id, tenant_id, role_id, permission_key) VALUES ($1, $2, $3, $4)',
          ['dddddddd-dddd-4ddd-8ddd-000000000009', TENANT_A, ROLE_B, 'inventory:adjust'],
        ),
      ).rejects.toThrow(/row-level security policy/);
      await raw.query('ROLLBACK');

      // user_roles: cross-tenant INSERT (FKs resolve under B; only RLS rejects).
      await bindTenant(raw, TENANT_B);
      await expect(
        raw.query(
          "INSERT INTO user_roles (id, tenant_id, user_id, role_id, scope_type) VALUES ($1, $2, $3, $4, 'tenant')",
          ['eeeeeeee-eeee-4eee-8eee-000000000009', TENANT_A, USER_B, ROLE_B],
        ),
      ).rejects.toThrow(/row-level security policy/);
      await raw.query('ROLLBACK');

      // UPDATE a tenant-B-visible row INTO tenant A → WITH CHECK violation.
      await bindTenant(raw, TENANT_B);
      await expect(raw.query('UPDATE role_permissions SET tenant_id = $1 WHERE id = $2', [TENANT_A, ROLE_PERM_B])).rejects.toThrow(
        /row-level security policy/,
      );
      await raw.query('ROLLBACK');

      await bindTenant(raw, TENANT_B);
      await expect(raw.query('UPDATE user_roles SET tenant_id = $1 WHERE id = $2', [TENANT_A, USER_ROLE_B])).rejects.toThrow(
        /row-level security policy/,
      );
      await raw.query('ROLLBACK');
      await raw.query('DISCARD ALL');
    } finally {
      raw.release();
    }
  });

  it('a raw query with NO tenant context fails closed on all three tables', async () => {
    await seedTenant(TENANT_A, USER_A, ROLE_A, ROLE_PERM_A, USER_ROLE_A);

    const raw = await appPool.connect();
    try {
      await expect(raw.query('SELECT id FROM roles')).rejects.toThrow(FAIL_CLOSED_MESSAGE);
      await expect(raw.query('SELECT id FROM role_permissions')).rejects.toThrow(FAIL_CLOSED_MESSAGE);
      await expect(raw.query('SELECT id FROM user_roles')).rejects.toThrow(FAIL_CLOSED_MESSAGE);
    } finally {
      raw.release();
    }
  });

  it('the same raw mechanism CAN read tenant-A rows when bound to tenant A (control)', async () => {
    await seedTenant(TENANT_A, USER_A, ROLE_A, ROLE_PERM_A, USER_ROLE_A);

    const raw = await appPool.connect();
    try {
      await bindTenant(raw, TENANT_A);
      const roles = await raw.query<{ id: string }>('SELECT id FROM roles ORDER BY id');
      expect(roles.rows.map((r) => r.id)).toEqual([ROLE_A]);
      const rolePerms = await raw.query<{ id: string }>('SELECT id FROM role_permissions ORDER BY id');
      expect(rolePerms.rows.map((r) => r.id)).toEqual([ROLE_PERM_A]);
      const userRoles = await raw.query<{ id: string }>('SELECT id FROM user_roles ORDER BY id');
      expect(userRoles.rows.map((r) => r.id)).toEqual([USER_ROLE_A]);
      await commitAndDiscard(raw);
    } finally {
      raw.release();
    }
  });
});
