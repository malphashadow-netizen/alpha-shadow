/**
 * Integration: TENANT_SUPER_ADMIN protection — real PostgreSQL (criteria 3 & 4).
 *
 * The write repository locks the tenant's active super-admin rows with
 * `SELECT … FOR UPDATE` inside the SAME transaction as the mutation and
 * refuses when the target is the last active holder. Two concurrent requests
 * trying to remove the role from (or disable) the last super-admin pair must
 * resolve to EXACTLY ONE success and one safe rejection.
 */
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  PostgresPermissionWriteRepository,
  type PostgresPermissionRepositoryDependencies,
} from '../../src/infrastructure/db/repositories/postgres-permission-repository.ts';
import { createWithTenantContext } from '../../src/infrastructure/db/tenant-context.ts';
import { ConflictError } from '../../src/shared/errors.ts';
import { testDatabaseUrl } from '../support/database.ts';

const TENANT_A = '11111111-1111-4111-8111-111111111111';

const SYSTEM_ROLE = 'aaaaaaaa-aaaa-4aaa-8aaa-100000000000';
const USER_1 = 'cccccccc-cccc-4ccc-8ccc-100000000001';
const USER_2 = 'cccccccc-cccc-4ccc-8ccc-100000000002';
const USER_ROLE_1 = 'eeeeeeee-eeee-4eee-8eee-100000000001';
const USER_ROLE_2 = 'eeeeeeee-eeee-4eee-8eee-100000000002';

const APP_LOGIN_TEST_PASSWORD = 'app_login_test_pwd';

function isRejected(result: PromiseSettledResult<unknown>): result is PromiseRejectedResult {
  return result.status === 'rejected';
}

