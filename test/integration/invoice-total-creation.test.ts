/**
 * B4 — invoice_total order creation (LIVE, real PostgreSQL).
 *
 * Before the fix, order creation resolved tax line-by-line inside the item
 * loop — and isolated resolution THROWS `InvoiceTaxBatchRequiredError` for
 * `invoice_total` jurisdictions (the rounded unit is the invoice sum, not
 * the line). Creating ANY order in such a jurisdiction was impossible.
 *
 * The fix collects every line and resolves the COMPLETE invoice in ONE
 * batched call after all items exist. These tests prove, on a real database:
 *
 * - T1 (allocation proof): a two-line order (2 × 10 minor @ 5% VAT) succeeds
 *   where pre-fix creation threw. Isolated per-line rounding would give
 *   1 + 1 = 2; the invoice sum rounds ONCE to 1, allocated largest-remainder
 *   [1, 0] by line-UUID order — pinned both on the returned resolutions AND
 *   on the durable snapshot rows.
 * - T2 (degenerate batch): a single-line order converges through the same
 *   batch path (batch-of-1 ≡ the per-line value).
 *
 * per_line parity is proven by the rest of the suite: every existing
 * creation test runs through the same uniform batch call.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CatalogEngine } from '../../src/application/engines/catalog/catalog-engine.ts';
import { OrderCreationEngine } from '../../src/application/engines/orders/order-creation-engine.ts';
import { WorkflowAdminEngine } from '../../src/application/engines/orders/workflow-admin-engine.ts';
import { AuthorizationEngine } from '../../src/application/engines/rbac/authorization-engine.ts';
import { ShiftEngine } from '../../src/application/engines/shifts/shift-engine.ts';
import { isExternalTaxLiability } from '../../src/application/engines/tax/tax-resolution-engine.ts';
import { PlatformTaxAdminEngine } from '../../src/application/engines/tax/platform-tax-admin-engine.ts';
import { createWithTenantContext, type WithTenantContext } from '../../src/infrastructure/db/tenant-context.ts';
import { createWithPlatformTaxContext } from '../../src/infrastructure/db/platform-tax-context.ts';
import { PostgresCatalogRepository } from '../../src/infrastructure/db/repositories/postgres-catalog-repository.ts';
import { PostgresManagerOverrideAuthenticator } from '../../src/infrastructure/db/repositories/postgres-manager-override-authenticator.ts';
import { PostgresOrdersStore } from '../../src/infrastructure/db/repositories/postgres-orders-store.ts';
import { PostgresPermissionReadRepository, PostgresPermissionWriteRepository } from '../../src/infrastructure/db/repositories/postgres-permission-repository.ts';
import { PostgresPlatformTaxAdminRepository } from '../../src/infrastructure/db/repositories/postgres-platform-tax-admin-repository.ts';
import { PostgresShiftsStore } from '../../src/infrastructure/db/repositories/postgres-shifts-store.ts';
import { PostgresTenantTaxAdminRepository } from '../../src/infrastructure/db/repositories/postgres-tenant-tax-admin-repository.ts';
import type { TaxResolution } from '../../src/domain/contracts/tax.ts';
import { hashPin } from '../../src/shared/auth/pin.ts';
import { sha256Hex } from '../../src/shared/crypto.ts';
import { currencyCode, money } from '../../src/shared/money.ts';
import { testDatabaseUrl } from '../support/database.ts';
import { grantKeys } from '../support/grant-keys.ts';

const PLATFORM_ACTOR = '71000000-0000-4000-8000-000000000005';
let T: string; // dedicated B4 tenant (fresh per run)
const PIN_PEPPER = Buffer.from(randomBytes(48));

function restaurantTaxOf(taxes: TaxResolution): bigint {
  if (isExternalTaxLiability(taxes)) throw new Error('Expected restaurant tax lines');
  return taxes.reduce((sum, line) => sum + line.taxAmountMinor, 0n);
}

interface TillUser {
  readonly userId: string;
}

describe('B4 invoice_total creation (live)', () => {
  let owner: pg.Pool;
  let app: pg.Pool;
  let platformPool: pg.Pool;
  let withApp: WithTenantContext;
  let creation: OrderCreationEngine;
  let shifts: ShiftEngine;
  let itemId: string; // 10 minor SAR; 5% VAT ⇒ per-line 1, invoice pair 1
  let opener: TillUser;
  let verifier: TillUser;

  beforeAll(async () => {
    owner = new pg.Pool({ connectionString: testDatabaseUrl(), max: 5 });
    T = randomUUID();
    await owner.query('INSERT INTO tenants (id, name) VALUES ($1, $2)', [T, 'b4-invoice-total']);
    for (const file of [
      '001_app_login.sql', '002_app_login_rbac.sql', '004_app_login_phase4.sql', '005_app_login_catalog.sql',
      '006_phase6_tax.sql', '007_phase7_orders.sql', '008_phase7_manager_override_rate_limiting.sql',
      '009_phase8_payments.sql', '010_phase9_inventory.sql',
    ]) {
      await owner.query(await readFile(new URL(`../../migrations/roles/${file}`, import.meta.url), 'utf8'));
    }
    const appPassword = randomBytes(24).toString('hex');
    const platformPassword = randomBytes(24).toString('hex');
    await owner.query(`ALTER ROLE app_login LOGIN PASSWORD '${appPassword}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);
    await owner.query(`ALTER ROLE platform_tax_admin LOGIN PASSWORD '${platformPassword}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);
    const appUrl = new URL(testDatabaseUrl());
    appUrl.username = 'app_login';
    appUrl.password = appPassword;
    const platformUrl = new URL(testDatabaseUrl());
    platformUrl.username = 'platform_tax_admin';
    platformUrl.password = platformPassword;
    app = new pg.Pool({ connectionString: appUrl.toString(), max: 5 });
    platformPool = new pg.Pool({ connectionString: platformUrl.toString(), max: 5 });
    withApp = createWithTenantContext(app, { verifyTenantExists: true });

    const authorization = new AuthorizationEngine({ read: new PostgresPermissionReadRepository({ withTenantContext: withApp }), hash: sha256Hex });
    const catalog = new CatalogEngine({ catalog: new PostgresCatalogRepository({ withTenantContext: withApp }), taxAssignments: new PostgresTenantTaxAdminRepository(withApp), authorization });
    const ordersStore = new PostgresOrdersStore({ withTenantContext: withApp });
    shifts = new ShiftEngine({ store: new PostgresShiftsStore({ withTenantContext: withApp }), authorization });
    const authenticator = new PostgresManagerOverrideAuthenticator({ withTenantContext: withApp, pepper: PIN_PEPPER });
    creation = new OrderCreationEngine({ store: ordersStore, authorization, managerAuthenticator: authenticator });

    // Platform tax fixture: SA, INVOICE_TOTAL rounding, 5% exclusive VAT.
    const platform = new PlatformTaxAdminEngine(new PostgresPlatformTaxAdminRepository(createWithPlatformTaxContext(platformPool)));
    await platform.configureJurisdiction(PLATFORM_ACTOR, 'SA', 'invoice_total', true);
    const saCategory = await platform.createCategory(PLATFORM_ACTOR, {
      countryCode: 'SA', code: randomUUID(), kind: 'standard', taxFamily: 'vat', cascadePriority: 50,
      name: { en: 'B4 fixture VAT' }, isActive: true,
    });
    await platform.createTaxRate(PLATFORM_ACTOR, { taxCategoryId: saCategory.id, rateBps: 500, isPriceInclusiveDefault: false, effectiveFrom: '2020-01-01', effectiveTo: null });
    await owner.query("UPDATE tenants SET vat_registration_status = 'registered', vat_registration_number = 'b4-vat' WHERE id = $1", [T]);

    const workflowAdmin = new WorkflowAdminEngine({ store: ordersStore });
    await workflowAdmin.ensureWorkflow(T, [
      { kindCode: 'received', position: 10, label: { ar: 'مستلم' } },
      { kindCode: 'preparing', position: 20, label: { ar: 'قيد التحضير' } },
      { kindCode: 'ready', position: 30, label: { ar: 'جاهز' } },
      { kindCode: 'delivered', position: 40, label: { ar: 'تم التسليم' } },
    ]);

    opener = await createUser();
    verifier = await createUser();
    const permWrite = new PostgresPermissionWriteRepository({ withTenantContext: withApp });
    await grantKeys(permWrite, T, opener.userId, ['shift:open', 'catalog:write']);

    const menuCategoryId = (await catalog.createCategory(T, opener.userId, { name: { ar: 'قائمة B4' } })).id;
    itemId = (await catalog.createItem(T, opener.userId, {
      categoryId: menuCategoryId, name: { ar: 'طبق B4' }, basePrice: money(10n, currencyCode('SAR')), taxRuleId: saCategory.id,
    })).id;
  });

  afterAll(async () => {
    await app?.end();
    await platformPool?.end();
    await owner?.end();
  });

  async function createUser(): Promise<TillUser> {
    const userId = randomUUID();
    await withApp(T, (q) => q.query(
      'INSERT INTO users (id, tenant_id, email, pin_hash) VALUES ($1, $2, $3, $4)',
      [userId, T, `${userId}@example.test`, hashPin(PIN_PEPPER, T, userId, '1234')],
    ));
    return { userId };
  }

  /** A fresh till (branch + station + cashier + open shift with a 200.00 float). */
  async function setupTill() {
    const branchId = randomUUID();
    const stationId = randomUUID();
    const cashier = await createUser();
    await withApp(T, async (q) => {
      await q.query('INSERT INTO branches (id, tenant_id, name, base_currency, timezone, country_code) VALUES ($1, $2, $3, $4, $5, $6)', [branchId, T, `B4 ${randomUUID()}`, 'SAR', 'Asia/Riyadh', 'SA']);
      await q.query('INSERT INTO stations (id, tenant_id, branch_id, name) VALUES ($1, $2, $3, $4)', [stationId, T, branchId, 'main']);
      await q.query('INSERT INTO station_routing_rules (id, tenant_id, branch_id, station_id, menu_item_id) VALUES ($1, $2, $3, $4, $5)', [randomUUID(), T, branchId, stationId, itemId]);
    });
    const shift = await shifts.openShift(T, {
      branchId, cashierUserId: cashier.userId, openedByUserId: opener.userId, openVerifiedByUserId: verifier.userId,
      openedAt: new Date(), openCounts: [{ denominationValue: '100.00', quantity: 2 }],
    });
    return { branchId, cashier, shiftId: shift.id };
  }

  it('T1 two-line order rounds the invoice ONCE and persists deterministic allocations', async () => {
    const till = await setupTill();
    // Pre-fix this threw InvoiceTaxBatchRequiredError: isolated per-line
    // resolution cannot serve an invoice_total jurisdiction.
    const created = await creation.create(T, {
      branchId: till.branchId, cashierUserId: till.cashier.userId, orderType: 'dine_in', salesChannelCode: 'dine_in',
      deliveryPlatformId: null, tableId: null,
      items: [
        { menuItemId: itemId, quantity: 1 },
        { menuItemId: itemId, quantity: 1 },
      ],
      occurredAt: new Date(),
    });
    expect(created.items).toHaveLength(2);

    // Returned resolutions: the invoice sum (20 @ 5% = 1.0) rounds ONCE to 1
    // — per-line rounding would have given 1 + 1 = 2.
    const returned = created.items.map((entry) => ({ id: entry.item.id, tax: restaurantTaxOf(entry.taxes) }));
    expect(returned.reduce((sum, r) => sum + r.tax, 0n)).toBe(1n);
    // Largest-remainder allocation, ties broken by stable line-UUID order.
    expect(returned.sort((a, b) => (a.id < b.id ? -1 : 1)).map((r) => r.tax)).toEqual([1n, 0n]);

    // Durable evidence: the SAME allocation on the snapshot rows, and both
    // contexts pinned to the invoice_total strategy.
    const lineIds = created.items.map((entry) => entry.item.id);
    const snapshots = await owner.query<{ order_line_id: string; tax: string }>(
      'SELECT order_line_id, tax_amount_minor::text AS tax FROM order_line_tax_snapshots WHERE order_line_id = ANY($1) ORDER BY order_line_id',
      [lineIds],
    );
    expect(snapshots.rows.map((r) => BigInt(r.tax))).toEqual([1n, 0n]);
    const contexts = await owner.query<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM order_line_tax_contexts WHERE tenant_id = $1 AND order_line_id = ANY($2) AND rounding_strategy = 'invoice_total'",
      [T, lineIds],
    );
    expect(contexts.rows[0]?.n).toBe('2');
  });

  it('T2 single-line order converges through the same batch path', async () => {
    const till = await setupTill();
    const created = await creation.create(T, {
      branchId: till.branchId, cashierUserId: till.cashier.userId, orderType: 'dine_in', salesChannelCode: 'dine_in',
      deliveryPlatformId: null, tableId: null,
      items: [{ menuItemId: itemId, quantity: 1 }],
      occurredAt: new Date(),
    });
    expect(created.items).toHaveLength(1);

    // Batch-of-1 ≡ the per-line value: 10 @ 5% = 0.5 → half-up 1.
    const first = created.items[0];
    if (first === undefined) throw new Error('Expected one created item');
    expect(restaurantTaxOf(first.taxes)).toBe(1n);

    const snapshots = await owner.query<{ tax: string; n: string }>(
      'SELECT tax_amount_minor::text AS tax, COUNT(*)::text AS n FROM order_line_tax_snapshots WHERE order_line_id = $1 GROUP BY tax_amount_minor',
      [first.item.id],
    );
    expect(snapshots.rows).toHaveLength(1);
    expect(snapshots.rows[0]).toMatchObject({ tax: '1', n: '1' });
    const contexts = await owner.query<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM order_line_tax_contexts WHERE tenant_id = $1 AND order_line_id = $2 AND rounding_strategy = 'invoice_total'",
      [T, first.item.id],
    );
    expect(contexts.rows[0]?.n).toBe('1');
  });
});
