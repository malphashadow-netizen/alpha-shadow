/**
 * Contract tests for the Phase-3 authentication schema, on a REAL PostgreSQL
 * catalog:
 *
 *  - auth_refresh_tokens is a normal tenant-scoped table (ENABLE + FORCE RLS
 *    + the dual USING/WITH CHECK tenant_isolation policy) — automatically
 *    covered by rls-coverage.test.ts too, asserted here explicitly.
 *  - auth_audit_log is the DOCUMENTED global exception: it deliberately has NO
 *    tenant_id column (the nullable claimed-tenant column is named
 *    tenant_id_attempted) and NO RLS policy. The generic RLS guard keys on
 *    the exact column name `tenant_id`, so this table stays out of scope by
 *    construction; we assert both sides here.
 *  - the two SECURITY DEFINER functions exist and execute; the two rate-limit
 *    indexes exist; the app_audit least-privilege grant is represented by
 *    the functions (role creation is a manual DBA step, exercised live in
 *    auth-audit-role.test.ts).
 *  - users.staff_code exists with the per-tenant partial unique index.
 */
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { connectTestClient } from '../support/database.ts';

describe('contract: phase-3 auth schema', () => {
  let client: pg.Client;

  beforeAll(async () => {
    client = await connectTestClient();
  });
  afterAll(async () => {
    await client.end();
  });

  it('auth_refresh_tokens has RLS enabled and forced with the tenant_isolation policy', async () => {
    const rls = await client.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT c.relrowsecurity, c.relforcerowsecurity
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = 'auth_refresh_tokens'`,
    );
    expect(rls.rows[0]?.relrowsecurity).toBe(true);
    expect(rls.rows[0]?.relforcerowsecurity).toBe(true);

    const policy = await client.query(
      `SELECT cmd, qual, with_check FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'auth_refresh_tokens' AND policyname = 'tenant_isolation'`,
    );
    expect(policy.rowCount).toBe(1);
    expect(policy.rows[0]?.cmd).toBe('ALL');
  });

  it('auth_audit_log is the documented GLOBAL exception: no tenant_id column and NO RLS', async () => {
    const columns = await client.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'auth_audit_log'`,
    );
    const names = columns.rows.map((r) => r.column_name);
    // The RLS-guard key column MUST be absent (the claimed tenant is named
    // tenant_id_attempted and is nullable, with no FK).
    expect(names).not.toContain('tenant_id');
    expect(names).toContain('tenant_id_attempted');
    expect(names).toContain('identifier_attempted');
    expect(names).toContain('ip_address');
    expect(names).toContain('success');
    expect(names).toContain('mode');

    const rls = await client.query<{ relrowsecurity: boolean }>(
      `SELECT c.relrowsecurity FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = 'auth_audit_log'`,
    );
    expect(rls.rows[0]?.relrowsecurity).toBe(false);

    const policies = await client.query(
      `SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'auth_audit_log'`,
    );
    expect(policies.rowCount).toBe(0);
  });

  it('rate-limit indexes (ip_address, created_at) and (identifier_attempted, created_at) exist', async () => {
    const indexes = await client.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'auth_audit_log'`,
    );
    const defs = indexes.rows.map((r) => r.indexdef);
    expect(defs.some((d) => d.includes('ip_address') && d.includes('created_at'))).toBe(true);
    expect(defs.some((d) => d.includes('identifier_attempted') && d.includes('created_at'))).toBe(true);
  });

  it('record_auth_attempt() and count_recent_auth_failures() exist as SECURITY DEFINER functions', async () => {
    const funcs = await client.query<{ proname: string; prosecdef: boolean }>(
      `SELECT p.proname, p.prosecdef FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname IN ('record_auth_attempt', 'count_recent_auth_failures')`,
    );
    expect(funcs.rowCount).toBe(2);
    expect(funcs.rows.every((r) => r.prosecdef)).toBe(true);
  });

  it('the SECURITY DEFINER functions record and count failures (sliding window)', async () => {
    await client.query('BEGIN');
    try {
      const identifier = `contract-probe-${crypto.randomUUID()}`;
      await client.query(
        `SELECT record_auth_attempt($1::uuid, $2, $3, 'password', false, $4, $5)`,
        [null, null, identifier, '203.0.113.250', 'contract'],
      );
      const counted = await client.query<{ count_recent_auth_failures: number }>(
        `SELECT count_recent_auth_failures('password', $1, $2, $3) AS count_recent_auth_failures`,
        ['203.0.113.250', identifier, 15 * 60 * 1000],
      );
      expect(counted.rows[0]?.count_recent_auth_failures).toBeGreaterThanOrEqual(1);
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('users.staff_code exists with the per-tenant partial unique index', async () => {
    const columns = await client.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'staff_code'`,
    );
    expect(columns.rowCount).toBe(1);

    const index = await client.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'users' AND indexname = 'idx_users_tenant_staff_code'`,
    );
    expect(index.rowCount).toBe(1);
    expect(index.rows[0]?.indexdef).toContain('UNIQUE');
    expect(index.rows[0]?.indexdef).toContain('staff_code');
  });
});
