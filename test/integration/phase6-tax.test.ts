/** All acceptance/security/atomicity assertions below use REAL PostgreSQL. */
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CatalogEngine } from '../../src/application/engines/catalog/catalog-engine.ts';
import { OrderTaxCoordinator } from '../../src/application/engines/orders/order-tax-coordinator.ts';
import { AuthorizationEngine } from '../../src/application/engines/rbac/authorization-engine.ts';
import { PlatformTaxAdminEngine } from '../../src/application/engines/tax/platform-tax-admin-engine.ts';
import { TenantTaxAdminEngine } from '../../src/application/engines/tax/tenant-tax-admin-engine.ts';
import { EXCISE_CONFIRMATION_TEXT, TAX_PERMISSION_KEYS, type TenantTaxActor } from '../../src/domain/contracts/tenant-tax-admin.ts';
import { deriveSecV } from '../../src/domain/contracts/sec-v.ts';
import type { NewTaxableOrderLine } from '../../src/domain/contracts/order-tax.ts';
import type { TaxCategory, TaxFamily, TaxLiableParty } from '../../src/domain/contracts/tax.ts';
import { createWithPlatformTaxContext } from '../../src/infrastructure/db/platform-tax-context.ts';
import { createWithTenantContext, type WithTenantContext } from '../../src/infrastructure/db/tenant-context.ts';
import { PostgresCatalogRepository } from '../../src/infrastructure/db/repositories/postgres-catalog-repository.ts';
import { PostgresOrderTaxUnitOfWork, type TransactionalOrderLineWriter } from '../../src/infrastructure/db/repositories/postgres-order-tax-unit-of-work.ts';
import { PostgresPermissionReadRepository } from '../../src/infrastructure/db/repositories/postgres-permission-repository.ts';
import { PostgresPlatformTaxAdminRepository } from '../../src/infrastructure/db/repositories/postgres-platform-tax-admin-repository.ts';
import { PostgresTaxSnapshotReader } from '../../src/infrastructure/db/repositories/postgres-tax-snapshot-reader.ts';
import { PostgresTenantTaxAdminRepository } from '../../src/infrastructure/db/repositories/postgres-tenant-tax-admin-repository.ts';
import { sha256Hex } from '../../src/shared/crypto.ts';
import { ExciseConfirmationRequiredError, ForbiddenError, InvoiceTaxBatchRequiredError, NoApplicableTaxLiabilityRuleError, NoApplicableTaxRateError } from '../../src/shared/errors.ts';
import { currencyCode, money } from '../../src/shared/money.ts';
import { testDatabaseUrl } from '../support/database.ts';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const PLATFORM_ACTOR = '71000000-0000-4000-8000-000000000005';
const AT = new Date('2026-09-07T10:00:00.000Z');
function row<T>(rows: readonly T[]): T { const first = rows[0]; if (first === undefined) throw new Error('Expected database row'); return first; }

