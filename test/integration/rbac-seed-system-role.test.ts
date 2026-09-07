/**
 * Integration: the TENANT_SUPER_ADMIN system role is seeded automatically by
 * the tenant-creation path (createTenantWithSystemRole) — is_system = true, in
 * the SAME transaction as the tenant INSERT — never by a static migration.
 */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  PostgresPermissionWriteRepository,
  type PostgresPermissionRepositoryDependencies,
} from '../../src/infrastructure/db/repositories/postgres-permission-repository.ts';
import { createWithTenantContext } from '../../src/infrastructure/db/tenant-context.ts';
import { testDatabaseUrl } from '../support/database.ts';

const NEW_TENANT = '99999999-9999-4999-8999-999999999999';
const OTHER_TENANT = '33333333-3333-4333-8333-333333333333';
const APP_LOGIN_TEST_PASSWORD = 'app_login_test_pwd';

describe('integration: TENANT_SUPER_ADMIN is seeded in the tenant-creation path', () => {
  let ownerPool: pg.Pool;
  let appPool: pg.Pool;

  beforeAll(async () => {
    ownerPool = new pg.Pool({ connectionString: testDatabaseUrl(), max: 3 });

    const owner = await ownerPool.connect();
    try {
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
      await owner.query('GRANT SELECT ON roles TO app_login');
    } finally {
      owner.release();
    }

    const url = new URL(testDatabaseUrl());
    url.username = 'app_login';
    url.password = APP_LOGIN_TEST_PASSWORD;
    appPool = new pg.Pool({ connectionString: url.toString(), max: 3 });
  });

  afterAll(async () => {
    await appPool?.end();
    await ownerPool?.end();
  });

  it('seeds exactly one is_system TENANT_SUPER_ADMIN role together with the tenant', async () => {
    const deps: PostgresPermissionRepositoryDependencies = { withTenantContext: createWithTenantContext(ownerPool) };
    const write = new PostgresPermissionWriteRepository(deps);

    await write.createTenantWithSystemRole(NEW_TENANT, 'seeded-tenant');

    const owner = await ownerPool.connect();
    try {
      const tenant = await owner.query<{ name: string }>('SELECT name FROM tenants WHERE id = $1', [NEW_TENANT]);
      expect(tenant.rows[0]?.name).toBe('seeded-tenant');

      const roles = await owner.query<{ id: string; name: string; is_system: boolean; role_version: number }>(
        'SELECT id, name, is_system, role_version FROM roles WHERE tenant_id = $1',
        [NEW_TENANT],
      );
      expect(roles.rows).toHaveLength(1);
      expect(roles.rows[0]).toMatchObject({
        name: 'TENANT_SUPER_ADMIN',
        is_system: true,
        role_version: 1,
      });
    } finally {
      owner.release();
    }
  });

  it('the seeded system role is tenant-scoped: visible to its own tenant, hidden from others', async () => {
    // The role already exists from the previous test (same DB, serial files).
    const owner = await ownerPool.connect();
    let systemRoleId: string;
    try {
      const r = await owner.query<{ id: string }>(
        'SELECT id FROM roles WHERE tenant_id = $1 AND is_system = true',
        [NEW_TENANT],
      );
      systemRoleId = r.rows[0]?.id ?? '';
    } finally {
      owner.release();
    }
    expect(systemRoleId).not.toBe('');

    const withAppCtx = createWithTenantContext(appPool);
    const own = await withAppCtx(NEW_TENANT, async (q) => {
      const r = await q.query<{ id: string }>('SELECT id FROM roles WHERE id = $1', [systemRoleId]);
      return r.rows;
    });
    expect(own.map((r) => r.id)).toEqual([systemRoleId]);

    const other = await withAppCtx(OTHER_TENANT, async (q) => {
      const r = await q.query<{ id: string }>('SELECT id FROM roles WHERE id = $1', [systemRoleId]);
      return r.rows;
    });
    expect(other).toHaveLength(0);
  });
});
