/**
 * Integration tests: tenant isolation on the REAL core tables (branches/users,
 * migration 0003) — enforced by RLS itself, not by withTenantContext().
 *
 * This is the ONE dedicated suite that deliberately drives raw pool clients
 * around withTenantContext() — to prove that even a developer who bypasses the
 * sanctioned entry point (or a compromised repository that calls the pool
 * directly) still cannot read or modify another tenant's rows, because the
 * FORCEd `tenant_isolation` policy reads the transaction-scoped
 * `app.current_tenant_id` GUC from PostgreSQL, never from application logic.
 *
 *   1. fixture rows for tenant A (branch + user) are written through
 *      withTenantContext() on a pool connected as the non-superuser,
 *      NOBYPASSRLS application role (mirroring migrations/roles/001_app_login.sql);
 *   2. a raw client from the SAME pool is bound to tenant B and tries plain
 *      SELECT/UPDATE/DELETE on tenant A's rows → 0 rows / rejected by RLS;
 *   3. writes whose target tenant differs from the bound tenant are rejected by
 *      the policy's WITH CHECK clause (hard error, not silent no-op);
 *   4. a raw SELECT with NO tenant context at all fails closed: the policy
 *      expression calls current_setting('app.current_tenant_id') WITHOUT
 *      missing_ok=true, so PostgreSQL aborts the query. On a session that has
 *      never touched the GUC the error is "unrecognized configuration
 *      parameter"; on a reused pooled connection (DISCARD ALL resets a
 *      previously-set custom GUC to its empty default) the error is
 *      `''::uuid` = "invalid input syntax for type uuid". Both abort the
 *      whole statement — zero rows are never silently returned.
 */
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createWithTenantContext, type WithTenantContext } from '../../src/infrastructure/db/tenant-context.ts';
import { testDatabaseUrl } from '../support/database.ts';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const BRANCH_A_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BRANCH_B_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const USER_A_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const USER_B_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const EMAIL_A = 'cashier-a@example.com';
const EMAIL_B = 'cashier-b@example.com';

/** Test-only password for the throw-away cluster (same convention as the existing harness). */
const APP_LOGIN_TEST_PASSWORD = 'app_login_test_pwd';

/** Fail-closed signatures PostgreSQL produces when the tenant GUC is unset/empty. */
const FAIL_CLOSED_MESSAGE = /unrecognized configuration parameter|invalid input syntax for type uuid/;

async function bindTenant(client: pg.PoolClient, tenantId: string): Promise<void> {
  await client.query('BEGIN');
  await client.query('SELECT set_config($1, $2, true)', ['app.current_tenant_id', tenantId]);
}

async function commitAndDiscard(client: pg.PoolClient): Promise<void> {
  await client.query('COMMIT');
  await client.query('DISCARD ALL');
}