describe('Phase 6 live acceptance', () => {
  let owner: pg.Pool; let app: pg.Pool; let platformPool: pg.Pool;
  let withApp: WithTenantContext;
  let platform: PlatformTaxAdminEngine; let admin: TenantTaxAdminEngine;
  let catalog: CatalogEngine; let catalogRepo: PostgresCatalogRepository;
  let tenantRepo: PostgresTenantTaxAdminRepository; let permissionRead: PostgresPermissionReadRepository;
  let reader: PostgresTaxSnapshotReader; let orders: OrderTaxCoordinator;
  let actor: TenantTaxActor; let branchA: string; let branchB: string; let menuCategoryId: string;
  let lastWrittenId: string;
  let writeLine: TransactionalOrderLineWriter;

  beforeAll(async () => {
    owner = new pg.Pool({ connectionString: testDatabaseUrl(), max: 5 });
    for (const file of ['001_app_login.sql', '002_app_login_rbac.sql', '004_app_login_phase4.sql', '005_app_login_catalog.sql', '006_phase6_tax.sql']) {
      await owner.query(await readFile(new URL(`../../migrations/roles/${file}`, import.meta.url), 'utf8'));
    }
    const appPassword = randomBytes(24).toString('hex');
    const platformPassword = randomBytes(24).toString('hex');
    await owner.query(`ALTER ROLE app_login LOGIN PASSWORD '${appPassword}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);
    await owner.query(`ALTER ROLE platform_tax_admin LOGIN PASSWORD '${platformPassword}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);
    const appUrl = new URL(testDatabaseUrl()); appUrl.username = 'app_login'; appUrl.password = appPassword;
    const platformUrl = new URL(testDatabaseUrl()); platformUrl.username = 'platform_tax_admin'; platformUrl.password = platformPassword;
    app = new pg.Pool({ connectionString: appUrl.toString(), max: 5 });
    platformPool = new pg.Pool({ connectionString: platformUrl.toString(), max: 5 });
    withApp = createWithTenantContext(app, { verifyTenantExists: true });
    platform = new PlatformTaxAdminEngine(new PostgresPlatformTaxAdminRepository(createWithPlatformTaxContext(platformPool)));
    tenantRepo = new PostgresTenantTaxAdminRepository(withApp);
    catalogRepo = new PostgresCatalogRepository({ withTenantContext: withApp });
    permissionRead = new PostgresPermissionReadRepository({ withTenantContext: withApp });
    catalog = new CatalogEngine({ catalog: catalogRepo, taxAssignments: tenantRepo, authorization: new AuthorizationEngine({ read: permissionRead, hash: sha256Hex }) });
    admin = new TenantTaxAdminEngine({ repository: tenantRepo, authorization: new AuthorizationEngine({ read: permissionRead, hash: sha256Hex }) });
    reader = new PostgresTaxSnapshotReader(withApp);

    // Test-only stand-in for the FUTURE orders schema. Production code supplies
    // its writer through the same explicit transaction port, not this table.
    await owner.query(`CREATE TABLE phase6_test_order_lines (
      id uuid PRIMARY KEY, tenant_id uuid NOT NULL, branch_id uuid NOT NULL, menu_item_id uuid NOT NULL,
      amount_minor bigint NOT NULL, currency_code text NOT NULL, amount_basis text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now());
      ALTER TABLE phase6_test_order_lines ENABLE ROW LEVEL SECURITY;
      ALTER TABLE phase6_test_order_lines FORCE ROW LEVEL SECURITY;
      CREATE POLICY tenant_isolation ON phase6_test_order_lines FOR ALL
        USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
        WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);
      GRANT SELECT, INSERT ON phase6_test_order_lines TO app_login;`);
    writeLine = async (q, tenantId, input) => {
      lastWrittenId = randomUUID();
      const result = await q.query<{ id: string; branch_id: string; menu_item_id: string; amount_minor: string; currency_code: string; amount_basis: 'customer_price' | 'platform_settlement' }>(
        `INSERT INTO phase6_test_order_lines(id, tenant_id, branch_id, menu_item_id, amount_minor, currency_code, amount_basis)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [lastWrittenId, tenantId, input.branchId, input.menuItemId,
          input.customerAmountMinor.toString(), input.currencyCode, input.amountBasis]);
      const created = row(result.rows);
      return { orderLineId: created.id, branchId: created.branch_id, menuItemId: created.menu_item_id,
        amountMinor: BigInt(created.amount_minor), currencyCode: created.currency_code, amountBasis: created.amount_basis };
    };
    orders = new OrderTaxCoordinator(new PostgresOrderTaxUnitOfWork({ withTenantContext: withApp, writeOrderLine: writeLine }));
  });
  beforeEach(async () => {
    branchA = randomUUID(); branchB = randomUUID();
    const userId = randomUUID(); const roleId = randomUUID();
    await owner.query("UPDATE tenants SET vat_registration_status = 'registered', vat_registration_number = 'fixture-vat' WHERE id = ANY($1::uuid[])", [[A, B]]);
    await platform.configureJurisdiction(PLATFORM_ACTOR, 'SA', 'per_line', true);
    await withApp(A, async (q) => {
      await q.query("INSERT INTO branches(id, tenant_id, name, base_currency, timezone, country_code) VALUES ($1,$2,'tax-a','SAR','Asia/Riyadh','SA')", [branchA, A]);
      await q.query("INSERT INTO users(id, tenant_id, email, password_hash) VALUES ($1,$2,$3,'test-only-hash')", [userId, A, `${userId}@example.test`]);
      await q.query("INSERT INTO roles(id, tenant_id, name) VALUES ($1,$2,'tax-admin-fixture')", [roleId, A]);
      for (const key of [...TAX_PERMISSION_KEYS, 'catalog:write']) await q.query('INSERT INTO role_permissions(tenant_id, role_id, permission_key) VALUES ($1,$2,$3)', [A, roleId, key]);
      await q.query("INSERT INTO user_roles(tenant_id, user_id, role_id, scope_type, scope_id) VALUES ($1,$2,$3,'tenant',NULL)", [A, userId, roleId]);
    });
    await withApp(B, async (q) => { await q.query("INSERT INTO branches(id, tenant_id, name, base_currency, timezone, country_code) VALUES ($1,$2,'tax-b','SAR','Asia/Riyadh','SA')", [branchB, B]); });
    actor = { tenantId: A, userId, tokenSecV: deriveSecV(await permissionRead.listActiveUserRoles(A, userId), await permissionRead.getSecurityVersion(A, userId), sha256Hex) };
    menuCategoryId = (await catalog.createCategory(A, actor.userId, { name: { ar: 'اختبار الضرائب' } })).id;
  });
  afterAll(async () => {
    if (owner !== undefined) {
      await owner.query('DROP TABLE IF EXISTS phase6_test_order_lines');
      await owner.query("UPDATE tax_jurisdictions SET rounding_strategy = 'per_line' WHERE country_code = 'SA'");
    }
    await app?.end(); await platformPool?.end(); await owner?.end();
  });

  async function seedCategory(country = 'SA', code = 'standard'): Promise<string> {
    return row((await owner.query<{ id: string }>('SELECT id FROM tax_categories WHERE country_code = $1 AND code = $2', [country, code])).rows).id;
  }
  async function category(family: TaxFamily = 'vat', country = 'SA', priority = family === 'excise' ? 10 : 50): Promise<TaxCategory> {
    return platform.createCategory(PLATFORM_ACTOR, { countryCode: country, code: randomUUID(), kind: 'standard', taxFamily: family,
      cascadePriority: priority, name: { en: 'Fixture tax' }, isActive: true });
  }
  async function item(taxId: string | null, currency = 'SAR'): Promise<string> {
    return (await catalog.createItem(A, actor.userId, { categoryId: menuCategoryId, name: { ar: 'منتج' }, basePrice: money(1000n, currencyCode(currency)), taxRuleId: taxId })).id;
  }
  function input(menuItemId: string, overrides: Partial<NewTaxableOrderLine> = {}): NewTaxableOrderLine {
    return { branchId: branchA, menuItemId, customerAmountMinor: 1000n, currencyCode: 'SAR', at: AT,
      salesChannel: 'dine_in', deliveryPlatformId: null, amountBasis: 'customer_price', ...overrides };
  }
  async function marketplace(): Promise<string> {
    return (await platform.createDeliveryPlatform(PLATFORM_ACTOR, { code: randomUUID(), name: { en: 'Fixture marketplace' }, countryCode: 'SA', isActive: true })).id;
  }
  async function liability(platformId: string, registered: boolean, party: TaxLiableParty): Promise<void> {
    await platform.createLiabilityRule(PLATFORM_ACTOR, { countryCode: 'SA', salesChannelCode: 'delivery_app', deliveryPlatformId: platformId,
      appliesWhenTenantRegistered: registered, liableParty: party, effectiveFrom: '2020-01-01', effectiveTo: null });
  }
  async function rate(cat: TaxCategory, bps: number, inclusive = false) {
    return platform.createTaxRate(PLATFORM_ACTOR, { taxCategoryId: cat.id, rateBps: bps, isPriceInclusiveDefault: inclusive, effectiveFrom: '2020-01-01', effectiveTo: null });
  }

  it('#1 historical rate changes do not alter earlier immutable snapshots; both changes audited', async () => {
    const cat = await category(); const oldRate = await rate(cat, 500); const product = await item(cat.id);
    const first = await orders.createLine(A, input(product));
    const next = await platform.closeAndSupersedeTaxRate(PLATFORM_ACTOR, { taxRateId: oldRate.id, rateBps: 1500,
      isPriceInclusiveDefault: false, effectiveFrom: '2027-01-01' });
    const second = await orders.createLine(A, input(product, { at: new Date('2027-01-01T10:00:00Z') }));
    expect(await reader.readSnapshots(A, first.orderLineId)).toMatchObject([{ taxRateId: oldRate.id, rateBps: 500, taxAmountMinor: 50n }]);
    expect(await reader.readSnapshots(A, second.orderLineId)).toMatchObject([{ taxRateId: next.id, rateBps: 1500, taxAmountMinor: 150n }]);
    const old = row((await owner.query<{ effective_to: string; superseded_by: string }>('SELECT effective_to::text, superseded_by FROM tax_rates WHERE id = $1', [oldRate.id])).rows);
    expect(old).toEqual({ effective_to: '2026-12-31', superseded_by: next.id });
    const audit = await platformPool.query<{ tenant_id: string | null; scope: string; user_id: string }>("SELECT tenant_id, scope, user_id FROM audit_log WHERE resource = ANY($1::text[])", [[`tax_rates:${oldRate.id}`, `tax_rates:${next.id}`]]);
    expect(audit.rows).toHaveLength(3);
    expect(audit.rows.every((r) => r.scope === 'platform_tax' && r.tenant_id === null && r.user_id === PLATFORM_ACTOR)).toBe(true);
    await expect(withApp(A, async (q) => q.query('UPDATE order_line_tax_snapshots SET tax_amount_minor = 0 WHERE order_line_id = $1', [first.orderLineId]))).rejects.toMatchObject({ code: '42501' });
    await expect(owner.query('UPDATE order_line_tax_snapshots SET tax_amount_minor = 0 WHERE order_line_id = $1', [first.orderLineId])).rejects.toMatchObject({ code: '55006' });
  });

  it('#2 PostgreSQL EXCLUDE GIST rejects overlapping and touching closed intervals', async () => {
    const cat = await category();
    await platform.createTaxRate(PLATFORM_ACTOR, { taxCategoryId: cat.id, rateBps: 500, isPriceInclusiveDefault: false, effectiveFrom: '2025-01-01', effectiveTo: '2025-12-31' });
    await expect(platform.createTaxRate(PLATFORM_ACTOR, { taxCategoryId: cat.id, rateBps: 600, isPriceInclusiveDefault: false, effectiveFrom: '2025-12-31', effectiveTo: null })).rejects.toMatchObject({ code: '23P01' });
    await expect(platform.createTaxRate(PLATFORM_ACTOR, { taxCategoryId: cat.id, rateBps: 600, isPriceInclusiveDefault: false, effectiveFrom: '2026-01-01', effectiveTo: null })).resolves.toMatchObject({ rateBps: 600 });
  });

  it('#3 Kuwait no_vat is always zero; triggers reject rate/end and category-identity bypasses', async () => {
    await admin.setVatRegistration(actor, 'unregistered', null);
    await owner.query("UPDATE branches SET country_code = 'KW', base_currency = 'KWD', timezone = 'Asia/Kuwait' WHERE id = $1", [branchA]);
    const noVat = await seedCategory('KW', 'no_vat'); const product = await item(noVat, 'KWD');
    const result = await orders.createLine(A, input(product, { currencyCode: 'KWD', customerAmountMinor: 123456789n }));
    expect(await reader.readSnapshots(A, result.orderLineId)).toMatchObject([{ currencyCode: 'KWD', rateBps: 0, taxAmountMinor: 0n, taxableAmountMinor: 123456789n }]);
    for (const [bps, end] of [[1, null], [0, '2026-12-31']] as const) {
      await expect(platform.createTaxRate(PLATFORM_ACTOR, { taxCategoryId: noVat, rateBps: bps, isPriceInclusiveDefault: false,
        effectiveFrom: '2027-01-01', effectiveTo: end })).rejects.toThrow();
    }
    const kwRate = row((await owner.query<{ id: string }>('SELECT id FROM tax_rates WHERE tax_category_id = $1', [noVat])).rows).id;
    await expect(platform.closeAndSupersedeTaxRate(PLATFORM_ACTOR, { taxRateId: kwRate, rateBps: 0, isPriceInclusiveDefault: false, effectiveFrom: '2027-01-01' })).rejects.toThrow(/no_vat/);
    await expect(owner.query("UPDATE tax_categories SET kind = 'standard' WHERE id = $1", [noVat])).rejects.toMatchObject({ code: '55006' });
  });

  it('#4 inclusive/exclusive and half-up persist the manually precomputed minor units', async () => {
    const inc = await category(); await rate(inc, 1500, true);
    const included = await orders.createLine(A, input(await item(inc.id), { customerAmountMinor: 1150n }));
    expect(await reader.readSnapshots(A, included.orderLineId)).toMatchObject([{ taxableAmountMinor: 1000n, taxAmountMinor: 150n, isPriceInclusive: true }]);
    expect(included.amountPayableMinor).toBe(1150n);
    const ex = await category(); await rate(ex, 500);
    const excluded = await orders.createLine(A, input(await item(ex.id), { customerAmountMinor: 10n }));
    expect(await reader.readSnapshots(A, excluded.orderLineId)).toMatchObject([{ taxableAmountMinor: 10n, taxAmountMinor: 1n }]);
    expect(excluded.amountPayableMinor).toBe(11n);
  });

  it('#5 same-country branch override works; cross-country target and subsequent branch-country mutation fail', async () => {
    const source = await seedCategory(); const replacement = await category(); await rate(replacement, 500);
    const product = await item(source);
    await admin.setBranchOverride(actor, { branchId: branchA, menuItemTaxCategoryId: source, overrideTaxCategoryId: replacement.id });
    const result = await orders.createLine(A, input(product));
    expect(await reader.readSnapshots(A, result.orderLineId)).toMatchObject([{ rateBps: 500, taxAmountMinor: 50n }]);
    const wrong = await seedCategory('AE');
    await expect(admin.setBranchOverride(actor, { branchId: branchA, menuItemTaxCategoryId: source, overrideTaxCategoryId: wrong })).rejects.toThrow(/country/);
    await expect(withApp(A, async (q) => q.query('UPDATE branch_tax_category_overrides SET override_tax_category_id = $1 WHERE branch_id = $2', [wrong, branchA]))).rejects.toMatchObject({ code: '23514' });
    await expect(owner.query("UPDATE branches SET country_code = 'AE' WHERE id = $1", [branchA])).rejects.toMatchObject({ code: '23514' });
  });

  it('#6 missing applicable rate explicitly rejects and rolls back order line and context', async () => {
    const product = await item((await category()).id);
    await expect(orders.createLine(A, input(product))).rejects.toBeInstanceOf(NoApplicableTaxRateError);
    expect((await owner.query('SELECT 1 FROM phase6_test_order_lines WHERE id = $1', [lastWrittenId])).rowCount).toBe(0);
    expect(await reader.readContext(A, lastWrittenId)).toBeNull();
  });

  it('#7 RLS isolates overrides, additional assignments, confirmations, contexts and snapshots', async () => {
    const source = await seedCategory(); const target = await category(); await rate(target, 500);
    const product = await item(source);
    await admin.setBranchOverride(actor, { branchId: branchA, menuItemTaxCategoryId: source, overrideTaxCategoryId: target.id });
    const excise = await seedCategory('SA', 'excise_100');
    await admin.confirmExciseAssignment(actor, { menuItemId: product, taxCategoryId: excise, slot: 'additional', confirmation: EXCISE_CONFIRMATION_TEXT });
    const result = await orders.createLine(A, input(product));
    expect(await reader.readContext(B, result.orderLineId)).toBeNull();
    expect(await reader.readSnapshots(B, result.orderLineId)).toEqual([]);
    await withApp(B, async (q) => {
      for (const table of ['branch_tax_category_overrides', 'menu_item_additional_tax_categories', 'menu_item_excise_confirmations']) {
        const predicate = table === 'branch_tax_category_overrides' ? 'branch_id' : 'menu_item_id';
        expect((await q.query(`SELECT * FROM ${table} WHERE ${predicate} = $1`, [table === 'branch_tax_category_overrides' ? branchA : product])).rowCount).toBe(0);
      }
      expect((await q.query('UPDATE branch_tax_category_overrides SET override_tax_category_id = $1 WHERE branch_id = $2', [source, branchA])).rowCount).toBe(0);
    });
    await expect(withApp(B, async (q) => q.query('INSERT INTO menu_item_additional_tax_categories(menu_item_id,tax_category_id) VALUES ($1,$2)', [product, target.id]))).rejects.toThrow(/row-level security/);
    await expect(withApp(B, async (q) => q.query('INSERT INTO branch_tax_category_overrides(tenant_id,branch_id,menu_item_tax_category_id,override_tax_category_id) VALUES ($1,$2,$3,$4)', [B, branchA, source, target.id]))).rejects.toThrow();
    expect(await reader.readSnapshots(A, result.orderLineId)).toHaveLength(2);
  });

  it('#8 tenant credentials can NEVER write any global tax table or call the platform functions', async () => {
    for (const table of ['tax_jurisdictions', 'tax_categories', 'tax_rates', 'sales_channels', 'delivery_platforms', 'tax_liability_rules']) {
      await expect(withApp(A, async (q) => q.query(`DELETE FROM ${table}`))).rejects.toMatchObject({ code: '42501' });
    }
    await expect(withApp(A, async (q) => q.query("INSERT INTO tax_jurisdictions(country_code,name,default_currency_code) VALUES ('ZZ','{}','SAR')"))).rejects.toMatchObject({ code: '42501' });
    await expect(withApp(A, async (q) => q.query('UPDATE tax_rates SET rate_bps = 0'))).rejects.toMatchObject({ code: '42501' });
    await expect(withApp(A, async (q) => q.query('SELECT create_tax_rate($1,100,false,current_date,NULL,$2)', [await seedCategory(), PLATFORM_ACTOR]))).rejects.toMatchObject({ code: '42501' });
    await expect(withApp(A, async (q) => q.query('SET LOCAL ROLE platform_tax_admin'))).rejects.toMatchObject({ code: '42501' });
    const impersonation = new PlatformTaxAdminEngine(new PostgresPlatformTaxAdminRepository(createWithPlatformTaxContext(app)));
    await expect(impersonation.createCategory(PLATFORM_ACTOR, { countryCode: 'SA', code: randomUUID(), kind: 'standard', taxFamily: 'vat',
      cascadePriority: 50, name: { en: 'Attack' }, isActive: true })).rejects.toBeInstanceOf(ForbiddenError);
    const visible = await withApp(A, async (q) => q.query("SELECT * FROM audit_log WHERE scope = 'platform_tax'"));
    expect(visible.rowCount).toBe(0);
  });

  it('#9 unregistered restaurant + marketplace liability yields marker only, never restaurant tax invoice', async () => {
    const id = await marketplace(); await liability(id, false, 'marketplace');
    await admin.setVatRegistration(actor, 'unregistered', null);
    const result = await orders.createLine(A, input(await item(null), { salesChannel: 'delivery_app', deliveryPlatformId: id }));
    expect(result.taxes).toMatchObject({ kind: 'external_tax_liability', liableParty: 'marketplace', restaurantTaxInvoiceAllowed: false });
    expect(result.restaurantTaxInvoiceAllowed).toBe(false);
    expect(await reader.readSnapshots(A, result.orderLineId)).toEqual([]);
    expect(await reader.readContext(A, result.orderLineId)).toMatchObject({ liableParty: 'marketplace', deliveryPlatformId: id, grossOrNetAmountMinor: 1000n });
  });

  it('#10 same platform + registered restaurant is responsible and computes normally', async () => {
    const id = await marketplace(); await liability(id, false, 'marketplace'); await liability(id, true, 'restaurant');
    const result = await orders.createLine(A, input(await item(await seedCategory()), { salesChannel: 'delivery_app', deliveryPlatformId: id }));
    expect(result.restaurantTaxInvoiceAllowed).toBe(true);
    expect(await reader.readSnapshots(A, result.orderLineId)).toMatchObject([{ liableParty: 'restaurant', taxAmountMinor: 150n }]);
  });

  it('#11 confirmed excise + VAT: 1000 + 1000 + 300 = 2300; two snapshots share line and transaction', async () => {
    const product = await item(await seedCategory()); const excise = await seedCategory('SA', 'excise_100');
    await admin.confirmExciseAssignment(actor, { menuItemId: product, taxCategoryId: excise, slot: 'additional', confirmation: EXCISE_CONFIRMATION_TEXT });
    const result = await orders.createLine(A, input(product));
    expect(result.amountPayableMinor).toBe(2300n);
    expect(await reader.readSnapshots(A, result.orderLineId)).toMatchObject([
      { orderLineId: result.orderLineId, taxFamily: 'excise', computationSequence: 1, taxableAmountMinor: 1000n, taxAmountMinor: 1000n },
      { orderLineId: result.orderLineId, taxFamily: 'vat', computationSequence: 2, taxableAmountMinor: 2000n, taxAmountMinor: 300n },
    ]);
    const transactions = await owner.query<{ line_tx: string; tax_tx: string; context_tx: string }>(`SELECT l.xmin::text AS line_tx, s.xmin::text AS tax_tx, c.xmin::text AS context_tx
      FROM phase6_test_order_lines l JOIN order_line_tax_contexts c ON c.order_line_id = l.id
      JOIN order_line_tax_snapshots s ON s.order_line_id = l.id WHERE l.id = $1`, [result.orderLineId]);
    expect(transactions.rows).toHaveLength(2);
    expect(transactions.rows.every((r) => r.line_tx === r.tax_tx && r.line_tx === r.context_tx)).toBe(true);
  });

  it('#12 VAT-only, including a product named energy drink, has exactly one VAT row', async () => {
    const product = await item(await seedCategory()); await catalog.updateItem(A, actor.userId, product, { name: { en: 'Energy drink', ar: 'مشروب غازي' } });
    const result = await orders.createLine(A, input(product));
    const snapshots = await reader.readSnapshots(A, result.orderLineId);
    expect(snapshots).toHaveLength(1); expect(snapshots[0]?.taxFamily).toBe('vat'); expect(result.amountPayableMinor).toBe(1150n);
  });

  it('#13 every ordinary catalog/additional/SQL path rejects excise; only explicit admin confirmation can attach it', async () => {
    const product = await item(await seedCategory()); const excise = await seedCategory('SA', 'excise_100');
    await expect(item(excise)).rejects.toBeInstanceOf(ExciseConfirmationRequiredError);
    await expect(catalog.updateItem(A, actor.userId, product, { taxRuleId: excise })).rejects.toBeInstanceOf(ExciseConfirmationRequiredError);
    await expect(admin.assignAdditionalCategory(actor, product, excise)).rejects.toBeInstanceOf(ExciseConfirmationRequiredError);
    await expect(withApp(A, async (q) => q.query('UPDATE menu_items SET tax_rule_id = $1 WHERE id = $2', [excise, product]))).rejects.toMatchObject({ code: '42501' });
    await expect(withApp(A, async (q) => q.query('INSERT INTO menu_item_additional_tax_categories VALUES ($1,$2)', [product, excise]))).rejects.toMatchObject({ code: '42501' });
    await expect(admin.confirmExciseAssignment(actor, { menuItemId: product, taxCategoryId: excise, slot: 'additional', confirmation: 'yes' })).rejects.toBeInstanceOf(ExciseConfirmationRequiredError);
    await admin.confirmExciseAssignment(actor, { menuItemId: product, taxCategoryId: excise, slot: 'additional', confirmation: EXCISE_CONFIRMATION_TEXT });
    // Prior evidence never turns the general SQL path into an approved path.
    await expect(withApp(A, async (q) => q.query('INSERT INTO menu_item_additional_tax_categories VALUES ($1,$2) ON CONFLICT DO NOTHING', [product, excise]))).rejects.toMatchObject({ code: '42501' });
    const confirmations = await withApp(A, async (q) => q.query('SELECT * FROM menu_item_excise_confirmations WHERE menu_item_id = $1', [product]));
    expect(confirmations.rowCount).toBe(1);
    expect((await withApp(A, async (q) => q.query("SELECT * FROM audit_log WHERE action = 'tax:confirm_excise' AND resource = $1", [`menu_items:${product}`]))).rowCount).toBe(1);
  });

  it('#14 separate NOT NULL migration requires opt-in, fails with one NULL, succeeds only after complete backfill', async () => {
    const sql = await readFile(new URL('../../migrations/0013_phase6_branch_country_not_null.sql', import.meta.url), 'utf8');
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      await client.query('ALTER TABLE branches ALTER COLUMN country_code DROP NOT NULL');
      await client.query("INSERT INTO branches(tenant_id,name,base_currency,timezone,country_code) VALUES ($1,'not-backfilled','SAR','UTC',NULL)", [A]);
      await client.query('SAVEPOINT gate');
      await expect(client.query(sql)).rejects.toThrow(/Confirm branch-country/);
      await client.query('ROLLBACK TO SAVEPOINT gate');
      await client.query("SELECT set_config('app.phase6_branch_country_backfill_confirmed','true',true)");
      await client.query('SAVEPOINT incomplete');
      await expect(client.query(sql)).rejects.toMatchObject({ code: '23502' });
      await client.query('ROLLBACK TO SAVEPOINT incomplete');
      await client.query("UPDATE branches SET country_code = 'SA' WHERE country_code IS NULL");
      await client.query(sql);
      expect(row((await client.query<{ attnotnull: boolean }>("SELECT attnotnull FROM pg_attribute WHERE attrelid = 'branches'::regclass AND attname = 'country_code'")).rows).attnotnull).toBe(true);
    } finally { await client.query('ROLLBACK'); client.release(); }
  });

  it('missing delivery liability rule rejects; no automatic restaurant/zero fallback', async () => {
    await expect(orders.createLine(A, input(await item(await seedCategory()), { salesChannel: 'delivery_app', deliveryPlatformId: await marketplace() }))).rejects.toBeInstanceOf(NoApplicableTaxLiabilityRuleError);
  });

  it('order boundary rejects commission-net settlement before any order/snapshot can commit', async () => {
    const product = await item(await seedCategory());
    await expect(orders.createLine(A, input(product, { amountBasis: 'platform_settlement', customerAmountMinor: 700n }))).rejects.toThrow(/full customer price/);
    const corrupt = new OrderTaxCoordinator(new PostgresOrderTaxUnitOfWork({ withTenantContext: withApp, writeOrderLine: async (q, tid, request) => {
      const written = await writeLine(q, tid, request); return { ...written, amountMinor: 700n, amountBasis: 'platform_settlement' };
    } }));
    await expect(corrupt.createLine(A, input(product))).rejects.toThrow(/Persisted order line/);
    expect((await owner.query('SELECT 1 FROM phase6_test_order_lines WHERE id = $1', [lastWrittenId])).rowCount).toBe(0);
  });

  it('a failure on the SECOND tax snapshot rolls back BOTH taxes, the context, and the order line', async () => {
    const product = await item(await seedCategory());
    await admin.confirmExciseAssignment(actor, { menuItemId: product, taxCategoryId: await seedCategory('SA', 'excise_100'), slot: 'additional', confirmation: EXCISE_CONFIRMATION_TEXT });
    await owner.query(`CREATE FUNCTION phase6_reject_vat() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.tax_family = 'vat' THEN RAISE EXCEPTION 'injected second snapshot failure'; END IF; RETURN NEW; END; $$;
      CREATE TRIGGER phase6_reject_vat BEFORE INSERT ON order_line_tax_snapshots FOR EACH ROW EXECUTE FUNCTION phase6_reject_vat();`);
    try {
      await expect(orders.createLine(A, input(product))).rejects.toThrow(/second snapshot failure/);
      expect((await owner.query('SELECT 1 FROM phase6_test_order_lines WHERE id = $1', [lastWrittenId])).rowCount).toBe(0);
      expect(await reader.readContext(A, lastWrittenId)).toBeNull();
      expect(await reader.readSnapshots(A, lastWrittenId)).toEqual([]);
    } finally { await owner.query('DROP TRIGGER phase6_reject_vat ON order_line_tax_snapshots; DROP FUNCTION phase6_reject_vat();'); }
  });

  it('audit failure rolls back the closed interval, successor, and any audit writes', async () => {
    const cat = await category(); const original = await rate(cat, 500);
    await owner.query(`CREATE FUNCTION phase6_reject_platform_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.scope = 'platform_tax' THEN RAISE EXCEPTION 'injected audit failure'; END IF; RETURN NEW; END; $$;
      CREATE TRIGGER phase6_reject_platform_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION phase6_reject_platform_audit();`);
    try {
      await expect(platform.closeAndSupersedeTaxRate(PLATFORM_ACTOR, { taxRateId: original.id, rateBps: 1500, isPriceInclusiveDefault: false, effectiveFrom: '2027-01-01' })).rejects.toThrow(/audit failure/);
      expect((await owner.query('SELECT 1 FROM tax_rates WHERE tax_category_id = $1', [cat.id])).rowCount).toBe(1);
      expect(row((await owner.query<{ effective_to: unknown; superseded_by: unknown }>('SELECT effective_to, superseded_by FROM tax_rates WHERE id = $1', [original.id])).rows)).toEqual({ effective_to: null, superseded_by: null });
    } finally { await owner.query('DROP TRIGGER phase6_reject_platform_audit ON audit_log; DROP FUNCTION phase6_reject_platform_audit();'); }
  });

  it('concurrent closeAndSupersede calls serialize: exactly one successor, no lost updates', async () => {
    const original = await rate(await category(), 500);
    const attempts = await Promise.allSettled([1000, 1500].map((bps) => platform.closeAndSupersedeTaxRate(PLATFORM_ACTOR, {
      taxRateId: original.id, rateBps: bps, isPriceInclusiveDefault: false, effectiveFrom: '2027-01-01' })));
    expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((a) => a.status === 'rejected')).toHaveLength(1);
    expect((await owner.query('SELECT 1 FROM tax_rates WHERE tax_category_id = $1', [original.taxCategoryId])).rowCount).toBe(2);
    await expect(platformPool.query('UPDATE tax_rates SET rate_bps = 999 WHERE id = $1', [original.id])).rejects.toMatchObject({ code: '42501' });
  });

  it('invoice_total is genuinely rounded once and persists deterministic allocations', async () => {
    const cat = await category(); await rate(cat, 500); const product = await item(cat.id);
    await platform.configureJurisdiction(PLATFORM_ACTOR, 'SA', 'invoice_total', true);
    await expect(orders.createLine(A, input(product, { customerAmountMinor: 10n }))).rejects.toBeInstanceOf(InvoiceTaxBatchRequiredError);
    const results = await orders.createInvoice(A, [input(product, { customerAmountMinor: 10n }), input(product, { customerAmountMinor: 10n })]);
    const snapshots = (await Promise.all(results.map((r) => reader.readSnapshots(A, r.orderLineId)))).flat();
    expect(snapshots.reduce((sum, r) => sum + r.taxAmountMinor, 0n)).toBe(1n);
    expect(snapshots.sort((a, b) => a.orderLineId.localeCompare(b.orderLineId)).map((r) => r.taxAmountMinor)).toEqual([1n, 0n]);
  });

  it('sensitive excise permission is rechecked; inactive or unauthorized actor cannot confirm', async () => {
    const product = await item(await seedCategory()); const excise = await seedCategory('SA', 'excise_100');
    await owner.query('UPDATE users SET is_active = false WHERE id = $1', [actor.userId]);
    await expect(admin.confirmExciseAssignment(actor, { menuItemId: product, taxCategoryId: excise, slot: 'additional', confirmation: EXCISE_CONFIRMATION_TEXT })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(withApp(A, async (q) => q.query("SELECT confirm_menu_item_excise($1,$2,'additional',$3,$4)", [product, excise, actor.userId, EXCISE_CONFIRMATION_TEXT]))).rejects.toMatchObject({ code: '42501' });
  });
  it.each([
    ['EG', 'standard', 'EGP', 140n], ['EG', 'reduced', 'EGP', 50n],
    ['EG', 'zero_rated', 'EGP', 0n], ['EG', 'exempt', 'EGP', 0n],
    ['AE', 'standard', 'AED', 50n], ['AE', 'zero_rated', 'AED', 0n],
  ] as const)('launch data %s/%s computes 1000 %s minor units with tax %s', async (country, code, currency, expectedTax) => {
    await owner.query('UPDATE branches SET country_code = $2, base_currency = $3 WHERE id = $1', [branchA, country, currency]);
    const result = await orders.createLine(A, input(await item(await seedCategory(country, code), currency), { currencyCode: currency }));
    expect(await reader.readSnapshots(A, result.orderLineId)).toMatchObject([{ taxableAmountMinor: 1000n, taxAmountMinor: expectedTax, currencyCode: currency }]);
  });

  it('confirmed primary excise works; ordinary catalog name edits preserve it without new consent', async () => {
    const vat = await seedCategory(); const excise = await seedCategory('SA', 'excise_100'); const product = await item(vat);
    await admin.confirmExciseAssignment(actor, { menuItemId: product, taxCategoryId: excise, slot: 'primary', confirmation: EXCISE_CONFIRMATION_TEXT });
    await catalog.updateItem(A, actor.userId, product, { name: { ar: 'اسم جديد' } });
    await admin.assignAdditionalCategory(actor, product, vat);
    const result = await orders.createLine(A, input(product));
    expect(result.amountPayableMinor).toBe(2300n);
    expect(await reader.readSnapshots(A, result.orderLineId)).toMatchObject([{ taxFamily: 'excise', taxAmountMinor: 1000n }, { taxFamily: 'vat', taxAmountMinor: 300n }]);
  });

  it('excise branch overrides require exact affected-item confirmation, including later newly assigned products', async () => {
    const vat = await seedCategory(); const source = await category('excise'); await rate(source, 10000);
    const excise = source.id; const target = await category('excise'); await rate(target, 5000);
    const product = await item(vat);
    await admin.confirmExciseAssignment(actor, { menuItemId: product, taxCategoryId: excise, slot: 'additional', confirmation: EXCISE_CONFIRMATION_TEXT });
    const override = { branchId: branchA, menuItemTaxCategoryId: excise, overrideTaxCategoryId: target.id };
    await expect(admin.setBranchOverride(actor, override)).rejects.toBeInstanceOf(ExciseConfirmationRequiredError);
    await admin.confirmExciseBranchOverride(actor, { ...override, confirmation: EXCISE_CONFIRMATION_TEXT, confirmedMenuItemIds: [product] });
    const result = await orders.createLine(A, input(product));
    expect(result.amountPayableMinor).toBe(1725n); // 1000 + 500 + (1500 * 15%)
    const addedLater = await item(vat);
    await admin.confirmExciseAssignment(actor, { menuItemId: addedLater, taxCategoryId: excise, slot: 'additional', confirmation: EXCISE_CONFIRMATION_TEXT });
    await expect(orders.createLine(A, input(addedLater))).rejects.toBeInstanceOf(ExciseConfirmationRequiredError);
    await expect(admin.confirmExciseBranchOverride(actor, { ...override, confirmation: EXCISE_CONFIRMATION_TEXT, confirmedMenuItemIds: [product] })).rejects.toMatchObject({ code: '23514' });
    await admin.confirmExciseBranchOverride(actor, { ...override, confirmation: EXCISE_CONFIRMATION_TEXT, confirmedMenuItemIds: [product, addedLater] });
    expect((await orders.createLine(A, input(addedLater))).amountPayableMinor).toBe(1725n);
  });

  it('PostgreSQL refuses a restaurant context with no snapshots and a forged marketplace snapshot', async () => {
    const normal = await orders.createLine(A, input(await item(await seedCategory())));
    const incompleteId = randomUUID();
    await expect(withApp(A, async (q) => q.query(`INSERT INTO order_line_tax_contexts
      (order_line_id,tenant_id,branch_id,menu_item_id,customer_amount_minor,currency_code,sales_channel_code,
       delivery_platform_id,liability_rule_id,liable_party,rounding_strategy,occurred_at)
      SELECT $1,tenant_id,branch_id,menu_item_id,customer_amount_minor,currency_code,sales_channel_code,
       delivery_platform_id,liability_rule_id,liable_party,rounding_strategy,occurred_at
      FROM order_line_tax_contexts WHERE order_line_id = $2`, [incompleteId, normal.orderLineId]))).rejects.toMatchObject({ code: '23514' });
    expect(await reader.readContext(A, incompleteId)).toBeNull();
    const id = await marketplace(); await liability(id, true, 'marketplace');
    const external = await orders.createLine(A, input(await item(null), { salesChannel: 'delivery_app', deliveryPlatformId: id }));
    await expect(withApp(A, async (q) => q.query(`INSERT INTO order_line_tax_snapshots
      (order_line_id,tax_rate_id,tax_family,computation_sequence,liable_party,rate_bps_snapshot,
       is_price_inclusive_snapshot,taxable_amount_minor,tax_amount_minor,currency_code)
      SELECT $1,tax_rate_id,tax_family,computation_sequence,liable_party,rate_bps_snapshot,
       is_price_inclusive_snapshot,taxable_amount_minor,tax_amount_minor,currency_code
      FROM order_line_tax_snapshots WHERE order_line_id = $2`, [external.orderLineId, normal.orderLineId]))).rejects.toMatchObject({ code: '23514' });
    await expect(owner.query('DELETE FROM order_line_tax_snapshots WHERE order_line_id = $1', [normal.orderLineId])).rejects.toMatchObject({ code: '55006' });
  });

  it('wildcard liability intervals cannot overlap; an exact platform rule takes precedence over a wildcard', async () => {
    const channel = await platform.createSalesChannel(PLATFORM_ACTOR, { code: `custom-${randomUUID()}`, name: { en: 'Custom channel' }, requiresDeliveryPlatform: true });
    const id = await marketplace();
    const base = { countryCode: 'SA', salesChannelCode: channel.code, deliveryPlatformId: null,
      appliesWhenTenantRegistered: true, liableParty: 'restaurant' as const, effectiveFrom: '2020-01-01', effectiveTo: null };
    await platform.createLiabilityRule(PLATFORM_ACTOR, base);
    await expect(platform.createLiabilityRule(PLATFORM_ACTOR, { ...base, effectiveFrom: '2021-01-01' })).rejects.toMatchObject({ code: '23P01' });
    await platform.createLiabilityRule(PLATFORM_ACTOR, { ...base, deliveryPlatformId: id, liableParty: 'marketplace' });
    const result = await orders.createLine(A, input(await item(null), { salesChannel: channel.code, deliveryPlatformId: id }));
    expect(result.taxes).toMatchObject({ kind: 'external_tax_liability', liableParty: 'marketplace' });
  });

  it('order tax transaction sees a consistent rate history during a concurrent administrative change', async () => {
    const original = await rate(await category(), 500);
    const uow = new PostgresOrderTaxUnitOfWork({ withTenantContext: withApp, writeOrderLine: writeLine });
    await uow.run(A, async (scope) => {
      expect((await scope.tax.getApplicableRate(original.taxCategoryId, '2027-01-01'))?.rateBps).toBe(500);
      await platform.closeAndSupersedeTaxRate(PLATFORM_ACTOR, { taxRateId: original.id, rateBps: 1500, isPriceInclusiveDefault: false, effectiveFrom: '2027-01-01' });
      expect((await scope.tax.getApplicableRate(original.taxCategoryId, '2027-01-01'))?.rateBps).toBe(500);
    });
    await uow.run(A, async (scope) => {
      expect((await scope.tax.getApplicableRate(original.taxCategoryId, '2027-01-01'))?.rateBps).toBe(1500);
    });
  });

});
