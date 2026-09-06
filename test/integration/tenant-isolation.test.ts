/**
 * Integration tests for withTenantContext — real PostgreSQL.
 * 8 tests to bring total integration to 11 (3 existing smoke + 8 here).
 */

import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createWithTenantContext } from '../../src/infrastructure/db/tenant-context.ts';
import { testDatabaseUrl } from '../support/database.ts';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const TENANT_C = '33333333-3333-4333-8333-333333333333';

function makePool(): pg.Pool {
  return new pg.Pool({ connectionString: testDatabaseUrl(), max: 5 });
}

describe('integration: withTenantContext tenant isolation (real PostgreSQL)', () => {
  let pool: pg.Pool;
  let appPool: pg.Pool;

  beforeAll(async () => {
    pool = makePool();
    // Ensure migrations are applied and create app role without BYPASSRLS for proper RLS testing
    const client = await pool.connect();
    try {
      await client.query(`
        CREATE EXTENSION IF NOT EXISTS "pgcrypto";
        CREATE TABLE IF NOT EXISTS tenant_probe (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id uuid NOT NULL,
          payload text NOT NULL DEFAULT '',
          created_at timestamptz NOT NULL DEFAULT now()
        );
        ALTER TABLE tenant_probe ENABLE ROW LEVEL SECURITY;
        ALTER TABLE tenant_probe FORCE ROW LEVEL SECURITY;
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='tenant_probe' AND policyname='tenant_isolation') THEN
            CREATE POLICY tenant_isolation ON tenant_probe FOR ALL USING (tenant_id = current_setting('app.current_tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);
          END IF;
        END $$;

        CREATE TABLE IF NOT EXISTS branch_probe (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id uuid NOT NULL,
          name text NOT NULL
        );
        ALTER TABLE branch_probe ENABLE ROW LEVEL SECURITY;
        ALTER TABLE branch_probe FORCE ROW LEVEL SECURITY;
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='branch_probe' AND policyname='tenant_isolation') THEN
            CREATE POLICY tenant_isolation ON branch_probe FOR ALL USING (tenant_id = current_setting('app.current_tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);
          END IF;
        END $$;

        -- Tenant registry (global, not tenant-scoped): withTenantContext's
        -- verifyTenantExists guard reads it (SELECT only for the app role).
        CREATE TABLE IF NOT EXISTS tenants (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          name text NOT NULL,
          status text NOT NULL DEFAULT 'active',
          created_at timestamptz NOT NULL DEFAULT now()
        );

        -- Create a non-superuser role for RLS testing if not exists
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='app_login_test') THEN
            CREATE ROLE app_login_test WITH LOGIN PASSWORD 'app_login_test_pwd' NOBYPASSRLS;
          END IF;
        END $$;
        GRANT ALL ON TABLE tenant_probe TO app_login_test;
        GRANT ALL ON TABLE branch_probe TO app_login_test;
        GRANT SELECT ON TABLE tenants TO app_login_test;
        GRANT USAGE ON SCHEMA public TO app_login_test;
      `);
    } finally {
      client.release();
    }

    // Create a pool for the app role (non-superuser) to properly test RLS
    const url = new URL(testDatabaseUrl());
    url.username = 'app_login_test';
    url.password = 'app_login_test_pwd';
    appPool = new pg.Pool({ connectionString: url.toString(), max: 5 });
    // Verify the role is not bypassing RLS
    const c = await appPool.connect();
    try {
      const r = await c.query<{ bypass: boolean }>("SELECT rolbypassrls AS bypass FROM pg_roles WHERE rolname='app_login_test'");
      expect(r.rows[0]?.bypass).toBe(false);
    } finally {
      c.release();
    }
  });

  afterAll(async () => {
    await appPool?.end();
    await pool.end();
  });

  beforeEach(async () => {
    // TRUNCATE bypasses RLS and cleans all tenants regardless of current_setting
    const client = await pool.connect();
    try {
      await client.query('TRUNCATE tenant_probe, branch_probe CASCADE');
    } finally {
      client.release();
    }
  });

  it('sets app.current_tenant_id inside transaction and can read it', async () => {
    const withTenantContext = createWithTenantContext(appPool);
    await withTenantContext(TENANT_A, async (q) => {
      const r = await q.query<{ v: string }>("SELECT current_setting('app.current_tenant_id')::text AS v");
      expect(r.rows[0]?.v).toBe(TENANT_A);
    });
  });

  it('tenant A can insert and read its own data', async () => {
    const withTenantContext = createWithTenantContext(appPool);
    await withTenantContext(TENANT_A, async (q) => {
      await q.query("INSERT INTO tenant_probe (tenant_id, payload) VALUES ($1, $2)", [TENANT_A, 'hello-a']);
    });
    const rows = await withTenantContext(TENANT_A, async (q) => {
      const r = await q.query<{ payload: string }>("SELECT payload FROM tenant_probe ORDER BY payload");
      return r.rows;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toBe('hello-a');
  });

  it('tenant A cannot see tenant B data (RLS isolation)', async () => {
    const withTenantContext = createWithTenantContext(appPool);
    await withTenantContext(TENANT_A, async (q) => {
      await q.query("INSERT INTO tenant_probe (tenant_id, payload) VALUES ($1, $2)", [TENANT_A, 'a-data']);
    });
    await withTenantContext(TENANT_B, async (q) => {
      await q.query("INSERT INTO tenant_probe (tenant_id, payload) VALUES ($1, $2)", [TENANT_B, 'b-data']);
    });

    const aRows = await withTenantContext(TENANT_A, async (q) => {
      const r = await q.query("SELECT payload FROM tenant_probe");
      return r.rows;
    });
    expect(aRows).toHaveLength(1);
    expect((aRows[0] as { payload: string }).payload).toBe('a-data');

    const bRows = await withTenantContext(TENANT_B, async (q) => {
      const r = await q.query("SELECT payload FROM tenant_probe");
      return r.rows;
    });
    expect(bRows).toHaveLength(1);
    expect((bRows[0] as { payload: string }).payload).toBe('b-data');
  });

  it('transaction rollback does not persist data', async () => {
    const withTenantContext = createWithTenantContext(appPool);
    await expect(
      withTenantContext(TENANT_A, async (q) => {
        await q.query("INSERT INTO tenant_probe (tenant_id, payload) VALUES ($1, $2)", [TENANT_A, 'temp']);
        throw new Error('force rollback');
      }),
    ).rejects.toThrow('force rollback');

    const rows = await withTenantContext(TENANT_A, async (q) => {
      const r = await q.query("SELECT * FROM tenant_probe");
      return r.rows;
    });
    expect(rows).toHaveLength(0);
  });

  it('multiple sequential calls with different tenants do not leak', async () => {
    const withTenantContext = createWithTenantContext(appPool);
    await withTenantContext(TENANT_A, async (q) => {
      await q.query("INSERT INTO tenant_probe (tenant_id, payload) VALUES ($1, $2)", [TENANT_A, 'a1']);
    });
    await withTenantContext(TENANT_B, async (q) => {
      const r = await q.query("SELECT current_setting('app.current_tenant_id')::text AS v");
      expect(r.rows[0]).toEqual(expect.objectContaining({ v: TENANT_B }));
    });
    await withTenantContext(TENANT_C, async (q) => {
      const r = await q.query("SELECT current_setting('app.current_tenant_id')::text AS v");
      expect(r.rows[0]).toEqual(expect.objectContaining({ v: TENANT_C }));
    });
    const aRows = await withTenantContext(TENANT_A, async (q) => (await q.query("SELECT * FROM tenant_probe")).rows);
    expect(aRows).toHaveLength(1);
  });

  it('branch_probe table is also isolated', async () => {
    const withTenantContext = createWithTenantContext(appPool);
    await withTenantContext(TENANT_A, async (q) => {
      await q.query("INSERT INTO branch_probe (tenant_id, name) VALUES ($1, $2)", [TENANT_A, 'branch-a']);
    });
    await withTenantContext(TENANT_B, async (q) => {
      await q.query("INSERT INTO branch_probe (tenant_id, name) VALUES ($1, $2)", [TENANT_B, 'branch-b']);
    });
    const aRows = await withTenantContext(TENANT_A, async (q) => (await q.query("SELECT name FROM branch_probe")).rows);
    expect(aRows).toHaveLength(1);
    expect((aRows[0] as { name: string }).name).toBe('branch-a');
  });

  it('DISCARD ALL after transaction cleans tenant setting', async () => {
    const withTenantContext = createWithTenantContext(appPool);
    await withTenantContext(TENANT_A, async (q) => {
      await q.query("INSERT INTO tenant_probe (tenant_id, payload) VALUES ($1, $2)", [TENANT_A, 'x']);
    });
    // After withTenantContext, the connection should have DISCARD ALL, so a raw client should see no tenant setting
    const raw = await appPool.connect();
    try {
      const r = await raw.query("SELECT current_setting('app.current_tenant_id', true) AS v");
      expect(r.rows[0]?.v ?? '').toBe('');
    } finally {
      raw.release();
    }
  });

  it('rejects invalid tenantId before DB connection (integration)', async () => {
    const withTenantContext = createWithTenantContext(appPool);
    await expect(withTenantContext('invalid-uuid', async () => 1)).rejects.toThrow();
    await expect(withTenantContext('00000000-0000-0000-0000-000000000000', async () => 1)).rejects.toThrow();
  });

  it('verifyTenantExists: registered tenant passes, missing tenant fails before fn runs', async () => {
    const withTenantContextVerified = createWithTenantContext(appPool, { verifyTenantExists: true });
    const owner = await pool.connect();
    try {
      await owner.query('INSERT INTO tenants (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [TENANT_A, 'Tenant A']);
    } finally {
      owner.release();
    }

    await expect(withTenantContextVerified(TENANT_A, async () => 42)).resolves.toBe(42);

    const missing = '44444444-4444-4444-8444-444444444444';
    let callbackRan = false;
    await expect(
      withTenantContextVerified(missing, async () => {
        callbackRan = true;
        return 1;
      }),
    ).rejects.toThrow();
    expect(callbackRan).toBe(false);
  });
});