describe('integration: tenant isolation on core tables branches/users (real PostgreSQL, raw-pool bypass)', () => {
  let ownerPool: pg.Pool; // superuser/owner — schema setup + TRUNCATE only
  let appPool: pg.Pool; // app_login role: NOBYPASSRLS, so RLS FORCE applies
  let withAppCtx: WithTenantContext;

  beforeAll(async () => {
    ownerPool = new pg.Pool({ connectionString: testDatabaseUrl(), max: 3 });

    const owner = await ownerPool.connect();
    try {
      // The core tables must exist (applied from migrations/0003 by the global
      // setup). If they do not, this suite must fail loudly — RLS on a missing
      // table proves nothing.
      const tables = await owner.query<{ relname: string }>(
        "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])",
        [['branches', 'users']],
      );
      const found = new Set(tables.rows.map((r) => r.relname));
      expect(found.has('branches'), 'migration 0003 must have created public.branches').toBe(true);
      expect(found.has('users'), 'migration 0003 must have created public.users').toBe(true);

      // Provision the non-superuser application role exactly as the manual
      // migrations/roles/001_app_login.sql grants it (that file is deliberately
      // NOT applied by the test harness — it is a one-time DBA script). The
      // test DB needs a working LOGIN variant to exercise RLS meaningfully:
      // superusers bypass RLS even when FORCEd, so only this role proves it.
      await owner.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_login') THEN
            CREATE ROLE app_login LOGIN PASSWORD '${APP_LOGIN_TEST_PASSWORD}'
              NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
          END IF;
        END
        $$;
      `);
      await owner.query(
        `ALTER ROLE app_login WITH LOGIN PASSWORD '${APP_LOGIN_TEST_PASSWORD}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
      );
      await owner.query('GRANT USAGE ON SCHEMA public TO app_login');
      await owner.query('GRANT SELECT ON tenants TO app_login');
      await owner.query('GRANT SELECT, INSERT, UPDATE, DELETE ON branches TO app_login');
      await owner.query('GRANT SELECT, INSERT, UPDATE, DELETE ON users TO app_login');
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
    // TRUNCATE as the owner (superuser) bypasses RLS; rows belong to the two
    // fixture tenants only (users → branches FK handled by listing both).
    // Phase 2 (migration 0004) adds user_roles.user_id → users(id), so
    // user_roles must be listed too or PostgreSQL refuses the TRUNCATE.
    const owner = await ownerPool.connect();
    try {
      await owner.query('TRUNCATE auth_refresh_tokens, user_roles, users, branches CASCADE');
    } finally {
      owner.release();
    }
  });

  /** One branch + one user for tenant A, via the sanctioned withTenantContext(). */
  async function seedTenantA(): Promise<void> {
    await withAppCtx(TENANT_A, async (q) => {
      await q.query(
        'INSERT INTO branches (id, tenant_id, name, base_currency, timezone) VALUES ($1, $2, $3, $4, $5)',
        [BRANCH_A_ID, TENANT_A, 'Riyadh Main', 'SAR', 'Asia/Riyadh'],
      );
      await q.query(
        'INSERT INTO users (id, tenant_id, branch_id, email, password_hash) VALUES ($1, $2, $3, $4, $5)',
        [USER_A_ID, TENANT_A, BRANCH_A_ID, EMAIL_A, 'hash-placeholder-a'],
      );
    });
  }

  /** One branch + one user for tenant B (needed where B must own a visible row). */
  async function seedTenantB(): Promise<void> {
    await withAppCtx(TENANT_B, async (q) => {
      await q.query(
        'INSERT INTO branches (id, tenant_id, name, base_currency, timezone) VALUES ($1, $2, $3, $4, $5)',
        [BRANCH_B_ID, TENANT_B, 'Jeddah Branch', 'SAR', 'Asia/Riyadh'],
      );
      await q.query(
        'INSERT INTO users (id, tenant_id, branch_id, email, password_hash) VALUES ($1, $2, $3, $4, $5)',
        [USER_B_ID, TENANT_B, BRANCH_B_ID, EMAIL_B, 'hash-placeholder-b'],
      );
    });
  }

  it('withTenantContext can insert and read its own core-table rows as the NOBYPASSRLS app role', async () => {
    await seedTenantA();
    await seedTenantB();
    const rows = await withAppCtx(TENANT_A, async (q) => {
      const b = await q.query<{ id: string; name: string }>('SELECT id, name FROM branches ORDER BY name');
      const u = await q.query<{ id: string; email: string }>('SELECT id, email FROM users ORDER BY email');
      return { branches: b.rows, users: u.rows };
    });
    expect(rows.branches).toHaveLength(1);
    expect(rows.branches[0]).toMatchObject({ id: BRANCH_A_ID, name: 'Riyadh Main' });
    expect(rows.users).toHaveLength(1);
    expect(rows.users[0]).toMatchObject({ id: USER_A_ID, email: EMAIL_A });
  });

  it('raw SELECT from a tenant-B connection of the same pool returns ZERO of tenant-A rows (no tenant filter)', async () => {
    // Only tenant A has rows: a plain, unfiltered SELECT bound to tenant B must
    // come back empty — RLS hides every row whose tenant_id is not the bound
    // tenant, without any WHERE clause helping the query.
    await seedTenantA();
    const raw = await appPool.connect();
    try {
      await bindTenant(raw, TENANT_B);
      const branches = await raw.query('SELECT id, name FROM branches');
      expect(branches.rowCount).toBe(0);
      const users = await raw.query('SELECT id, email FROM users');
      expect(users.rowCount).toBe(0);
      await commitAndDiscard(raw);
    } finally {
      raw.release();
    }
  });

  it('raw UPDATE/DELETE of tenant-A rows from a tenant-B connection affects nothing (RLS USING hides them)', async () => {
    await seedTenantA();
    const raw = await appPool.connect();
    try {
      await bindTenant(raw, TENANT_B);

      const updBranch = await raw.query('UPDATE branches SET name = $1 WHERE id = $2', ['pwned', BRANCH_A_ID]);
      expect(updBranch.rowCount).toBe(0);
      const delBranch = await raw.query('DELETE FROM branches WHERE id = $1', [BRANCH_A_ID]);
      expect(delBranch.rowCount).toBe(0);
      const updUser = await raw.query('UPDATE users SET password_hash = $1 WHERE id = $2', ['pwned-hash', USER_A_ID]);
      expect(updUser.rowCount).toBe(0);
      const delUser = await raw.query('DELETE FROM users WHERE id = $1', [USER_A_ID]);
      expect(delUser.rowCount).toBe(0);

      await commitAndDiscard(raw);
    } finally {
      raw.release();
    }

    // Data-integrity check: tenant A's rows are untouched and still visible to A.
    const intact = await withAppCtx(TENANT_A, async (q) => {
      const b = await q.query<{ name: string }>('SELECT name FROM branches WHERE id = $1', [BRANCH_A_ID]);
      const u = await q.query<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [USER_A_ID]);
      return { branchName: b.rows[0]?.name, passwordHash: u.rows[0]?.password_hash };
    });
    expect(intact.branchName).toBe('Riyadh Main');
    expect(intact.passwordHash).toBe('hash-placeholder-a');
  });

  it('writes that would land a row in another tenant are rejected by the WITH CHECK clause (hard error)', async () => {
    // Tenant B must own a visible row for the UPDATE-across-tenants attempt.
    await seedTenantA();
    await seedTenantB();
    const raw = await appPool.connect();
    try {
      // INSERT with tenant_id = TENANT_A while bound to TENANT_B → WITH CHECK violation.
      await bindTenant(raw, TENANT_B);
      await expect(
        raw.query(
          'INSERT INTO branches (id, tenant_id, name, base_currency, timezone) VALUES ($1, $2, $3, $4, $5)',
          ['eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', TENANT_A, 'Sneaky', 'SAR', 'Asia/Riyadh'],
        ),
      ).rejects.toThrow(/row-level security policy/);
      await raw.query('ROLLBACK');

      // UPDATE of a tenant-B-visible branch INTO tenant A → WITH CHECK violation.
      await bindTenant(raw, TENANT_B);
      await expect(raw.query('UPDATE branches SET tenant_id = $1 WHERE id = $2', [TENANT_A, BRANCH_B_ID])).rejects.toThrow(
        /row-level security policy/,
      );
      await raw.query('ROLLBACK');

      // INSERT of a tenant-A user from B → WITH CHECK violation on users too.
      await bindTenant(raw, TENANT_B);
      await expect(
        raw.query(
          'INSERT INTO users (id, tenant_id, branch_id, email, password_hash) VALUES ($1, $2, $3, $4, $5)',
          ['ffffffff-ffff-4fff-8fff-ffffffffffff', TENANT_A, BRANCH_A_ID, 'sneaky@example.com', 'hash'],
        ),
      ).rejects.toThrow(/row-level security policy/);
      await raw.query('ROLLBACK');
      await raw.query('DISCARD ALL');
    } finally {
      raw.release();
    }
  });

  it('a raw query with NO tenant context at all fails closed instead of returning rows', async () => {
    await seedTenantA();
    const raw = await appPool.connect();
    try {
      // No BEGIN, no set_config. The policy expression calls
      // current_setting('app.current_tenant_id') WITHOUT missing_ok=true →
      // PostgreSQL aborts the query (never silently returns rows). On a session
      // that never touched the GUC: "unrecognized configuration parameter"; on
      // a reused pooled connection whose custom GUC was reset to its empty
      // default: `''::uuid` → "invalid input syntax for type uuid". Both are
      // fail-closed: zero rows are NOT the failure mode, erroring is.
      await expect(raw.query('SELECT id, name FROM branches')).rejects.toThrow(FAIL_CLOSED_MESSAGE);
      await expect(raw.query('SELECT id, email FROM users')).rejects.toThrow(FAIL_CLOSED_MESSAGE);
    } finally {
      raw.release();
    }
  });

  it('the same raw mechanism CAN read tenant-A rows when bound to tenant A (control)', async () => {
    await seedTenantA();
    const raw = await appPool.connect();
    try {
      await bindTenant(raw, TENANT_A);
      const branches = await raw.query<{ id: string }>('SELECT id FROM branches');
      expect(branches.rows.map((r) => r.id)).toEqual([BRANCH_A_ID]);
      const users = await raw.query<{ id: string }>('SELECT id FROM users');
      expect(users.rows.map((r) => r.id)).toEqual([USER_A_ID]);
      await commitAndDiscard(raw);
    } finally {
      raw.release();
    }
  });
});
