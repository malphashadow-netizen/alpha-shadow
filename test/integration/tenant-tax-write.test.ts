import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createWithTenantContext, type WithTenantContext } from '../../src/infrastructure/db/tenant-context.ts';
import { testDatabaseUrl } from '../support/database.ts';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

describe('tenant-owned tax categories and rates', () => {
  let owner: pg.Pool;
  let app: pg.Pool;
  let withApp: WithTenantContext;

  beforeAll(async () => {
    owner = new pg.Pool({ connectionString: testDatabaseUrl(), max: 3 });
    for (const file of ['001_app_login.sql', '016_tenant_tax_write.sql']) {
      await owner.query(await readFile(new URL(`../../migrations/roles/${file}`, import.meta.url), 'utf8'));
    }
    const password = randomBytes(24).toString('hex');
    await owner.query(`ALTER ROLE app_login LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);
    const appUrl = new URL(testDatabaseUrl());
    appUrl.username = 'app_login';
    appUrl.password = password;
    app = new pg.Pool({ connectionString: appUrl.toString(), max: 3 });
    withApp = createWithTenantContext(app, { verifyTenantExists: true });
  });

  afterAll(async () => {
    await app?.end();
    await owner?.end();
  });

  async function insertCategory(tenantId: string, code = randomUUID()): Promise<string> {
    return withApp(tenantId, async (q) => {
      const result = await q.query<{ id: string }>(
        `INSERT INTO tenant_tax_categories(tenant_id, country_code, code, kind, tax_family, name)
         VALUES ($1, 'EG', $2, 'standard', 'vat', '{"en":"Tenant tax"}') RETURNING id`,
        [tenantId, code],
      );
      const id = result.rows[0]?.id;
      if (id === undefined) throw new Error('category insert returned no row');
      return id;
    });
  }

  it('creates, closes, and supersedes a tenant rate', async () => {
    const categoryId = await insertCategory(A);
    const created = await withApp(A, async (q) => q.query<{ id: string; rate_bps: number }>(
      'SELECT id, rate_bps FROM create_tenant_tax_rate($1,$2,$3,$4,$5::date,$6::date)',
      [A, categoryId, 1400, false, '2026-01-01', null],
    ));
    expect(created.rows[0]?.rate_bps).toBe(1400);

    const superseded = await withApp(A, async (q) => q.query<{ id: string; rate_bps: number }>(
      'SELECT id, rate_bps FROM close_and_supersede_tenant_tax_rate($1,$2,$3,$4,$5::date)',
      [A, created.rows[0]?.id, 1500, false, '2026-02-01'],
    ));
    expect(superseded.rows[0]?.rate_bps).toBe(1500);
    const old = await withApp(A, async (q) => q.query<{ effective_to: string; superseded_by: string }>(
      'SELECT effective_to::text, superseded_by FROM tenant_tax_rates WHERE id = $1',
      [created.rows[0]?.id],
    ));
    expect(old.rows[0]).toEqual({ effective_to: '2026-01-31', superseded_by: superseded.rows[0]?.id });
  });

  it('hides tenant A categories and rates from tenant B through RLS', async () => {
    const categoryId = await insertCategory(A);
    await withApp(A, (q) => q.query(
      'SELECT id FROM create_tenant_tax_rate($1,$2,500,false,$3::date,NULL)', [A, categoryId, '2027-01-01'],
    ));
    const visible = await withApp(B, async (q) => q.query(
      'SELECT id FROM tenant_tax_categories WHERE id = $1 UNION ALL SELECT id FROM tenant_tax_rates WHERE tax_category_id = $1',
      [categoryId],
    ));
    expect(visible.rows).toHaveLength(0);
  });

  it('rejects a function tenant_id different from the current tenant context', async () => {
    const categoryId = await insertCategory(A);
    await expect(withApp(A, (q) => q.query(
      'SELECT id FROM create_tenant_tax_rate($1,$2,500,false,$3::date,NULL)', [B, categoryId, '2027-01-01'],
    ))).rejects.toMatchObject({ code: '42501' });
  });

  it('rejects overlapping effective periods for the same tenant category', async () => {
    const categoryId = await insertCategory(A);
    await withApp(A, (q) => q.query(
      'SELECT id FROM create_tenant_tax_rate($1,$2,500,false,$3::date,$4::date)',
      [A, categoryId, '2027-01-01', '2027-12-31'],
    ));
    await expect(withApp(A, (q) => q.query(
      'SELECT id FROM create_tenant_tax_rate($1,$2,700,false,$3::date,$4::date)',
      [A, categoryId, '2027-06-01', '2028-01-01'],
    ))).rejects.toMatchObject({ code: '23P01' });
  });

  it('rejects a cross-tenant category through the composite foreign key', async () => {
    const categoryB = await insertCategory(B);
    await expect(withApp(A, (q) => q.query(
      'SELECT id FROM create_tenant_tax_rate($1,$2,500,false,$3::date,NULL)',
      [A, categoryB, '2027-01-01'],
    ))).rejects.toMatchObject({ code: '23503' });
  });
});
