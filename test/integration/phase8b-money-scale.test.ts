/**
 * B1 live acceptance — ISO-scale money storage (migration 0044).
 *
 * Before the fix every Phase-8 money-major column was NUMERIC(18,2) while the
 * engines compute in ISO minor units: KWD (3 decimals) rows were stored 10x
 * inflated (1005 fils → "10.05") and JPY (0 decimals) rows 100x shrunk
 * (¥104 → "1.04"). These tests prove the fix end to end on a REAL PostgreSQL:
 *
 *   * KWD branch (3 decimals): order + 10% discount + USD-cash partial
 *     payment + exact KWD top-up + Z-Report close — every stored value
 *     asserted as an exact numeric, plus the tightened FX trigger tolerance
 *     (a 1-fils error is rejected; the old 0.005 tolerance accepted it).
 *   * JPY branch (0 decimals): order + fixed discount + over-tender with
 *     change + Z-Report close — exact numerics throughout, and an explicit
 *     refusal of sub-unit cash denominations.
 *
 * Read/write identity is asserted twice: engine minor-unit math AND raw
 * stored numerics (an old-code row fails the numeric assertions).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OrderCreationEngine } from '../../src/application/engines/orders/order-creation-engine.ts';
import { WorkflowAdminEngine } from '../../src/application/engines/orders/workflow-admin-engine.ts';
import { DiscountEngine } from '../../src/application/engines/payments/discount-engine.ts';
import { PaymentMethodsEngine } from '../../src/application/engines/payments/payment-methods-engine.ts';
import { PaymentsEngine } from '../../src/application/engines/payments/payments-engine.ts';
import { ShiftEngine } from '../../src/application/engines/shifts/shift-engine.ts';
import { AuthorizationEngine } from '../../src/application/engines/rbac/authorization-engine.ts';
import { CatalogEngine } from '../../src/application/engines/catalog/catalog-engine.ts';
import { PlatformTaxAdminEngine } from '../../src/application/engines/tax/platform-tax-admin-engine.ts';
import { deriveSecV } from '../../src/domain/contracts/sec-v.ts';
import { createWithPlatformTaxContext } from '../../src/infrastructure/db/platform-tax-context.ts';
import { createWithTenantContext, type WithTenantContext } from '../../src/infrastructure/db/tenant-context.ts';
import { PostgresCatalogRepository } from '../../src/infrastructure/db/repositories/postgres-catalog-repository.ts';
import { PostgresManagerOverrideAuthenticator } from '../../src/infrastructure/db/repositories/postgres-manager-override-authenticator.ts';
import { PostgresOrdersStore } from '../../src/infrastructure/db/repositories/postgres-orders-store.ts';
import { PostgresPaymentsStore } from '../../src/infrastructure/db/repositories/postgres-payments-store.ts';
import { PostgresPermissionReadRepository, PostgresPermissionWriteRepository } from '../../src/infrastructure/db/repositories/postgres-permission-repository.ts';
import { PostgresPlatformTaxAdminRepository } from '../../src/infrastructure/db/repositories/postgres-platform-tax-admin-repository.ts';
import { PostgresShiftsStore } from '../../src/infrastructure/db/repositories/postgres-shifts-store.ts';
import { PostgresTenantTaxAdminRepository } from '../../src/infrastructure/db/repositories/postgres-tenant-tax-admin-repository.ts';
import { hashPin } from '../../src/shared/auth/pin.ts';
import { sha256Hex } from '../../src/shared/crypto.ts';
import { currencyCode, money } from '../../src/shared/money.ts';
import { testDatabaseUrl } from '../support/database.ts';
import { grantKeys } from '../support/grant-keys.ts';

const PLATFORM_ACTOR = '71000000-0000-4000-8000-000000000005';
let T: string; // dedicated B1 tenant (fresh per run)
const PIN_PEPPER = Buffer.from(randomBytes(48));

function row<R>(rows: readonly R[]): R {
  const first = rows[0];
  if (first === undefined) throw new Error('Expected database row');
  return first;
}

interface TillUser {
  readonly userId: string;
  readonly tokenSecV: string;
}

describe('B1 live acceptance (ISO-scale money storage)', () => {
  let owner: pg.Pool;
  let app: pg.Pool;
  let platformPool: pg.Pool;
  let withApp: WithTenantContext;
  let catalog: CatalogEngine;
  let permissionRead: PostgresPermissionReadRepository;
  let authorization: AuthorizationEngine;
  let creation: OrderCreationEngine;
  let shifts: ShiftEngine;
  let payments: PaymentsEngine;
  let discounts: DiscountEngine;
  let methods: PaymentMethodsEngine;
  let kwdItem: string; // 1.005 KWD (1005 fils)
  let jpyItem: string; // ¥100
  let methodCashId: string;
  let permWrite: PostgresPermissionWriteRepository;
  let opener: TillUser;
  let verifier: TillUser;
  let discountUser: TillUser;

  beforeAll(async () => {
    owner = new pg.Pool({ connectionString: testDatabaseUrl(), max: 5 });
    T = randomUUID();
    await owner.query('INSERT INTO tenants (id, name) VALUES ($1, $2)', [T, 'b1-money-scale']);
    // B1 fixture: JPY is not in the 0007 seed (six currencies). The 0-decimal
    // leg needs it as a menu_items currency FK target (same disposable-fixture
    // pattern as phase4-multi-currency.test.ts; phase4b tolerates extra rows).
    await owner.query(
      `INSERT INTO currencies (code, minor_unit_digits) VALUES ('JPY', 0)
       ON CONFLICT (code) DO UPDATE SET minor_unit_digits = EXCLUDED.minor_unit_digits`,
    );
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

    permissionRead = new PostgresPermissionReadRepository({ withTenantContext: withApp });
    authorization = new AuthorizationEngine({ read: permissionRead, hash: sha256Hex });
    catalog = new CatalogEngine({ catalog: new PostgresCatalogRepository({ withTenantContext: withApp }), taxAssignments: new PostgresTenantTaxAdminRepository(withApp), authorization });
    const ordersStore = new PostgresOrdersStore({ withTenantContext: withApp });
    const workflowAdmin = new WorkflowAdminEngine({ store: ordersStore, authorization });
    shifts = new ShiftEngine({ store: new PostgresShiftsStore({ withTenantContext: withApp }), authorization });
    const authenticator = new PostgresManagerOverrideAuthenticator({ withTenantContext: withApp, pepper: PIN_PEPPER });
    payments = new PaymentsEngine({ store: new PostgresPaymentsStore({ withTenantContext: withApp }), authorization });
    discounts = new DiscountEngine({ store: new PostgresPaymentsStore({ withTenantContext: withApp }), authorization, managerAuthenticator: authenticator });
    creation = new OrderCreationEngine({ store: ordersStore, authorization, managerAuthenticator: authenticator });
    methods = new PaymentMethodsEngine({ store: new PostgresPaymentsStore({ withTenantContext: withApp }), authorization });

    // Platform tax fixture: SA, per-line rounding, 15% exclusive VAT.
    const platform = new PlatformTaxAdminEngine(new PostgresPlatformTaxAdminRepository(createWithPlatformTaxContext(platformPool)));
    await platform.configureJurisdiction(PLATFORM_ACTOR, 'SA', 'per_line', true);
    const saCategory = await platform.createCategory(PLATFORM_ACTOR, {
      countryCode: 'SA', code: randomUUID(), kind: 'standard', taxFamily: 'vat', cascadePriority: 50,
      name: { en: 'B1 fixture VAT' }, isActive: true,
    });
    await platform.createTaxRate(PLATFORM_ACTOR, { taxCategoryId: saCategory.id, rateBps: 1500, isPriceInclusiveDefault: false, effectiveFrom: '2020-01-01', effectiveTo: null });
    await owner.query("UPDATE tenants SET vat_registration_status = 'registered', vat_registration_number = 'b1-vat' WHERE id = $1", [T]);

    await workflowAdmin.ensureWorkflow(T, [
      { kindCode: 'received', position: 10, label: { ar: 'مستلم' } },
      { kindCode: 'preparing', position: 20, label: { ar: 'قيد التحضير' } },
      { kindCode: 'ready', position: 30, label: { ar: 'جاهز' } },
      { kindCode: 'delivered', position: 40, label: { ar: 'تم التسليم' } },
    ]);
    opener = await createUser(null);
    verifier = await createUser(null);
    // One caps row serves both branches: 15% and 20 branch-currency units.
    discountUser = await createUser({ pct: '15.00', fixed: '20.00' });
    permWrite = new PostgresPermissionWriteRepository({ withTenantContext: withApp });
    await grantKeys(permWrite, T, opener.userId, ['shift:open', 'shift:close', 'catalog:write', 'payments:methods_admin']);

    const menuCategoryId = (await catalog.createCategory(T, opener.userId, { name: { ar: 'قائمة B1' } })).id;
    kwdItem = (await catalog.createItem(T, opener.userId, {
      categoryId: menuCategoryId, name: { ar: 'طبق كويتي' }, basePrice: money(1005n, currencyCode('KWD')), taxRuleId: saCategory.id,
    })).id;
    jpyItem = (await catalog.createItem(T, opener.userId, {
      categoryId: menuCategoryId, name: { ar: 'طبق ياباني' }, basePrice: money(100n, currencyCode('JPY')), taxRuleId: saCategory.id,
    })).id;

    methodCashId = (await methods.create(T, opener.userId, { name: 'نقدي B1', type: 'cash', branchId: null, currencyCode: null, fixedExchangeRate: null, isActive: true })).id;
  });

  afterAll(async () => {
    await app?.end();
    await platformPool?.end();
    await owner?.end();
  });

  async function createUser(caps: { pct: string; fixed: string } | null): Promise<TillUser> {
    const userId = randomUUID();
    await withApp(T, (q) => q.query(
      'INSERT INTO users (id, tenant_id, email, pin_hash) VALUES ($1, $2, $3, $4)',
      [userId, T, `${userId}@example.test`, hashPin(PIN_PEPPER, T, userId, '1234')],
    ));
    if (caps !== null) {
      const roleId = randomUUID();
      await withApp(T, async (q) => {
        await q.query('INSERT INTO roles (id, tenant_id, name) VALUES ($1, $2, $3)', [roleId, T, `b1-${roleId}`]);
        await q.query('INSERT INTO role_permissions (tenant_id, role_id, permission_key) VALUES ($1, $2, $3)', [T, roleId, 'order:discount:apply']);
        await q.query("INSERT INTO user_roles (tenant_id, user_id, role_id, scope_type, scope_id) VALUES ($1, $2, $3, 'tenant', NULL)", [T, userId, roleId]);
        await q.query(
          `INSERT INTO user_discount_limits (tenant_id, user_id, permission_key, max_discount_percentage, max_discount_fixed_amount)
           VALUES ($1, $2, 'order:discount:apply', $3, $4)`,
          [T, userId, caps.pct, caps.fixed],
        );
      });
    }
    const tokenSecV = deriveSecV(await permissionRead.listActiveUserRoles(T, userId), await permissionRead.getSecurityVersion(T, userId), sha256Hex);
    return { userId, tokenSecV };
  }

  /** A fresh till on a branch whose base currency is `baseCurrency`. */
  async function setupTill(baseCurrency: string, itemId: string, openCounts: readonly { denominationValue: string; quantity: number }[]) {
    const branchId = randomUUID();
    const stationId = randomUUID();
    const cashier = await createUser(null);
    await grantKeys(permWrite, T, cashier.userId, ['payments:collect']);
    await withApp(T, async (q) => {
      await q.query('INSERT INTO branches (id, tenant_id, name, base_currency, timezone, country_code) VALUES ($1, $2, $3, $4, $5, $6)', [branchId, T, `B1 ${baseCurrency} ${randomUUID()}`, baseCurrency, 'Asia/Riyadh', 'SA']);
      await q.query('INSERT INTO stations (id, tenant_id, branch_id, name) VALUES ($1, $2, $3, $4)', [stationId, T, branchId, 'main']);
      await q.query('INSERT INTO station_routing_rules (id, tenant_id, branch_id, station_id, menu_item_id) VALUES ($1, $2, $3, $4, $5)', [randomUUID(), T, branchId, stationId, itemId]);
    });
    const shift = await shifts.openShift(T, {
      branchId, cashierUserId: cashier.userId, openedByUserId: opener.userId, openVerifiedByUserId: verifier.userId,
      openedAt: new Date(), openCounts,
    });
    return { branchId, cashier, shiftId: shift.id };
  }

  async function newOrder(branchId: string, cashierId: string, menuItemId: string): Promise<string> {
    const created = await creation.create(T, {
      branchId, cashierUserId: cashierId, orderType: 'dine_in', salesChannelCode: 'dine_in',
      deliveryPlatformId: null, tableId: null, items: [{ menuItemId, quantity: 1 }], occurredAt: new Date(),
    });
    return created.order.id;
  }

  /** Exact numeric equality on a stored row (immune to NUMERIC display scale). */
  async function expectStoredNumeric(table: string, idColumn: string, id: string, column: string, expected: string): Promise<void> {
    const result = await owner.query<{ ok: boolean }>(
      `SELECT (${column} = $2::numeric) AS ok FROM ${table} WHERE ${idColumn} = $1`, [id, expected],
    );
    expect(row(result.rows).ok).toBe(true);
  }

  it('KWD branch (3 decimals): discount + USD-cash partial + exact top-up + close, all exact', async () => {
    const till = await setupTill('KWD', kwdItem, [{ denominationValue: '1.000', quantity: 1 }]);
    const order = await newOrder(till.branchId, till.cashier.userId, kwdItem);

    // Subtotal 1005 fils; 10% ⇒ half-even(100.5) = 100 fils applied.
    await discounts.applyDiscount(T, { userId: discountUser.userId, tokenSecV: discountUser.tokenSecV }, {
      orderId: order, mechanism: 'manual', discountKind: 'percentage', discountValueText: '10.0000',
    });
    const totals = await payments.orderTotals(T, order);
    expect(totals.subtotalMinor).toBe(1005n);
    expect(totals.discountTotalMinor).toBe(100n);
    expect(totals.taxMinor).toBe(136n); // 15% of 905 = 135.75, half-up
    expect(totals.totalMinor).toBe(1041n);

    // Partial payment in USD cash @ 0.30770000 USD→KWD: 1.00 USD ⇒ 307.7 fils ⇒ 308.
    const usdMethod = await methods.create(T, opener.userId, {
      name: 'دولار B1', type: 'foreign_currency_cash', branchId: till.branchId,
      currencyCode: 'USD', fixedExchangeRate: '0.30770000', isActive: true,
    });
    const pay1 = await payments.recordPayment(T, {
      orderId: order, paymentMethodId: usdMethod.id, cashierUserId: till.cashier.userId, amountText: '1.00',
    });
    expect(pay1.orderTotalMinor).toBe(1041n);
    expect(pay1.remainingBalanceMinor).toBe(733n);
    expect(pay1.changeGivenMinor).toBe(0n);

    // Exact KWD top-up closes the order.
    const pay2 = await payments.recordPayment(T, {
      orderId: order, paymentMethodId: methodCashId, cashierUserId: till.cashier.userId, amountText: '0.733',
    });
    expect(pay2.remainingBalanceMinor).toBe(0n);
    expect(pay2.changeGivenMinor).toBe(0n);

    // Raw stored numerics: exact (old code stored 10x here: "10.41", "3.08", "7.33", "1.00").
    await expectStoredNumeric('payments', 'id', pay1.payment.id, 'amount', '1.00');
    await expectStoredNumeric('payments', 'id', pay1.payment.id, 'amount_in_base_currency', '0.308');
    await expectStoredNumeric('payments', 'id', pay1.payment.id, 'exchange_rate_snapshot', '0.30770000');
    await expectStoredNumeric('payments', 'id', pay2.payment.id, 'amount', '0.733');
    await expectStoredNumeric('payments', 'id', pay2.payment.id, 'amount_in_base_currency', '0.733');
    const discountRow = row((await owner.query<{ id: string }>('SELECT id FROM order_discounts WHERE tenant_id = $1 AND order_id = $2', [T, order])).rows);
    await expectStoredNumeric('order_discounts', 'id', discountRow.id, 'discount_amount_applied', '0.100');
    const statusRow = row((await owner.query<{ payment_status: string }>('SELECT payment_status FROM orders WHERE id = $1', [order])).rows);
    expect(statusRow.payment_status).toBe('paid');

    // The tightened FX tolerance: a 1-fils error (0.309 vs honest 0.308) is
    // rejected — residue 0.0013 exceeds half a fils (0.0005) but was inside
    // the old hardcoded 0.005 tolerance.
    let rejected: unknown = null;
    try {
      await withApp(T, (q) => q.query(
        `INSERT INTO payments (id, tenant_id, order_id, payment_method_id, amount, amount_in_base_currency,
           exchange_rate_snapshot, change_given_amount, shift_id, created_by)
         VALUES ($1, $2, $3, $4, '1.00', '0.309', '0.30770000', NULL, $5, $6)`,
        [randomUUID(), T, order, usdMethod.id, till.shiftId, till.cashier.userId],
      ));
    } catch (error: unknown) {
      rejected = error;
    }
    expect(rejected).toMatchObject({ code: '23514', message: expect.stringContaining('must equal amount') as string });
    const payCount = row((await owner.query<{ n: string }>('SELECT count(*)::text AS n FROM payments WHERE tenant_id = $1 AND order_id = $2', [T, order])).rows);
    expect(payCount.n).toBe('2');

    // Z-Report close: counted 2.041 (incl. a 5-fils coin) − float 1.000 −
    // recorded 1.041 ⇒ variance exactly zero.
    const closed = await shifts.closeShift(T, {
      shiftId: till.shiftId, closedByUserId: opener.userId, closeVerifiedByUserId: verifier.userId,
      closedAt: new Date(), closeCounts: [
        { denominationValue: '2.000', quantity: 1 },
        { denominationValue: '0.036', quantity: 1 },
        { denominationValue: '0.005', quantity: 1 },
      ], notes: null,
    });
    expect(closed.status).toBe('closed');
    expect(closed.varianceType).toBe('exact');
    await expectStoredNumeric('shift_reconciliations', 'id', till.shiftId, 'starting_float', '1.000');
    await expectStoredNumeric('shift_reconciliations', 'id', till.shiftId, 'counted_cash', '2.041');
    await expectStoredNumeric('shift_reconciliations', 'id', till.shiftId, 'recorded_cash_sales', '1.041');
    await expectStoredNumeric('shift_reconciliations', 'id', till.shiftId, 'variance', '0');
  });

  it('JPY branch (0 decimals): fixed discount + over-tender with change + close, all exact', async () => {
    const till = await setupTill('JPY', jpyItem, [{ denominationValue: '1000', quantity: 1 }]);
    const order = await newOrder(till.branchId, till.cashier.userId, jpyItem);

    // Subtotal ¥100; fixed ¥10 ⇒ discounted 90; 15% of 90 = 13.5 ⇒ half-up 14; total ¥104.
    await discounts.applyDiscount(T, { userId: discountUser.userId, tokenSecV: discountUser.tokenSecV }, {
      orderId: order, mechanism: 'manual', discountKind: 'fixed_amount', discountValueText: '10',
    });
    const totals = await payments.orderTotals(T, order);
    expect(totals.subtotalMinor).toBe(100n);
    expect(totals.discountTotalMinor).toBe(10n);
    expect(totals.taxMinor).toBe(14n);
    expect(totals.totalMinor).toBe(104n);

    // Over-tender ¥200 ⇒ ¥96 change, net ¥104 collected.
    const paid = await payments.recordPayment(T, {
      orderId: order, paymentMethodId: methodCashId, cashierUserId: till.cashier.userId, amountText: '200',
    });
    expect(paid.orderTotalMinor).toBe(104n);
    expect(paid.remainingBalanceMinor).toBe(0n);
    expect(paid.changeGivenMinor).toBe(96n);

    // Raw stored numerics: whole yen (old code stored "2.00"/"1.04"/"0.96" — a 100x shrink on re-read).
    await expectStoredNumeric('payments', 'id', paid.payment.id, 'amount', '200');
    await expectStoredNumeric('payments', 'id', paid.payment.id, 'amount_in_base_currency', '104');
    await expectStoredNumeric('payments', 'id', paid.payment.id, 'change_given_amount', '96');
    const discountRow = row((await owner.query<{ id: string }>('SELECT id FROM order_discounts WHERE tenant_id = $1 AND order_id = $2', [T, order])).rows);
    await expectStoredNumeric('order_discounts', 'id', discountRow.id, 'discount_amount_applied', '10');
    const statusRow = row((await owner.query<{ payment_status: string }>('SELECT payment_status FROM orders WHERE id = $1', [order])).rows);
    expect(statusRow.payment_status).toBe('paid');

    // Z-Report close: counted 1104 − float 1000 − recorded 104 ⇒ zero.
    const closed = await shifts.closeShift(T, {
      shiftId: till.shiftId, closedByUserId: opener.userId, closeVerifiedByUserId: verifier.userId,
      closedAt: new Date(), closeCounts: [{ denominationValue: '1104', quantity: 1 }], notes: null,
    });
    expect(closed.status).toBe('closed');
    expect(closed.varianceType).toBe('exact');
    await expectStoredNumeric('shift_reconciliations', 'id', till.shiftId, 'starting_float', '1000');
    await expectStoredNumeric('shift_reconciliations', 'id', till.shiftId, 'counted_cash', '1104');
    await expectStoredNumeric('shift_reconciliations', 'id', till.shiftId, 'recorded_cash_sales', '104');
    await expectStoredNumeric('shift_reconciliations', 'id', till.shiftId, 'variance', '0');
  });

  it('JPY branch refuses sub-unit cash denominations explicitly (no silent rounding of stored-verbatim counts)', async () => {
    const branchId = randomUUID();
    const cashier = await createUser(null);
    await grantKeys(permWrite, T, cashier.userId, ['payments:collect']);
    await withApp(T, (q) => q.query(
      'INSERT INTO branches (id, tenant_id, name, base_currency, timezone, country_code) VALUES ($1, $2, $3, $4, $5, $6)',
      [branchId, T, `B1 JPY reject ${randomUUID()}`, 'JPY', 'Asia/Riyadh', 'SA'],
    ));
    await expect(shifts.openShift(T, {
      branchId, cashierUserId: cashier.userId, openedByUserId: opener.userId, openVerifiedByUserId: verifier.userId,
      openedAt: new Date(), openCounts: [{ denominationValue: '0.1', quantity: 1 }],
    })).rejects.toMatchObject({ code: 'validation.failed' });
    const shiftCount = row((await owner.query<{ n: string }>('SELECT count(*)::text AS n FROM shift_reconciliations WHERE tenant_id = $1 AND cashier_id = $2', [T, cashier.userId])).rows);
    expect(shiftCount.n).toBe('0');
  });
});
