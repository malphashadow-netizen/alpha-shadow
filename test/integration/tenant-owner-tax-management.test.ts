/** End-to-end tenant-owner tax management and platform-tax regression coverage against real PostgreSQL. */
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { OrderTaxCoordinator } from '../../src/application/engines/orders/order-tax-coordinator.ts';
import { PlatformTaxAdminEngine } from '../../src/application/engines/tax/platform-tax-admin-engine.ts';
import type { NewTaxableOrderLine } from '../../src/domain/contracts/order-tax.ts';
import { createWithPlatformTaxContext } from '../../src/infrastructure/db/platform-tax-context.ts';
import {
  PostgresOrderTaxUnitOfWork,
  type TransactionalOrderLineWriter,
} from '../../src/infrastructure/db/repositories/postgres-order-tax-unit-of-work.ts';
import { PostgresPlatformTaxAdminRepository } from '../../src/infrastructure/db/repositories/postgres-platform-tax-admin-repository.ts';
import {
  PostgresPermissionWriteRepository,
  type PostgresPermissionRepositoryDependencies,
} from '../../src/infrastructure/db/repositories/postgres-permission-repository.ts';
import { createWithTenantContext, type WithTenantContext } from '../../src/infrastructure/db/tenant-context.ts';
import { testDatabaseUrl } from '../support/database.ts';

const ROLE_SQL_FILES = [
  '001_app_login.sql',
  '002_app_login_rbac.sql',
  '004_app_login_phase4.sql',
  '005_app_login_catalog.sql',
  '006_phase6_tax.sql',
  '016_tenant_tax_write.sql',
] as const;
const PLATFORM_ACTOR = '71000000-0000-4000-8000-000000000005';

function first<T>(rows: readonly T[], message: string): T {
  const value = rows[0];
  if (value === undefined) throw new Error(message);
  return value;
}

