/**
 * CONTRACT: every table that carries a `tenant_id` column must be protected by
 * Row-Level Security in the strict form mandated by the spec:
 *
 *   ALTER TABLE t ENABLE ROW LEVEL SECURITY;
 *   ALTER TABLE t FORCE  ROW LEVEL SECURITY;
 *   CREATE POLICY tenant_isolation ON t FOR ALL
 *     USING      (tenant_id = current_setting('app.current_tenant_id')::uuid)
 *     WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);
 *
 * This test runs on every CI build against a REAL PostgreSQL catalog
 * (pg_tables / pg_policies / pg_class), never a mock. It is intentionally
 * generic: it does not know the table list, so the 15+ tables added in later
 * phases are covered automatically the moment they appear in the schema.
 *
 * Phase 0 status: no migrations exist yet, so the schema under inspection is
 * empty and the invariant holds vacuously. The harness (real server, catalog
 * queries, failure formatting) is exercised now so that Phase 1's first
 * migration is checked by an already-proven guard. The final test in this
 * file proves the guard actually detects violations by creating deliberately
 * broken tables inside a rolled-back transaction.
 */
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { connectTestClient } from '../support/database.ts';

/** Schemas that hold application tables. Extend here if a future phase adds one. */
const APPLICATION_SCHEMAS = ['public'] as const;
// Phase 1: tenant_probe and branch_probe are verified here via the dual USING/WITH CHECK policy

interface TenantTable {
  schema: string;
  table: string;
  rls_enabled: boolean;
  rls_forced: boolean;
}

interface PolicyRow {
  schema: string;
  table: string;
  policy: string;
  cmd: string;
  permissive: string;
  roles: string[];
  qual: string | null;
  with_check: string | null;
}

/** Whitespace-insensitive comparison of policy expressions as printed by pg_policies. */
const normalise = (expr: string | null): string => (expr ?? '').replace(/\s+/g, '').toLowerCase();
const EXPECTED_PREDICATE = normalise("(tenant_id = (current_setting('app.current_tenant_id'::text))::uuid)");

async function listTenantTables(client: pg.Client, schemas: readonly string[]): Promise<TenantTable[]> {
  const result = await client.query<TenantTable>(
    `
      SELECT n.nspname                 AS schema,
             c.relname                 AS table,
             c.relrowsecurity          AS rls_enabled,
             c.relforcerowsecurity     AS rls_forced
        FROM pg_attribute a
        JOIN pg_class     c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE a.attname = 'tenant_id'
         AND NOT a.attisdropped
         AND c.relkind IN ('r', 'p')          -- ordinary + partitioned tables
         AND n.nspname = ANY($1::text[])
       ORDER BY 1, 2
    `,
    [schemas],
  );
  return result.rows;
}

async function listPolicies(client: pg.Client, schemas: readonly string[]): Promise<PolicyRow[]> {
  const result = await client.query<PolicyRow>(
    `
      SELECT schemaname AS schema,
             tablename  AS table,
             policyname AS policy,
             cmd,
             permissive,
             roles::text[] AS roles,
             qual,
             with_check
        FROM pg_policies
       WHERE schemaname = ANY($1::text[])
       ORDER BY 1, 2, 3
    `,
    [schemas],
  );
  return result.rows;
}

/** Returns a list of human-readable violations; empty means the contract holds. */
export async function findRlsViolations(client: pg.Client, schemas: readonly string[] = APPLICATION_SCHEMAS): Promise<string[]> {
  const tables = await listTenantTables(client, schemas);
  const policies = await listPolicies(client, schemas);
  const violations: string[] = [];

  for (const t of tables) {
    const name = `${t.schema}.${t.table}`;
    if (!t.rls_enabled) violations.push(`${name}: ROW LEVEL SECURITY is not ENABLED`);
    if (!t.rls_forced) violations.push(`${name}: ROW LEVEL SECURITY is not FORCED (table owner would bypass RLS)`);

    const own = policies.filter((p) => p.schema === t.schema && p.table === t.table);
    const isolation = own.find(
      (p) =>
        p.cmd === 'ALL' &&
        p.permissive === 'PERMISSIVE' &&
        normalise(p.qual) === EXPECTED_PREDICATE &&
        normalise(p.with_check) === EXPECTED_PREDICATE,
    );
    if (!isolation) {
      const seen = own.length === 0 ? '(no policies at all)' : own.map((p) => `${p.policy}[cmd=${p.cmd} qual=${p.qual ?? 'NULL'} with_check=${p.with_check ?? 'NULL'}]`).join('; ');
      violations.push(`${name}: missing FOR ALL policy with USING and WITH CHECK both equal to "tenant_id = current_setting('app.current_tenant_id')::uuid" — found: ${seen}`);
    }
  }
  return violations;
}

