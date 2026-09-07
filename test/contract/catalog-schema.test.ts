/**
 * Contract: Phase-5 catalog schema on a REAL PostgreSQL catalog.
 *
 * Every table with tenant_id is also covered generically by rls-coverage.test.ts.
 * This file names the six catalog tables and the catalog permission keys so a
 * missing ENABLE/FORCE/policy or a sensitive-flag regression fails loudly.
 */
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  CATALOG_PERMISSION_ARCHIVE,
  CATALOG_PERMISSION_KEYS,
  CATALOG_PERMISSION_READ,
  CATALOG_PERMISSION_WRITE,
} from '../../src/domain/contracts/catalog-permissions.ts';
import { connectTestClient } from '../support/database.ts';

const TABLES = [
  'menu_categories',
  'menu_items',
  'branch_menu_item_overrides',
  'modifier_groups',
  'modifiers',
  'menu_item_modifier_groups',
] as const;

const normalise = (expr: string | null): string => (expr ?? '').replace(/\s+/g, '').toLowerCase();
const EXPECTED_PREDICATE = normalise("(tenant_id = (current_setting('app.current_tenant_id'::text))::uuid)");

describe('contract: phase-5 catalog schema', () => {
  let client: pg.Client;

  beforeAll(async () => {
    client = await connectTestClient();
  });
  afterAll(async () => {
    await client.end();
  });

  it('creates all six catalog tables', async () => {
    const result = await client.query<{ relname: string }>(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname = ANY($1::text[])`,
      [TABLES],
    );
    expect(result.rows.map((row) => row.relname).sort()).toEqual([...TABLES].sort());
  });

  it.each(TABLES)('%s has RLS ENABLED + FORCED and the dual tenant_isolation policy', async (table) => {
    const rls = await client.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT c.relrowsecurity, c.relforcerowsecurity
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = $1`,
      [table],
    );
    expect(rls.rows[0]?.relrowsecurity, `${table} ENABLE`).toBe(true);
    expect(rls.rows[0]?.relforcerowsecurity, `${table} FORCE`).toBe(true);

    const policy = await client.query<{ cmd: string; qual: string | null; with_check: string | null }>(
      `SELECT cmd, qual, with_check FROM pg_policies
        WHERE schemaname = 'public' AND tablename = $1 AND policyname = 'tenant_isolation'`,
      [table],
    );
    expect(policy.rowCount).toBe(1);
    expect(policy.rows[0]?.cmd).toBe('ALL');
    expect(normalise(policy.rows[0]?.qual ?? null)).toBe(EXPECTED_PREDICATE);
    expect(normalise(policy.rows[0]?.with_check ?? null)).toBe(EXPECTED_PREDICATE);
  });

  it('menu_items.tax_rule_id exists without a foreign-key constraint', async () => {
    const column = await client.query<{ data_type: string; is_nullable: string }>(
      `SELECT data_type, is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'menu_items' AND column_name = 'tax_rule_id'`,
    );
    expect(column.rowCount).toBe(1);
    expect(column.rows[0]?.data_type).toBe('uuid');
    expect(column.rows[0]?.is_nullable).toBe('YES');

    const fks = await client.query(
      `SELECT 1 FROM information_schema.table_constraints
        WHERE table_schema = 'public' AND table_name = 'menu_items'
          AND constraint_type = 'FOREIGN KEY' AND constraint_name ILIKE '%tax_rule%'`,
    );
    expect(fks.rowCount).toBe(0);
  });

  it('JSONB name columns have no language-code check constraint', async () => {
    const checks = await client.query<{ check_clause: string }>(
      `SELECT cc.check_clause
         FROM information_schema.check_constraints cc
         JOIN information_schema.constraint_column_usage ccu
           ON ccu.constraint_name = cc.constraint_name AND ccu.constraint_schema = cc.constraint_schema
        WHERE ccu.table_schema = 'public'
          AND ccu.table_name IN ('menu_categories', 'menu_items', 'modifier_groups', 'modifiers')
          AND ccu.column_name = 'name'`,
    );
    for (const row of checks.rows) {
      expect(row.check_clause.toLowerCase()).not.toContain("'ar'");
      expect(row.check_clause.toLowerCase()).not.toContain("'en'");
    }
  });

  it('seeds catalog:read / catalog:write / catalog:archive with is_sensitive = false', async () => {
    const rows = await client.query<{ key: string; category: string; is_sensitive: boolean }>(
      `SELECT key, category, is_sensitive FROM permissions_registry WHERE key = ANY($1::text[]) ORDER BY key`,
      [[CATALOG_PERMISSION_READ, CATALOG_PERMISSION_WRITE, CATALOG_PERMISSION_ARCHIVE]],
    );
    expect(rows.rows.map((row) => row.key)).toEqual([...CATALOG_PERMISSION_KEYS].slice().sort());
    expect(rows.rows.every((row) => row.category === 'catalog')).toBe(true);
    expect(rows.rows.every((row) => !row.is_sensitive)).toBe(true);
  });

  it('modifier_groups_single_max CHECK binds selection_type=single to max_selections 1 or NULL', async () => {
    const result = await client.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def
         FROM pg_constraint
        WHERE conname = 'modifier_groups_single_max'`,
    );
    expect(result.rowCount).toBe(1);
    const def = (result.rows[0]?.def ?? '').toLowerCase();
    expect(def).toContain('selection_type');
    expect(def).toContain('max_selections');
  });

  it('amount columns are bigint (minor units), never numeric/float', async () => {
    const columns = await client.query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type FROM information_schema.columns
        WHERE table_schema = 'public'
          AND column_name IN ('base_price_amount_minor', 'price_override_amount_minor', 'price_delta_amount_minor')
        ORDER BY column_name`,
    );
    expect(columns.rowCount).toBeGreaterThanOrEqual(3);
    expect(columns.rows.every((row) => row.data_type === 'bigint')).toBe(true);
  });
});
