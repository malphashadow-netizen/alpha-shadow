import { readFile } from 'node:fs/promises';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TAX_PERMISSION_KEYS } from '../../src/domain/contracts/tenant-tax-admin.ts';
import { connectTestClient } from '../support/database.ts';

const GLOBALS = ['tax_jurisdictions', 'tax_categories', 'tax_rates', 'sales_channels', 'delivery_platforms', 'tax_liability_rules'];
const TENANT_TABLES = ['branch_tax_category_overrides', 'menu_item_additional_tax_categories', 'menu_item_excise_confirmations', 'order_line_tax_contexts', 'order_line_tax_snapshots'];

describe('Phase 6 PostgreSQL schema/privilege contracts', () => {
  let client: pg.Client;
  beforeAll(async () => {
    client = await connectTestClient();
    for (const name of ['001_app_login.sql', '002_app_login_rbac.sql', '004_app_login_phase4.sql', '005_app_login_catalog.sql', '006_phase6_tax.sql']) {
      await client.query(await readFile(new URL(`../../migrations/roles/${name}`, import.meta.url), 'utf8'));
    }
  });
  afterAll(async () => client.end());
  it.each(GLOBALS)('%s is global, without tenant_id or RLS, and tenant credentials are SELECT-only', async (table) => {
    const result = await client.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean; tenant_column: boolean }>(`SELECT c.relrowsecurity, c.relforcerowsecurity,
      EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped) AS tenant_column
      FROM pg_class c WHERE c.oid = $1::regclass`, [table]);
    expect(result.rows[0]).toEqual({ relrowsecurity: false, relforcerowsecurity: false, tenant_column: false });
    for (const privilege of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) {
      const p = await client.query<{ allowed: boolean }>('SELECT has_table_privilege($1,$2,$3) AS allowed', ['app_login', table, privilege]);
      expect(p.rows[0]?.allowed, `${table}/${privilege}`).toBe(false);
    }
    expect((await client.query<{ allowed: boolean }>('SELECT has_table_privilege($1,$2,$3) AS allowed', ['app_login', table, 'SELECT'])).rows[0]?.allowed).toBe(true);
  });
  it.each(TENANT_TABLES)('%s has forced RLS including the parent-scoped tables with no tenant column', async (table) => {
    const r = await client.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>('SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid = $1::regclass', [table]);
    expect(r.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const p = await client.query<{ cmd: string; qual: string | null; with_check: string | null }>('SELECT cmd,qual,with_check FROM pg_policies WHERE tablename = $1', [table]);
    expect(p.rows.some((x) => x.cmd === 'ALL' && x.qual !== null && x.with_check !== null)).toBe(true);
  });
  it('rate intervals have a real GIST exclusion constraint; dates and bps are constrained', async () => {
    const r = await client.query<{ contype: string; definition: string }>("SELECT contype,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid = 'tax_rates'::regclass");
    expect(r.rows.some((c) => c.contype === 'x' && c.definition.includes('gist') && c.definition.includes('daterange') && c.definition.includes('&&'))).toBe(true);
    expect(r.rows.some((c) => c.contype === 'c' && c.definition.includes('10000'))).toBe(true);
  });
  it('snapshot primary key is (order_line_id,tax_rate_id), with immutable trigger and BIGINT amounts', async () => {
    const pk = await client.query<{ definition: string }>("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid = 'order_line_tax_snapshots'::regclass AND contype = 'p'");
    expect(pk.rows[0]?.definition).toBe('PRIMARY KEY (order_line_id, tax_rate_id)');
    const amounts = await client.query<{ data_type: string }>("SELECT data_type FROM information_schema.columns WHERE table_name = 'order_line_tax_snapshots' AND column_name IN ('taxable_amount_minor','tax_amount_minor')");
    expect(amounts.rows.map((r) => r.data_type)).toEqual(['bigint', 'bigint']);
    const trigger = await client.query("SELECT 1 FROM pg_trigger WHERE tgrelid = 'order_line_tax_snapshots'::regclass AND tgname = 'trg_order_tax_snapshot_immutable' AND tgenabled = 'O'");
    expect(trigger.rowCount).toBe(1);
    for (const table of ['order_line_tax_snapshots', 'order_line_tax_contexts', 'menu_item_excise_confirmations']) {
      expect((await client.query<{ allowed: boolean }>('SELECT has_table_privilege($1,$2,$3) AS allowed', ['app_login', table, 'UPDATE'])).rows[0]?.allowed).toBe(false);
      expect((await client.query<{ allowed: boolean }>('SELECT has_table_privilege($1,$2,$3) AS allowed', ['app_login', table, 'DELETE'])).rows[0]?.allowed).toBe(false);
    }
  });
  it('no_vat enforcement, frozen category identity and mandatory rate auditing are real DB triggers', async () => {
    for (const name of ['trg_enforce_no_vat_zero_rate', 'trg_tax_category_identity', 'trg_audit_tax_rate_change', 'trg_tax_rate_history']) {
      expect((await client.query('SELECT 1 FROM pg_trigger WHERE tgname = $1 AND tgenabled = $2', [name, 'O'])).rowCount).toBe(1);
    }
  });
  it('platform role cannot bypass RLS, mutate rates directly, or grant itself to a tenant', async () => {
    const r = await client.query<{ rolsuper: boolean; rolbypassrls: boolean; rolcreaterole: boolean; rolcreatedb: boolean }>("SELECT rolsuper,rolbypassrls,rolcreaterole,rolcreatedb FROM pg_roles WHERE rolname = 'platform_tax_admin'");
    expect(r.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false });
    expect((await client.query<{ member: boolean }>("SELECT pg_has_role('app_login','platform_tax_admin','MEMBER') AS member")).rows[0]?.member).toBe(false);
    for (const privilege of ['INSERT', 'UPDATE', 'DELETE']) {
      expect((await client.query<{ allowed: boolean }>('SELECT has_table_privilege($1,$2,$3) AS allowed', ['platform_tax_admin', 'tax_rates', privilege])).rows[0]?.allowed).toBe(false);
    }
    const signature = 'close_and_supersede_tax_rate(uuid,integer,boolean,date,uuid)';
    expect((await client.query<{ allowed: boolean }>('SELECT has_function_privilege($1,$2,$3) AS allowed', ['app_login', signature, 'EXECUTE'])).rows[0]?.allowed).toBe(false);
    expect((await client.query<{ allowed: boolean }>('SELECT has_function_privilege($1,$2,$3) AS allowed', ['platform_tax_admin', signature, 'EXECUTE'])).rows[0]?.allowed).toBe(true);
  });
  it('tax_rule_id points to tax_categories; branches require an explicit country without a default', async () => {
    const fk = await client.query<{ definition: string }>("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname = 'menu_items_tax_rule_id_fkey'");
    expect(fk.rows[0]?.definition).toBe('FOREIGN KEY (tax_rule_id) REFERENCES tax_categories(id)');
    const c = await client.query<{ is_nullable: string; column_default: string | null }>("SELECT is_nullable,column_default FROM information_schema.columns WHERE table_name = 'branches' AND column_name = 'country_code'");
    expect(c.rows[0]).toEqual({ is_nullable: 'NO', column_default: null });
  });
  it('initial configuration supports all requested kinds/rates without inventing marketplace law', async () => {
    const r = await client.query<{ country_code: string; code: string; kind: string; rate_bps: number }>(`SELECT c.country_code,c.code,c.kind,r.rate_bps FROM tax_categories c JOIN tax_rates r ON r.tax_category_id = c.id
      WHERE c.code IN ('standard','reduced','zero_rated','exempt','no_vat','excise_100') AND r.effective_from = DATE '2026-09-07' ORDER BY c.country_code,c.code`);
    expect(r.rows).toEqual([
      { country_code: 'AE', code: 'standard', kind: 'standard', rate_bps: 500 },
      { country_code: 'AE', code: 'zero_rated', kind: 'zero_rated', rate_bps: 0 },
      { country_code: 'EG', code: 'exempt', kind: 'exempt', rate_bps: 0 },
      { country_code: 'EG', code: 'reduced', kind: 'reduced', rate_bps: 500 },
      { country_code: 'EG', code: 'standard', kind: 'standard', rate_bps: 1400 },
      { country_code: 'EG', code: 'zero_rated', kind: 'zero_rated', rate_bps: 0 },
      { country_code: 'KW', code: 'no_vat', kind: 'no_vat', rate_bps: 0 },
      { country_code: 'SA', code: 'excise_100', kind: 'standard', rate_bps: 10000 },
      { country_code: 'SA', code: 'standard', kind: 'standard', rate_bps: 1500 },
    ]);
    // Live integration fixtures can add legal rules; migration's static test
    // below proves no production delivery_app liability rule is seeded.
    expect((await client.query("SELECT 1 FROM delivery_platforms WHERE code IN ('talabat','jahez','hungerstation','keeta','careem_food','toyou','mrsool')")).rowCount).toBe(7);
  });
  it('sensitive tenant tax permissions are registry data, not implicit role-name privileges', async () => {
    const r = await client.query<{ key: string; is_sensitive: boolean }>('SELECT key,is_sensitive FROM permissions_registry WHERE key = ANY($1::text[]) ORDER BY key', [TAX_PERMISSION_KEYS]);
    expect(r.rows).toHaveLength(4);
    expect(r.rows.filter((p) => p.key !== 'tax:read').every((p) => p.is_sensitive)).toBe(true);
  });
  it('platform audit uses NULL ownership with an explicit scope constraint, never a fake tenant', async () => {
    const c = await client.query<{ definition: string }>("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname = 'audit_log_scope_owner'");
    expect(c.rows[0]?.definition).toContain('tenant_id IS NULL');
    expect(c.rows[0]?.definition).toContain('platform_tax');
    expect(c.rows[0]?.definition).toContain('tenant_id IS NOT NULL');
  });
});