describe('contract: RLS coverage on every tenant_id table', () => {
  let client: pg.Client;

  beforeAll(async () => {
    client = await connectTestClient();
  });
  afterAll(async () => {
    await client.end();
  });

  it('connects to a real PostgreSQL server (no mock)', async () => {
    const r = await client.query<{ v: number }>('SELECT current_setting(\'server_version_num\')::int AS v');
    expect(r.rows[0]?.v).toBeGreaterThanOrEqual(150000);
  });

  it('every table with a tenant_id column has RLS ENABLED + FORCED and the dual USING/WITH CHECK isolation policy', async () => {
    const violations = await findRlsViolations(client);
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('the guard itself detects every class of violation (self-check inside a rolled-back transaction)', async () => {
    await client.query('BEGIN');
    try {
      await client.query('CREATE SCHEMA rls_selfcheck');
      // 1) no RLS at all
      await client.query('CREATE TABLE rls_selfcheck.no_rls (id int, tenant_id uuid)');
      // 2) enabled but not forced, no policy
      await client.query('CREATE TABLE rls_selfcheck.not_forced (id int, tenant_id uuid)');
      await client.query('ALTER TABLE rls_selfcheck.not_forced ENABLE ROW LEVEL SECURITY');
      // 3) enabled + forced but policy lacks WITH CHECK (write path unprotected)
      await client.query('CREATE TABLE rls_selfcheck.using_only (id int, tenant_id uuid)');
      await client.query('ALTER TABLE rls_selfcheck.using_only ENABLE ROW LEVEL SECURITY');
      await client.query('ALTER TABLE rls_selfcheck.using_only FORCE ROW LEVEL SECURITY');
      await client.query(
        "CREATE POLICY tenant_isolation ON rls_selfcheck.using_only FOR ALL USING (tenant_id = current_setting('app.current_tenant_id')::uuid)",
      );
      // 4) fully compliant — must produce no violation
      await client.query('CREATE TABLE rls_selfcheck.compliant (id int, tenant_id uuid)');
      await client.query('ALTER TABLE rls_selfcheck.compliant ENABLE ROW LEVEL SECURITY');
      await client.query('ALTER TABLE rls_selfcheck.compliant FORCE ROW LEVEL SECURITY');
      await client.query(
        "CREATE POLICY tenant_isolation ON rls_selfcheck.compliant FOR ALL USING (tenant_id = current_setting('app.current_tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid)",
      );
      // 5) table WITHOUT tenant_id (global registry, e.g. permissions_registry) — out of scope, no violation
      await client.query('CREATE TABLE rls_selfcheck.global_registry (id int, key text)');

      const violations = await findRlsViolations(client, ['rls_selfcheck']);

      expect(violations.filter((v) => v.startsWith('rls_selfcheck.no_rls:'))).toHaveLength(3);
      expect(violations.filter((v) => v.startsWith('rls_selfcheck.not_forced:'))).toHaveLength(2);
      const usingOnly = violations.filter((v) => v.startsWith('rls_selfcheck.using_only:'));
      expect(usingOnly).toHaveLength(1);
      expect(usingOnly[0]).toContain('with_check=NULL');
      expect(violations.filter((v) => v.startsWith('rls_selfcheck.compliant:'))).toHaveLength(0);
      expect(violations.filter((v) => v.startsWith('rls_selfcheck.global_registry:'))).toHaveLength(0);
    } finally {
      await client.query('ROLLBACK');
    }
    // Rolled back: nothing leaks into the shared test database.
    const leftover = await client.query("SELECT 1 FROM pg_namespace WHERE nspname = 'rls_selfcheck'");
    expect(leftover.rowCount).toBe(0);
  });
});