describe('integration: full tenant-owner tax management', () => {
  let owner: pg.Pool;
  let app: pg.Pool;
  let platformPool: pg.Pool;
  let withApp: WithTenantContext;
  let registration: PostgresPermissionWriteRepository;
  let platform: PlatformTaxAdminEngine;

  beforeAll(async () => {
    owner = new pg.Pool({ connectionString: testDatabaseUrl(), max: 5 });
    for (const file of ROLE_SQL_FILES) {
      await owner.query(await readFile(new URL(`../../migrations/roles/${file}`, import.meta.url), 'utf8'));
    }

    const appPassword = randomBytes(24).toString('hex');
    const platformPassword = randomBytes(24).toString('hex');
    await owner.query(
      `ALTER ROLE app_login LOGIN PASSWORD '${appPassword}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
    await owner.query(
      `ALTER ROLE platform_tax_admin LOGIN PASSWORD '${platformPassword}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );

    const appUrl = new URL(testDatabaseUrl());
    appUrl.username = 'app_login';
    appUrl.password = appPassword;
    app = new pg.Pool({ connectionString: appUrl.toString(), max: 5 });
    withApp = createWithTenantContext(app, { verifyTenantExists: true });

    const platformUrl = new URL(testDatabaseUrl());
    platformUrl.username = 'platform_tax_admin';
    platformUrl.password = platformPassword;
    platformPool = new pg.Pool({ connectionString: platformUrl.toString(), max: 3 });
    platform = new PlatformTaxAdminEngine(
      new PostgresPlatformTaxAdminRepository(createWithPlatformTaxContext(platformPool)),
    );

    const dependencies: PostgresPermissionRepositoryDependencies = {
      withTenantContext: createWithTenantContext(owner),
    };
    registration = new PostgresPermissionWriteRepository(dependencies);

    await owner.query(`CREATE TABLE tenant_owner_tax_test_lines (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL,
      branch_id uuid NOT NULL,
      menu_item_id uuid NOT NULL,
      amount_minor bigint NOT NULL,
      currency_code text NOT NULL,
      amount_basis text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE tenant_owner_tax_test_lines ENABLE ROW LEVEL SECURITY;
    ALTER TABLE tenant_owner_tax_test_lines FORCE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON tenant_owner_tax_test_lines FOR ALL
      USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
      WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);
    GRANT SELECT, INSERT ON tenant_owner_tax_test_lines TO app_login;`);
  });

  afterAll(async () => {
    if (owner !== undefined) await owner.query('DROP TABLE IF EXISTS tenant_owner_tax_test_lines');
    await app?.end();
    await platformPool?.end();
    await owner?.end();
  });

  async function register(countryCode: 'EG' | 'AE') {
    const tenantId = randomUUID();
    const branchId = randomUUID();
    const currency = countryCode === 'EG' ? 'EGP' : 'AED';
    const timezone = countryCode === 'EG' ? 'Africa/Cairo' : 'Asia/Dubai';
    await registration.registerTenantWithCountry(
      tenantId,
      `${countryCode} tenant ${tenantId}`,
      countryCode,
      branchId,
      `${countryCode} branch`,
      timezone,
    );
    await owner.query(
      `UPDATE tenants
          SET vat_registration_status = 'registered', vat_registration_number = $2
        WHERE id = $1`,
      [tenantId, `fixture-${tenantId}`],
    );
    return { tenantId, branchId, currency };
  }

  async function provisionOwner(tenantId: string): Promise<{ userId: string; roleId: string }> {
    const role = await withApp(tenantId, (q) => q.query<{ id: string }>(
      `SELECT id FROM roles
        WHERE tenant_id = $1 AND name = 'TENANT_SUPER_ADMIN' AND is_system = true`,
      [tenantId],
    ));
    const roleId = first(role.rows, 'registration did not create TENANT_SUPER_ADMIN').id;
    const userId = randomUUID();
    await withApp(tenantId, async (q) => {
      await q.query(
        `INSERT INTO users (id, tenant_id, email, password_hash)
         VALUES ($1, $2, $3, 'test-only-password-hash')`,
        [userId, tenantId, `${userId}@example.test`],
      );
      await q.query(
        `INSERT INTO user_roles (tenant_id, user_id, role_id, scope_type, scope_id)
         VALUES ($1, $2, $3, 'tenant', NULL)`,
        [tenantId, userId, roleId],
      );
    });
    return { userId, roleId };
  }

  it('registers country tax copies and provisions a real app_login TENANT_SUPER_ADMIN', async () => {
    const tenant = await register('EG');
    const ownerUser = await provisionOwner(tenant.tenantId);

    const copied = await withApp(tenant.tenantId, (q) => q.query<{
      platform_category_id: string;
      platform_rate_bps: number;
      tenant_rate_bps: number;
    }>(`SELECT tenant_category.platform_category_id,
              platform_rate.rate_bps AS platform_rate_bps,
              tenant_rate.rate_bps AS tenant_rate_bps
         FROM tenant_tax_categories tenant_category
         JOIN tax_categories platform_category ON platform_category.id = tenant_category.platform_category_id
         JOIN tax_rates platform_rate
           ON platform_rate.tax_category_id = platform_category.id AND platform_rate.effective_to IS NULL
         JOIN tenant_tax_rates tenant_rate
           ON tenant_rate.tenant_id = tenant_category.tenant_id
          AND tenant_rate.tax_category_id = tenant_category.id
          AND tenant_rate.effective_to IS NULL
        WHERE tenant_category.tenant_id = $1
        ORDER BY platform_category.id`, [tenant.tenantId]));
    const platformCategories = await owner.query<{ id: string }>(
      `SELECT id FROM tax_categories
        WHERE country_code = 'EG' AND is_active = true ORDER BY id`,
    );

    expect(copied.rows.map((entry) => entry.platform_category_id)).toEqual(
      platformCategories.rows.map((entry) => entry.id),
    );
    expect(copied.rows.every((entry) => entry.tenant_rate_bps === entry.platform_rate_bps)).toBe(true);

    const identity = await withApp(tenant.tenantId, (q) => q.query<{
      current_user: string;
      superuser: boolean;
      bypass_rls: boolean;
      role_id: string;
    }>(`SELECT current_user,
              role_attributes.rolsuper AS superuser,
              role_attributes.rolbypassrls AS bypass_rls,
              assigned.role_id
         FROM pg_roles role_attributes
         JOIN user_roles assigned
           ON assigned.tenant_id = $1 AND assigned.user_id = $2
        WHERE role_attributes.rolname = current_user`, [tenant.tenantId, ownerUser.userId]));
    expect(identity.rows[0]).toEqual({
      current_user: 'app_login',
      superuser: false,
      bypass_rls: false,
      role_id: ownerUser.roleId,
    });
  });

  it('creates a custom tenant rate and fully isolates two countries through RLS', async () => {
    const egypt = await register('EG');
    const emirates = await register('AE');
    await provisionOwner(egypt.tenantId);
    await provisionOwner(emirates.tenantId);

    const category = await withApp(egypt.tenantId, (q) => q.query<{ id: string }>(
      `INSERT INTO tenant_tax_categories
        (tenant_id, country_code, code, kind, tax_family, name)
       VALUES ($1, 'EG', $2, 'standard', 'vat', '{"en":"Owner custom tax"}')
       RETURNING id`,
      [egypt.tenantId, `owner-custom-${randomUUID()}`],
    ));
    const categoryId = first(category.rows, 'tenant category insert returned no row').id;
    const customRate = await withApp(egypt.tenantId, (q) => q.query<{
      id: string;
      tenant_id: string;
      rate_bps: number;
    }>(`SELECT id, tenant_id, rate_bps
          FROM create_tenant_tax_rate($1, $2, 725, false, '2027-01-01'::date, NULL)`,
    [egypt.tenantId, categoryId]));
    expect(customRate.rows[0]).toMatchObject({ tenant_id: egypt.tenantId, rate_bps: 725 });

    const egyptIds = await withApp(egypt.tenantId, (q) => q.query<{ id: string }>(
      `SELECT id FROM tenant_tax_categories WHERE tenant_id = $1
       UNION ALL
       SELECT id FROM tenant_tax_rates WHERE tenant_id = $1`,
      [egypt.tenantId],
    ));
    const emiratesIds = await withApp(emirates.tenantId, (q) => q.query<{ id: string }>(
      `SELECT id FROM tenant_tax_categories WHERE tenant_id = $1
       UNION ALL
       SELECT id FROM tenant_tax_rates WHERE tenant_id = $1`,
      [emirates.tenantId],
    ));
    expect(egyptIds.rows.length).toBeGreaterThan(0);
    expect(emiratesIds.rows.length).toBeGreaterThan(0);

    const hiddenFromEmirates = await withApp(emirates.tenantId, (q) => q.query(
      `SELECT id FROM tenant_tax_categories WHERE id = ANY($1::uuid[])
       UNION ALL
       SELECT id FROM tenant_tax_rates WHERE id = ANY($1::uuid[])`,
      [egyptIds.rows.map((entry) => entry.id)],
    ));
    const hiddenFromEgypt = await withApp(egypt.tenantId, (q) => q.query(
      `SELECT id FROM tenant_tax_categories WHERE id = ANY($1::uuid[])
       UNION ALL
       SELECT id FROM tenant_tax_rates WHERE id = ANY($1::uuid[])`,
      [emiratesIds.rows.map((entry) => entry.id)],
    ));
    expect(hiddenFromEmirates.rows).toHaveLength(0);
    expect(hiddenFromEgypt.rows).toHaveLength(0);
    await expect(withApp(emirates.tenantId, (q) => q.query(
      'SELECT id FROM close_and_supersede_tenant_tax_rate($1, $2, 800, false, $3::date)',
      [emirates.tenantId, customRate.rows[0]?.id, '2027-06-01'],
    ))).rejects.toMatchObject({ code: 'P0002' });
  });

  it('persists tenant_tax_rate_id evidence and preserves it after close-and-supersede', async () => {
    const tenant = await register('EG');
    await provisionOwner(tenant.tenantId);
    const platformCategory = first((await owner.query<{ id: string }>(
      `SELECT id FROM tax_categories WHERE country_code = 'EG' AND code = 'standard'`,
    )).rows, 'EG standard platform category is missing').id;
    const originalTenantRate = first((await withApp(tenant.tenantId, (q) => q.query<{
      id: string;
      effective_from: string;
    }>(`SELECT rate.id, rate.effective_from::text
          FROM tenant_tax_rates rate
          JOIN tenant_tax_categories category ON category.id = rate.tax_category_id
         WHERE rate.tenant_id = $1 AND category.platform_category_id = $2
           AND rate.effective_to IS NULL`, [tenant.tenantId, platformCategory]))).rows,
    'registered tenant standard rate is missing');

    const menuCategoryId = randomUUID();
    const menuItemId = randomUUID();
    await withApp(tenant.tenantId, async (q) => {
      await q.query(
        `INSERT INTO menu_categories (id, tenant_id, name) VALUES ($1, $2, '{"en":"Tax test"}')`,
        [menuCategoryId, tenant.tenantId],
      );
      await q.query(
        `INSERT INTO menu_items
          (id, tenant_id, category_id, name, base_price_amount_minor, base_price_currency_code, tax_rule_id)
         VALUES ($1, $2, $3, '{"en":"Taxed item"}', 1000, $4, $5)`,
        [menuItemId, tenant.tenantId, menuCategoryId, tenant.currency, platformCategory],
      );
    });

    const writeLine: TransactionalOrderLineWriter = async (q, tenantId, input) => {
      const id = randomUUID();
      const inserted = await q.query<{
        id: string;
        branch_id: string;
        menu_item_id: string;
        amount_minor: string;
        currency_code: string;
        amount_basis: 'customer_price' | 'platform_settlement';
      }>(`INSERT INTO tenant_owner_tax_test_lines
          (id, tenant_id, branch_id, menu_item_id, amount_minor, currency_code, amount_basis)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [id, tenantId, input.branchId, input.menuItemId, input.customerAmountMinor.toString(),
        input.currencyCode, input.amountBasis]);
      const line = first(inserted.rows, 'test order line insert returned no row');
      return {
        orderLineId: line.id,
        branchId: line.branch_id,
        menuItemId: line.menu_item_id,
        amountMinor: BigInt(line.amount_minor),
        currencyCode: line.currency_code,
        amountBasis: line.amount_basis,
      };
    };
    const orders = new OrderTaxCoordinator(new PostgresOrderTaxUnitOfWork({
      withTenantContext: withApp,
      writeOrderLine: writeLine,
    }));
    const input: NewTaxableOrderLine = {
      branchId: tenant.branchId,
      menuItemId,
      customerAmountMinor: 1000n,
      currencyCode: tenant.currency,
      at: new Date(),
      salesChannel: 'dine_in',
      deliveryPlatformId: null,
      amountBasis: 'customer_price',
    };
    const taxed = await orders.createLine(tenant.tenantId, input);
    expect(taxed.amountPayableMinor).toBe(1140n);

    const evidence = first((await withApp(tenant.tenantId, (q) => q.query<{
      tax_rate_id: string | null;
      tenant_tax_rate_id: string | null;
      rate_bps_snapshot: number;
      tax_amount_minor: string;
    }>(`SELECT tax_rate_id, tenant_tax_rate_id, rate_bps_snapshot, tax_amount_minor::text
          FROM order_line_tax_snapshots WHERE order_line_id = $1`, [taxed.orderLineId]))).rows,
    'tax snapshot is missing');
    expect(evidence).toEqual({
      tax_rate_id: null,
      tenant_tax_rate_id: originalTenantRate.id,
      rate_bps_snapshot: 1400,
      tax_amount_minor: '140',
    });

    const successor = await withApp(tenant.tenantId, (q) => q.query<{ id: string; rate_bps: number }>(
      `SELECT id, rate_bps
         FROM close_and_supersede_tenant_tax_rate($1, $2, 1500, false, current_date)`,
      [tenant.tenantId, originalTenantRate.id],
    ));
    expect(successor.rows[0]?.rate_bps).toBe(1500);
    const preserved = await withApp(tenant.tenantId, (q) => q.query<{
      tenant_tax_rate_id: string;
      rate_bps_snapshot: number;
      tax_amount_minor: string;
    }>(`SELECT tenant_tax_rate_id, rate_bps_snapshot, tax_amount_minor::text
          FROM order_line_tax_snapshots WHERE order_line_id = $1`, [taxed.orderLineId]));
    expect(preserved.rows[0]).toEqual({
      tenant_tax_rate_id: originalTenantRate.id,
      rate_bps_snapshot: 1400,
      tax_amount_minor: '140',
    });
    await expect(withApp(tenant.tenantId, (q) => q.query(
      'UPDATE order_line_tax_snapshots SET tax_amount_minor = 0 WHERE order_line_id = $1',
      [taxed.orderLineId],
    ))).rejects.toMatchObject({ code: '42501' });
    await expect(withApp(tenant.tenantId, (q) => q.query(
      'SELECT id FROM close_and_supersede_tenant_tax_rate($1, $2, 1600, false, current_date + 1)',
      [tenant.tenantId, originalTenantRate.id],
    ))).rejects.toMatchObject({ code: '55006' });
  });

  it('keeps create_tax_rate, close_and_supersede_tax_rate, and platform_tax_admin unchanged', async () => {
    const category = await platform.createCategory(PLATFORM_ACTOR, {
      countryCode: 'EG',
      code: `platform-regression-${randomUUID()}`,
      kind: 'standard',
      taxFamily: 'vat',
      cascadePriority: 50,
      name: { en: 'Platform regression tax' },
      isActive: true,
    });
    const original = await platform.createTaxRate(PLATFORM_ACTOR, {
      taxCategoryId: category.id,
      rateBps: 900,
      isPriceInclusiveDefault: false,
      effectiveFrom: '2027-01-01',
      effectiveTo: null,
    });
    const successor = await platform.closeAndSupersedeTaxRate(PLATFORM_ACTOR, {
      taxRateId: original.id,
      rateBps: 950,
      isPriceInclusiveDefault: false,
      effectiveFrom: '2027-06-01',
    });
    expect(successor).toMatchObject({ taxCategoryId: category.id, rateBps: 950 });

    const old = await platformPool.query<{ effective_to: string; superseded_by: string }>(
      'SELECT effective_to::text, superseded_by FROM tax_rates WHERE id = $1',
      [original.id],
    );
    expect(old.rows[0]).toEqual({ effective_to: '2027-05-31', superseded_by: successor.id });
    const audit = await platformPool.query<{ scope: string; user_id: string }>(
      `SELECT scope, user_id FROM audit_log
        WHERE resource = ANY($1::text[]) ORDER BY "timestamp"`,
      [[`tax_rates:${original.id}`, `tax_rates:${successor.id}`]],
    );
    expect(audit.rows).toHaveLength(3);
    expect(audit.rows.every((entry) => entry.scope === 'platform_tax' && entry.user_id === PLATFORM_ACTOR)).toBe(true);

    const tenant = await register('AE');
    await expect(withApp(tenant.tenantId, (q) => q.query(
      'SELECT create_tax_rate($1, 100, false, current_date, NULL, $2)',
      [category.id, PLATFORM_ACTOR],
    ))).rejects.toMatchObject({ code: '42501' });
    await expect(withApp(tenant.tenantId, (q) => q.query(
      'SELECT close_and_supersede_tax_rate($1, 100, false, current_date + 1, $2)',
      [successor.id, PLATFORM_ACTOR],
    ))).rejects.toMatchObject({ code: '42501' });
  });
});