describe('integration: TENANT_SUPER_ADMIN protection (real PostgreSQL, concurrent)', () => {
  let ownerPool: pg.Pool;
  let appPool: pg.Pool;
  let write: PostgresPermissionWriteRepository;

  beforeAll(async () => {
    ownerPool = new pg.Pool({ connectionString: testDatabaseUrl(), max: 3 });

    const owner = await ownerPool.connect();
    try {
      // Provision the non-superuser app role + Phase-2 grants (idempotent).
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
      await owner.query('GRANT SELECT, INSERT, UPDATE, DELETE ON roles TO app_login');
      await owner.query('GRANT SELECT, INSERT, UPDATE, DELETE ON role_permissions TO app_login');
      await owner.query('GRANT SELECT, INSERT, UPDATE, DELETE ON user_roles TO app_login');
      await owner.query('GRANT SELECT, UPDATE ON users TO app_login');
    } finally {
      owner.release();
    }

    const url = new URL(testDatabaseUrl());
    url.username = 'app_login';
    url.password = APP_LOGIN_TEST_PASSWORD;
    appPool = new pg.Pool({ connectionString: url.toString(), max: 6 });

    const deps: PostgresPermissionRepositoryDependencies = { withTenantContext: createWithTenantContext(appPool) };
    write = new PostgresPermissionWriteRepository(deps);
  });

  afterAll(async () => {
    await appPool?.end();
    await ownerPool?.end();
  });

  beforeEach(async () => {
    const owner = await ownerPool.connect();
    try {
      await owner.query('TRUNCATE user_roles, role_permissions, roles, users');
      // Seed ONE system role and TWO active super-admin users + assignments.
      await owner.query(
        "INSERT INTO roles (id, tenant_id, name, is_system) VALUES ($1, $2, 'TENANT_SUPER_ADMIN', true)",
        [SYSTEM_ROLE, TENANT_A],
      );
      await owner.query(
        'INSERT INTO users (id, tenant_id, email, password_hash, is_active) VALUES ($1, $2, $3, $4, true)',
        [USER_1, TENANT_A, 'super-1@example.com', 'hash-1'],
      );
      await owner.query(
        'INSERT INTO users (id, tenant_id, email, password_hash, is_active) VALUES ($1, $2, $3, $4, true)',
        [USER_2, TENANT_A, 'super-2@example.com', 'hash-2'],
      );
      await owner.query(
        "INSERT INTO user_roles (id, tenant_id, user_id, role_id, scope_type, is_active) VALUES ($1, $2, $3, $4, 'tenant', true)",
        [USER_ROLE_1, TENANT_A, USER_1, SYSTEM_ROLE],
      );
      await owner.query(
        "INSERT INTO user_roles (id, tenant_id, user_id, role_id, scope_type, is_active) VALUES ($1, $2, $3, $4, 'tenant', true)",
        [USER_ROLE_2, TENANT_A, USER_2, SYSTEM_ROLE],
      );
    } finally {
      owner.release();
    }
  });

  async function activeSuperAdminCount(): Promise<number> {
    const owner = await ownerPool.connect();
    try {
      const r = await owner.query<{ count: string }>(
        'SELECT count(*) AS count FROM user_roles WHERE tenant_id = $1 AND role_id = $2 AND is_active = true',
        [TENANT_A, SYSTEM_ROLE],
      );
      return Number(r.rows[0]?.count ?? '0');
    } finally {
      owner.release();
    }
  }

  it('(3) two concurrent removals of the last super-admin role succeed exactly once', async () => {
    const results = await Promise.allSettled([
      write.removeUserRoleAssignment(TENANT_A, USER_ROLE_1),
      write.removeUserRoleAssignment(TENANT_A, USER_ROLE_2),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter(isRejected);
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(ConflictError);

    // The survivor keeps exactly ONE active super-admin assignment.
    await expect(activeSuperAdminCount()).resolves.toBe(1);
  });

  it('(4) two concurrent disables of the last super-admin accounts succeed exactly once', async () => {
    const results = await Promise.allSettled([write.disableUser(TENANT_A, USER_1), write.disableUser(TENANT_A, USER_2)]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter(isRejected);
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(ConflictError);

    // Exactly one account stays active, and both user_roles rows remain active.
    const owner = await ownerPool.connect();
    try {
      const users = await owner.query<{ id: string; is_active: boolean }>(
        'SELECT id, is_active FROM users WHERE tenant_id = $1 ORDER BY id',
        [TENANT_A],
      );
      const activeUsers = users.rows.filter((u) => u.is_active).map((u) => u.id);
      expect(activeUsers).toHaveLength(1);
      const roles = await owner.query<{ id: string }>(
        'SELECT id FROM user_roles WHERE tenant_id = $1 AND is_active = true ORDER BY id',
        [TENANT_A],
      );
      expect(roles.rows).toHaveLength(2);
    } finally {
      owner.release();
    }
  });

  it('removing the ONLY super-admin assignment is refused (non-concurrent control)', async () => {
    // First removal leaves USER_2 as the single holder.
    await write.removeUserRoleAssignment(TENANT_A, USER_ROLE_1);
    // Removing the last one must now fail.
    await expect(write.removeUserRoleAssignment(TENANT_A, USER_ROLE_2)).rejects.toBeInstanceOf(ConflictError);
    await expect(activeSuperAdminCount()).resolves.toBe(1);
  });

  it('disabling the ONLY active super-admin account is refused (non-concurrent control)', async () => {
    await write.disableUser(TENANT_A, USER_1);
    await expect(write.disableUser(TENANT_A, USER_2)).rejects.toBeInstanceOf(ConflictError);
    const owner = await ownerPool.connect();
    try {
      const users = await owner.query<{ is_active: boolean }>('SELECT is_active FROM users WHERE id = $1', [USER_2]);
      expect(users.rows[0]?.is_active).toBe(true);
    } finally {
      owner.release();
    }
  });

  it('removing a NON-super-admin assignment is never blocked by the guard', async () => {
    const owner = await ownerPool.connect();
    try {
      // A regular (non-system) role assigned to USER_1.
      await owner.query("INSERT INTO roles (id, tenant_id, name, is_system) VALUES ($1, $2, 'cashier', false)", [
        'aaaaaaaa-aaaa-4aaa-8aaa-100000000099',
        TENANT_A,
      ]);
      await owner.query(
        "INSERT INTO user_roles (id, tenant_id, user_id, role_id, scope_type, is_active) VALUES ($1, $2, $3, $4, 'tenant', true)",
        ['eeeeeeee-eeee-4eee-8eee-100000000099', TENANT_A, USER_1, 'aaaaaaaa-aaaa-4aaa-8aaa-100000000099'],
      );
    } finally {
      owner.release();
    }
    await expect(write.removeUserRoleAssignment(TENANT_A, 'eeeeeeee-eeee-4eee-8eee-100000000099')).resolves.toBeUndefined();
    await expect(activeSuperAdminCount()).resolves.toBe(2);
  });
});
