/**
 * Phase 8 live acceptance — payments, discounts, coupons, shifts.
 *
 * Everything runs against a REAL PostgreSQL 18 (RLS, triggers, FK RESTRICT,
 * deferred constraint triggers, the immutable evidence guards) on a dedicated
 * tenant. The spec's MANDATED test list is covered, numbered:
 *
 *   #1  discount capping never produces a negative remainder
 *   #2  zeroing out the subtotal ALWAYS escalates (manager override)
 *   #3  stacking rejected/succeeds per tenants.allow_discount_stacking
 *   #4  one person can never hold both verification roles (open AND close)
 *   #5  the shift row is immutable after the Z-Report close
 *   #6  payments.exchange_rate_snapshot is immutable after the payment
 *   #7  no parallel/overlapping open shifts for the same cashier
 *   #8  starting_float / counted_cash match the cash_count_details sums
 *
 * plus the shift GATEWAY (no new orders/payments without a standing open
 * shift), the foreign-currency cash flow (manual fixed rate, change always in
 * the branch base currency), the Void Payment → Reopen sequence, the
 * payments:refund sensitive permission, the X-Report read-only contract, the
 * Z-Report recorded_cash_sales/variance computation, coupons, and the
 * deliberately deferred loyalty-points refusal.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OrderCreationEngine } from '../../src/application/engines/orders/order-creation-engine.ts';
import { VoidModificationEngine } from '../../src/application/engines/orders/void-modification-engine.ts';
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
import { PostgresPermissionReadRepository } from '../../src/infrastructure/db/repositories/postgres-permission-repository.ts';
import { PostgresPlatformTaxAdminRepository } from '../../src/infrastructure/db/repositories/postgres-platform-tax-admin-repository.ts';
import { PostgresShiftsStore } from '../../src/infrastructure/db/repositories/postgres-shifts-store.ts';
import { PostgresTenantTaxAdminRepository } from '../../src/infrastructure/db/repositories/postgres-tenant-tax-admin-repository.ts';
import { hashPin } from '../../src/shared/auth/pin.ts';
import { sha256Hex } from '../../src/shared/crypto.ts';
import {
  CashierShiftRequiredError,
  DiscountOverrideRequiredError,
  LoyaltyPointsDeferredError,
  PaymentExceedsBalanceError,
  PaymentReversalRequiredError,
} from '../../src/shared/errors.ts';
import { currencyCode, money } from '../../src/shared/money.ts';
import { testDatabaseUrl } from '../support/database.ts';

const PLATFORM_ACTOR = '71000000-0000-4000-8000-000000000005';
let T: string; // dedicated Phase-8 tenant (fresh per run)
const PIN_PEPPER = Buffer.from(randomBytes(48));

function row<R>(rows: readonly R[]): R {
  const first = rows[0];
  if (first === undefined) throw new Error('Expected database row');
  return first;
}

interface TieredUser {
  readonly userId: string;
  readonly tokenSecV: string;
  readonly pin: string;
}

interface Till {
  readonly branchId: string;
  readonly cashierId: string;
  /** The full cashier identity — holds payments:refund + payments:void (a senior cashier). */
  readonly cashier: TieredUser;
  readonly shiftId: string;
}

describe('Phase 8 live acceptance (payments + discounts + shifts)', () => {
  let owner: pg.Pool;
  let app: pg.Pool;
  let platformPool: pg.Pool;
  let withApp: WithTenantContext;
  let catalog: CatalogEngine;
  let permissionRead: PostgresPermissionReadRepository;
  let authorization: AuthorizationEngine;
  let ordersStore: PostgresOrdersStore;
  let creation: OrderCreationEngine;
  let workflowAdmin: WorkflowAdminEngine;
  let shifts: ShiftEngine;
  let payments: PaymentsEngine;
  let discounts: DiscountEngine;
  let methods: PaymentMethodsEngine;
  let voids: VoidModificationEngine;
  let authenticator: PostgresManagerOverrideAuthenticator;
  let menuCategoryId: string;
  let itemA: string; // 25.00 SAR
  let itemB: string; // 15.00 SAR
  let methodCashId: string;
  let methodCardId: string;
  let methodUsdId: string;
  let opener: TieredUser;
  let verifier: TieredUser;
  let cashierUser: TieredUser;
  let discountUser: TieredUser;
  let overrideManager: TieredUser;
  let voidServerUser: TieredUser;
  let reasonServer: string;
  let tillCounter = 0;

  beforeAll(async () => {
    owner = new pg.Pool({ connectionString: testDatabaseUrl(), max: 5 });
    T = randomUUID();
    await owner.query('INSERT INTO tenants (id, name) VALUES ($1, $2)', [T, 'phase8-payments']);
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
    catalog = new CatalogEngine({ catalog: new PostgresCatalogRepository({ withTenantContext: withApp }), taxAssignments: new PostgresTenantTaxAdminRepository(withApp) });
    permissionRead = new PostgresPermissionReadRepository({ withTenantContext: withApp });
    authorization = new AuthorizationEngine({ read: permissionRead, hash: sha256Hex });
    ordersStore = new PostgresOrdersStore({ withTenantContext: withApp });
    workflowAdmin = new WorkflowAdminEngine({ store: ordersStore });
    shifts = new ShiftEngine({ store: new PostgresShiftsStore({ withTenantContext: withApp }) });
    authenticator = new PostgresManagerOverrideAuthenticator({ withTenantContext: withApp, pepper: PIN_PEPPER });
    payments = new PaymentsEngine({ store: new PostgresPaymentsStore({ withTenantContext: withApp }), authorization });
    discounts = new DiscountEngine({ store: new PostgresPaymentsStore({ withTenantContext: withApp }), authorization, managerAuthenticator: authenticator });
    creation = new OrderCreationEngine({ store: ordersStore, authorization, managerAuthenticator: authenticator });
    methods = new PaymentMethodsEngine({ store: new PostgresPaymentsStore({ withTenantContext: withApp }) });
    voids = new VoidModificationEngine({ store: ordersStore, authorization, managerAuthenticator: authenticator });

    // Platform tax fixture: SA, per-line rounding, 15% exclusive VAT.
    const platform = new PlatformTaxAdminEngine(new PostgresPlatformTaxAdminRepository(createWithPlatformTaxContext(platformPool)));
    await platform.configureJurisdiction(PLATFORM_ACTOR, 'SA', 'per_line', true);
    const saCategory = await platform.createCategory(PLATFORM_ACTOR, {
      countryCode: 'SA', code: randomUUID(), kind: 'standard', taxFamily: 'vat', cascadePriority: 50,
      name: { en: 'Phase 8 fixture VAT' }, isActive: true,
    });
    await platform.createTaxRate(PLATFORM_ACTOR, { taxCategoryId: saCategory.id, rateBps: 1500, isPriceInclusiveDefault: false, effectiveFrom: '2020-01-01', effectiveTo: null });
    await owner.query("UPDATE tenants SET vat_registration_status = 'registered', vat_registration_number = 'phase8-vat' WHERE id = $1", [T]);

    await workflowAdmin.ensureWorkflow(T, [
      { kindCode: 'received', position: 10, label: { ar: 'مستلم' } },
      { kindCode: 'preparing', position: 20, label: { ar: 'قيد التحضير' } },
      { kindCode: 'ready', position: 30, label: { ar: 'جاهز' } },
      { kindCode: 'delivered', position: 40, label: { ar: 'تم التسليم' } },
    ]);
    menuCategoryId = (await catalog.createCategory(T, { name: { ar: 'قائمة الفحص' } })).id;
    itemA = (await catalog.createItem(T, {
      categoryId: menuCategoryId, name: { ar: 'طبق رئيسي' }, basePrice: money(2500n, currencyCode('SAR')), taxRuleId: saCategory.id,
    })).id;
    itemB = (await catalog.createItem(T, {
      categoryId: menuCategoryId, name: { ar: 'مشروب' }, basePrice: money(1500n, currencyCode('SAR')), taxRuleId: saCategory.id,
    })).id;

    // People: plain shift identities + tiered permission holders.
    opener = await createPlainUser('1111');
    verifier = await createPlainUser('2222');
    cashierUser = await createPlainUser('3333');
    discountUser = await createTieredUser(['order:discount:apply'], '4444', { pct: '15.00', fixed: '20.00' });
    overrideManager = await createTieredUser(['order:discount:apply'], '5555', null);
    voidServerUser = await createTieredUser(['order:void'], '9999', null);
    reasonServer = randomUUID();
    await withApp(T, (q) => q.query(
      'INSERT INTO tenant_void_reasons (id, tenant_id, void_reason_kind_code, label, required_permission_tier) VALUES ($1, $2, $3, $4, $5)',
      [reasonServer, T, 'customer_request', `سبب فحص ${reasonServer}`, 'server'],
    ));

    // Payment methods: domestic cash, card, and USD cash at a fixed 3.75.
    methodCashId = (await methods.create(T, { name: 'نقدي', type: 'cash', branchId: null, currencyCode: null, fixedExchangeRate: null, isActive: true })).id;
    methodCardId = (await methods.create(T, { name: 'شبكة', type: 'card', branchId: null, currencyCode: null, fixedExchangeRate: null, isActive: true })).id;
    methodUsdId = (await methods.create(T, { name: 'دولار نقدي', type: 'foreign_currency_cash', branchId: null, currencyCode: 'USD', fixedExchangeRate: '3.75000000', isActive: true })).id;
  });

  afterAll(async () => {
    await app?.end();
    await platformPool?.end();
    await owner?.end();
  });

  beforeEach(() => {
    tillCounter += 1;
  });

  // ── Fixtures ─────────────────────────────────────────────────────────────

  async function createPlainUser(pin: string): Promise<TieredUser> {
    const userId = randomUUID();
    await withApp(T, (q) => q.query(
      'INSERT INTO users (id, tenant_id, email, pin_hash) VALUES ($1, $2, $3, $4)',
      [userId, T, `${userId}@example.test`, hashPin(PIN_PEPPER, T, userId, pin)],
    ));
    const tokenSecV = deriveSecV(await permissionRead.listActiveUserRoles(T, userId), await permissionRead.getSecurityVersion(T, userId), sha256Hex);
    return { userId, tokenSecV, pin };
  }

  async function createTieredUser(keys: readonly string[], pin: string, caps: { pct: string; fixed: string } | null): Promise<TieredUser> {
    const user = await createPlainUser(pin);
    const roleId = randomUUID();
    await withApp(T, async (q) => {
      await q.query('INSERT INTO roles (id, tenant_id, name) VALUES ($1, $2, $3)', [roleId, T, `phase8-${roleId}`]);
      for (const key of keys) {
        await q.query('INSERT INTO role_permissions (tenant_id, role_id, permission_key) VALUES ($1, $2, $3)', [T, roleId, key]);
      }
      await q.query("INSERT INTO user_roles (tenant_id, user_id, role_id, scope_type, scope_id) VALUES ($1, $2, $3, 'tenant', NULL)", [T, user.userId, roleId]);
      if (caps !== null) {
        await q.query(
          `INSERT INTO user_discount_limits (tenant_id, user_id, permission_key, max_discount_percentage, max_discount_fixed_amount)
           VALUES ($1, $2, 'order:discount:apply', $3, $4)`,
          [T, user.userId, caps.pct, caps.fixed],
        );
      }
    });
    const tokenSecV = deriveSecV(await permissionRead.listActiveUserRoles(T, user.userId), await permissionRead.getSecurityVersion(T, user.userId), sha256Hex);
    return { userId: user.userId, tokenSecV, pin };
  }

  function actor(user: TieredUser) {
    return { userId: user.userId, tokenSecV: user.tokenSecV };
  }

  /** A fresh branch + FRESH cashier holding a standing OPEN shift (the gateway fixture). */
  async function setupTill(openCounts: readonly { denominationValue: string; quantity: number }[] = []): Promise<Till> {
    const branchId = randomUUID();
    const stationId = randomUUID();
    // Fresh cashier per till (one open shift per cashier, ever), holding the
    // reversal permissions: refunds/voids are performed by the till's own
    // senior cashier, standing in their open shift at the order's branch.
    const tillCashier = await createTieredUser(['payments:refund', 'payments:void'], '3333', null);
    await withApp(T, async (q) => {
      await q.query("INSERT INTO branches (id, tenant_id, name, base_currency, timezone, country_code) VALUES ($1, $2, $3, 'SAR', 'Asia/Riyadh', 'SA')", [branchId, T, `فرع ${tillCounter}`]);
      await q.query('INSERT INTO stations (id, tenant_id, branch_id, name) VALUES ($1, $2, $3, $4)', [stationId, T, branchId, 'main']);
      await q.query('INSERT INTO station_routing_rules (id, tenant_id, branch_id, station_id, menu_item_id) VALUES ($1, $2, $3, $4, $5), ($6, $2, $3, $4, $7)', [
        randomUUID(), T, branchId, stationId, itemA, randomUUID(), itemB,
      ]);
    });
    const shift = await shifts.openShift(T, {
      branchId,
      cashierUserId: tillCashier.userId,
      openedByUserId: opener.userId,
      openVerifiedByUserId: verifier.userId,
      openedAt: new Date(),
      openCounts,
    });
    return { branchId, cashierId: tillCashier.userId, cashier: tillCashier, shiftId: shift.id };
  }

  /** Order of itemA (25.00) + itemB (15.00): subtotal 40.00, 15% VAT ⇒ total 46.00. */
  async function newOrder(till: Till) {
    return creation.create(T, {
      branchId: till.branchId,
      cashierUserId: till.cashierId,
      orderType: 'dine_in',
      salesChannelCode: 'dine_in',
      deliveryPlatformId: null,
      tableId: null,
      items: [{ menuItemId: itemA, quantity: 1 }, { menuItemId: itemB, quantity: 1 }],
      occurredAt: new Date(),
    });
  }

  async function createCoupon(overrides: Partial<{ code: string; kind: string; value: string; minOrder: string | null; maxUses: number | null; expiresAt: Date | null; active: boolean }> = {}) {
    const id = randomUUID();
    const code = overrides.code ?? `P8-${randomUUID().slice(0, 8)}`;
    await withApp(T, (q) => q.query(
      `INSERT INTO coupons (id, tenant_id, code, discount_kind, discount_value, min_order_amount, max_uses, expires_at, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [id, T, code, overrides.kind ?? 'percentage', overrides.value ?? '10.0000', overrides.minOrder ?? null, overrides.maxUses ?? null, overrides.expiresAt ?? null, overrides.active ?? true],
    ));
    return { id, code };
  }

  // ── Payment methods ──────────────────────────────────────────────────────

  it('payment methods: foreign currency is cash-only and fully configured (engine + DB CHECKs)', async () => {
    // The engine validates the fx shape up front (fail-closed, no write)…
    await expect(methods.create(T, { name: 'bad', type: 'foreign_currency_cash', branchId: null, currencyCode: 'USD', fixedExchangeRate: null, isActive: true }))
      .rejects.toMatchObject({ code: 'validation.failed' });
    await expect(methods.create(T, { name: 'bad', type: 'card', branchId: null, currencyCode: 'USD', fixedExchangeRate: null, isActive: true }))
      .rejects.toMatchObject({ code: 'validation.failed' });
    await expect(methods.create(T, { name: 'bad', type: 'wallet', branchId: null, currencyCode: null, fixedExchangeRate: '1.00000000', isActive: true }))
      .rejects.toMatchObject({ code: 'validation.failed' });
    await expect(methods.create(T, { name: 'bad', type: 'foreign_currency_cash', branchId: null, currencyCode: 'USD', fixedExchangeRate: '0.00000000', isActive: true }))
      .rejects.toMatchObject({ code: 'validation.failed' });
    // …and the database re-verifies the same shape structurally (fx_shape CHECK),
    // whatever the code path.
    await expect(withApp(T, (q) => q.query(
      `INSERT INTO payment_methods (id, tenant_id, branch_id, name, type, currency_code, fixed_exchange_rate, is_active)
       VALUES ($1, $2, NULL, 'bad', 'card', 'USD', NULL, true)`,
      [randomUUID(), T],
    ))).rejects.toMatchObject({ code: '23514' });
    await expect(withApp(T, (q) => q.query(
      `INSERT INTO payment_methods (id, tenant_id, branch_id, name, type, currency_code, fixed_exchange_rate, is_active)
       VALUES ($1, $2, NULL, 'bad', 'foreign_currency_cash', 'USD', NULL, true)`,
      [randomUUID(), T],
    ))).rejects.toMatchObject({ code: '23514' });
  });

  it('every change of the manual fixed rate is appended to exchange_rates', async () => {
    const before = await owner.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM exchange_rates WHERE tenant_id = $1 AND from_currency = 'EUR'", [T],
    );
    const method = await methods.create(T, { name: 'يورو نقدي', type: 'foreign_currency_cash', branchId: null, currencyCode: 'EUR', fixedExchangeRate: '4.10000000', isActive: true });
    await methods.update(T, method.id, { fixedExchangeRate: '4.15000000' });
    await methods.update(T, method.id, { fixedExchangeRate: '4.15000000' }); // no-op: no new row
    await methods.update(T, method.id, { fixedExchangeRate: '4.20000000' });
    const after = await owner.query<{ rate: string; to_currency: string }>(
      "SELECT e.rate::text AS rate, e.to_currency AS to_currency FROM exchange_rates e WHERE e.tenant_id = $1 AND e.from_currency = 'EUR' ORDER BY e.effective_at, e.rate",
      [T],
    );
    // Initial provisioning + two real changes; the no-op added nothing.
    expect(Number(row(before.rows).count) + 3).toBe(after.rows.length);
    expect(after.rows.map((r) => r.rate)).toEqual(['4.10000000', '4.15000000', '4.20000000']);
    expect(after.rows.every((r) => r.to_currency === 'SAR')).toBe(true);
  });

  // ── Shifts: dual verification, atomicity, sums ───────────────────────────

  it('#4a rejects an open where the same person holds both verification roles', async () => {
    const branchId = randomUUID();
    await withApp(T, (q) => q.query("INSERT INTO branches (id, tenant_id, name, base_currency, timezone, country_code) VALUES ($1, $2, 'x', 'SAR', 'Asia/Riyadh', 'SA')", [branchId, T]));
    // Engine-level validation (before any write).
    await expect(shifts.openShift(T, {
      branchId, cashierUserId: cashierUser.userId, openedByUserId: opener.userId, openVerifiedByUserId: opener.userId,
      openedAt: new Date(), openCounts: [],
    })).rejects.toMatchObject({ code: 'validation.failed' });
    // Structural: the DB CHECK rejects it whatever the code path.
    await expect(withApp(T, (q) => q.query(
      `INSERT INTO shift_reconciliations (id, tenant_id, branch_id, cashier_id, opened_by_id, open_verified_by_id, opened_at, starting_float)
       VALUES ($1, $2, $3, $4, $5, $5, now(), 0)`,
      [randomUUID(), T, branchId, cashierUser.userId, opener.userId],
    ))).rejects.toMatchObject({ code: '23514' });
  });

  it('#7 no parallel open shifts for the same cashier (engine + partial unique index)', async () => {
    const first = await setupTill();
    // A second open for the SAME cashier is refused by the engine…
    const branch2 = randomUUID();
    await withApp(T, (q) => q.query("INSERT INTO branches (id, tenant_id, name, base_currency, timezone, country_code) VALUES ($1, $2, 'x', 'SAR', 'Asia/Riyadh', 'SA')", [branch2, T]));
    await expect(shifts.openShift(T, {
      branchId: branch2, cashierUserId: first.cashierId, openedByUserId: opener.userId, openVerifiedByUserId: verifier.userId,
      openedAt: new Date(), openCounts: [],
    })).rejects.toMatchObject({ code: 'conflict' });
    // …and structurally by the partial unique index, whatever the code path.
    await expect(withApp(T, (q) => q.query(
      `INSERT INTO shift_reconciliations (id, tenant_id, branch_id, cashier_id, opened_by_id, open_verified_by_id, opened_at, starting_float)
       VALUES ($1, $2, $3, $4, $5, $6, now(), 0)`,
      [randomUUID(), T, branch2, first.cashierId, opener.userId, verifier.userId],
    ))).rejects.toMatchObject({ code: '23505' });
    // A DIFFERENT cashier may hold their own open shift at the same time.
    const other = await createPlainUser('7777');
    await expect(shifts.openShift(T, {
      branchId: branch2, cashierUserId: other.userId, openedByUserId: opener.userId, openVerifiedByUserId: verifier.userId,
      openedAt: new Date(), openCounts: [],
    })).resolves.toMatchObject({ status: 'open' });
  });

  it('#8a starting_float matches the open cash count (atomic open, deferred verification)', async () => {
    // 5×10.00 + 3×50.00 = 200.00 SAR.
    const till = await setupTill([{ denominationValue: '10.00', quantity: 5 }, { denominationValue: '50.00', quantity: 3 }]);
    const shift = await shifts.xReport(T, till.shiftId);
    expect(shift.shift.startingFloat).toBe('200.00');
    expect(shift.counts.filter((c) => c.countType === 'open')).toHaveLength(2);
    expect(shift.counts.map((c) => c.subtotal).sort()).toEqual(['150.00', '50.00']);

    // A post-hoc count row that breaks the sum is rejected AT COMMIT (the
    // deferred constraint trigger), whatever the code path.
    await expect(owner.query(
      `INSERT INTO cash_count_details (id, tenant_id, shift_reconciliation_id, count_type, denomination_value, quantity)
       VALUES ($1, $2, $3, 'open', 100.00, 1)`,
      [randomUUID(), T, till.shiftId],
    )).rejects.toMatchObject({ code: '23514' });
  });

  it('#5 + #8b the Z-Report close: dual verification, counted_cash, variance, immutability', async () => {
    const till = await setupTill([{ denominationValue: '100.00', quantity: 2 }]); // float 200.00
    const order = await newOrder(till); // total 46.00
    await payments.recordPayment(T, {
      orderId: order.order.id, paymentMethodId: methodCashId, cashierUserId: till.cashierId, amountText: '46.00',
    });

    // #4b: one person cannot close and verify the same close.
    await expect(shifts.closeShift(T, {
      shiftId: till.shiftId, closedByUserId: opener.userId, closeVerifiedByUserId: opener.userId,
      closedAt: new Date(), closeCounts: [], notes: null,
    })).rejects.toMatchObject({ code: 'validation.failed' });

    // A structural close with the wrong recorded_cash_sales is rejected.
    await expect(owner.query(
      `UPDATE shift_reconciliations SET status = 'closed', closed_by_id = $3, close_verified_by_id = $4, closed_at = now(),
              counted_cash = 246.00, recorded_cash_sales = 999.00, variance_type = 'overage'
        WHERE id = $2 AND tenant_id = $1`,
      [T, till.shiftId, opener.userId, verifier.userId],
    )).rejects.toMatchObject({ code: '23514' });

    // The real Z Report: counted 250.00 ⇒ variance = 250 − 200 − 46 = +4 overage.
    const closed = await shifts.closeShift(T, {
      shiftId: till.shiftId, closedByUserId: opener.userId, closeVerifiedByUserId: verifier.userId,
      closedAt: new Date(), closeCounts: [{ denominationValue: '250.00', quantity: 1 }], notes: 'جرد صحي',
    });
    expect(closed.status).toBe('closed');
    expect(closed.countedCash).toBe('250.00');
    expect(closed.recordedCashSales).toBe('46.00');
    expect(closed.variance).toBe('4.00');
    expect(closed.varianceType).toBe('overage');

    // #5: after the close, the row is immutable — UPDATE and DELETE are rejected.
    await expect(owner.query("UPDATE shift_reconciliations SET notes = 'tampered' WHERE id = $1 AND tenant_id = $2", [till.shiftId, T]))
      .rejects.toMatchObject({ code: '55006' });
    await expect(owner.query('DELETE FROM shift_reconciliations WHERE id = $1 AND tenant_id = $2', [till.shiftId, T]))
      .rejects.toMatchObject({ code: '55006' });
    // The counts are append-only evidence, and never writable after the close.
    await expect(owner.query(
      `INSERT INTO cash_count_details (id, tenant_id, shift_reconciliation_id, count_type, denomination_value, quantity)
       VALUES ($1, $2, $3, 'close', 50.00, 1)`,
      [randomUUID(), T, till.shiftId],
    )).rejects.toMatchObject({ code: '23514' });
  });

  it('shortage variance and the X-Report read-only contract', async () => {
    const till = await setupTill([{ denominationValue: '100.00', quantity: 1 }]); // float 100.00
    const order = await newOrder(till);
    await payments.recordPayment(T, {
      orderId: order.order.id, paymentMethodId: methodCashId, cashierUserId: till.cashierId, amountText: '46.00',
    });

    // X Report: READ ONLY — live sales, no stored close columns, no resets.
    const signatureSql = "SELECT concat_ws('|', status, coalesce(closed_by_id::text, ''), coalesce(close_verified_by_id::text, ''), coalesce(closed_at::text, ''), coalesce(counted_cash::text, ''), coalesce(recorded_cash_sales::text, ''), coalesce(variance_type, ''), coalesce(notes, '')) AS sig FROM shift_reconciliations WHERE id = $1 AND tenant_id = $2";
    const before = await owner.query<{ sig: string }>(signatureSql, [till.shiftId, T]);
    const x1 = await shifts.xReport(T, till.shiftId);
    expect(x1.shift.status).toBe('open');
    expect(x1.shift.countedCash).toBeNull();
    expect(x1.shift.recordedCashSales).toBeNull();
    expect(x1.recordedCashSales).toBe('46.00'); // live figure, nothing stored
    expect(x1.computedVariance).toBe('-146.00'); // live: counted 0 − float 100 − sales 46
    expect(x1.computedVarianceType).toBe('shortage');
    const after = await owner.query<{ sig: string }>(signatureSql, [till.shiftId, T]);
    expect(row(before.rows).sig).toBe(row(after.rows).sig); // every stored column identical: zero writes

    // Close with a shortage: counted 145.00 − float 100.00 − sales 46.00 = −1.00.
    const closed = await shifts.closeShift(T, {
      shiftId: till.shiftId, closedByUserId: opener.userId, closeVerifiedByUserId: verifier.userId,
      closedAt: new Date(), closeCounts: [{ denominationValue: '145.00', quantity: 1 }], notes: null,
    });
    expect(closed.variance).toBe('-1.00');
    expect(closed.varianceType).toBe('shortage');
  });

  // ── The shift gateway ────────────────────────────────────────────────────

  it('the gateway: no new order and no payment without the cashier standing OPEN shift', async () => {
    const branchId = randomUUID();
    const stationId = randomUUID();
    await withApp(T, async (q) => {
      await q.query("INSERT INTO branches (id, tenant_id, name, base_currency, timezone, country_code) VALUES ($1, $2, 'x', 'SAR', 'Asia/Riyadh', 'SA')", [branchId, T]);
      await q.query('INSERT INTO stations (id, tenant_id, branch_id, name) VALUES ($1, $2, $3, $4)', [stationId, T, branchId, 'main']);
      await q.query('INSERT INTO station_routing_rules (id, tenant_id, branch_id, station_id, menu_item_id) VALUES ($1, $2, $3, $4, $5)', [randomUUID(), T, branchId, stationId, itemA]);
    });
    const noShiftCashier = await createPlainUser('8888');

    // No open shift at all ⇒ no new order (fail-closed).
    await expect(creation.create(T, {
      branchId, cashierUserId: noShiftCashier.userId, orderType: 'dine_in', salesChannelCode: 'dine_in',
      deliveryPlatformId: null, tableId: null, items: [{ menuItemId: itemA, quantity: 1 }], occurredAt: new Date(),
    })).rejects.toBeInstanceOf(CashierShiftRequiredError);

    // A shift at ANOTHER branch does not satisfy this branch's gateway.
    const otherTill = await setupTill();
    await expect(creation.create(T, {
      branchId, cashierUserId: otherTill.cashierId, orderType: 'dine_in', salesChannelCode: 'dine_in',
      deliveryPlatformId: null, tableId: null, items: [{ menuItemId: itemA, quantity: 1 }], occurredAt: new Date(),
    })).rejects.toBeInstanceOf(CashierShiftRequiredError);

    // With the standing open shift, the order is created…
    const shift = await shifts.openShift(T, {
      branchId, cashierUserId: noShiftCashier.userId, openedByUserId: opener.userId, openVerifiedByUserId: verifier.userId,
      openedAt: new Date(), openCounts: [],
    });
    const order = await creation.create(T, {
      branchId, cashierUserId: noShiftCashier.userId, orderType: 'dine_in', salesChannelCode: 'dine_in',
      deliveryPlatformId: null, tableId: null, items: [{ menuItemId: itemA, quantity: 1 }], occurredAt: new Date(),
    });
    expect(order.order.paymentStatus).toBe('open');

    // …but a payment by a DIFFERENT cashier (no open shift) is refused.
    await expect(payments.recordPayment(T, {
      orderId: order.order.id, paymentMethodId: methodCashId, cashierUserId: cashierUser.userId, amountText: '10.00',
    })).rejects.toBeInstanceOf(CashierShiftRequiredError);

    // Structurally: a payment can never land on a CLOSED shift, whatever the path.
    await shifts.closeShift(T, {
      shiftId: shift.id, closedByUserId: opener.userId, closeVerifiedByUserId: verifier.userId,
      closedAt: new Date(), closeCounts: [], notes: null,
    });
    await expect(payments.recordPayment(T, {
      orderId: order.order.id, paymentMethodId: methodCashId, cashierUserId: noShiftCashier.userId, amountText: '10.00',
    })).rejects.toBeInstanceOf(CashierShiftRequiredError);
    await expect(withApp(T, (q) => q.query(
      `INSERT INTO payments (id, tenant_id, order_id, payment_method_id, amount, amount_in_base_currency, shift_id, created_by)
       VALUES ($1, $2, $3, $4, 10.00, 10.00, $5, $6)`,
      [randomUUID(), T, order.order.id, methodCashId, shift.id, noShiftCashier.userId],
    ))).rejects.toMatchObject({ code: '23514' });
  });

  // ── Payments: totals, change, FX, immutability, lifecycle ────────────────

  it('recordPayment: cash with change, exact totals (pseudocode steps 6–8), payment_status=paid', async () => {
    const till = await setupTill();
    const order = await newOrder(till); // 25.00 + 15.00 + 15% VAT = 46.00

    const totals = await payments.orderTotals(T, order.order.id);
    expect(totals.subtotalMinor).toBe(4000n);
    expect(totals.taxMinor).toBe(600n);
    expect(totals.totalMinor).toBe(4600n);
    expect(totals.remainingBalanceMinor).toBe(4600n);

    // Over-tender 50.00 in cash ⇒ change 4.00 (base currency), net 46.00.
    const recorded = await payments.recordPayment(T, {
      orderId: order.order.id, paymentMethodId: methodCashId, cashierUserId: till.cashierId, amountText: '50.00',
    });
    expect(recorded.changeGivenMinor).toBe(400n);
    expect(recorded.payment.amount).toBe('50.00');
    expect(recorded.payment.amountInBaseCurrency).toBe('46.00');
    expect(recorded.payment.changeGivenAmount).toBe('4.00');
    expect(recorded.payment.exchangeRateSnapshot).toBeNull();
    expect(recorded.payment.status).toBe('completed');
    expect(recorded.remainingBalanceMinor).toBe(0n);

    const stored = await owner.query<{ payment_status: string }>('SELECT payment_status FROM orders WHERE id = $1 AND tenant_id = $2', [order.order.id, T]);
    expect(row(stored.rows).payment_status).toBe('paid');

    // Collecting beyond the balance is refused (fail-closed).
    await expect(payments.recordPayment(T, {
      orderId: order.order.id, paymentMethodId: methodCardId, cashierUserId: till.cashierId, amountText: '1.00',
    })).rejects.toBeInstanceOf(PaymentExceedsBalanceError);
  });

  it('foreign-currency cash: manual fixed rate snapshot, change in base currency, #6 immutable snapshot', async () => {
    const till = await setupTill();
    const order = await newOrder(till); // total 46.00 SAR
    // Tender 20.00 USD × 3.75 = 75.00 SAR ⇒ change 29.00 SAR, net 46.00 SAR.
    const recorded = await payments.recordPayment(T, {
      orderId: order.order.id, paymentMethodId: methodUsdId, cashierUserId: till.cashierId, amountText: '20.00',
    });
    expect(recorded.payment.amount).toBe('20.00');
    expect(recorded.payment.exchangeRateSnapshot).toBe('3.75000000');
    expect(recorded.payment.amountInBaseCurrency).toBe('46.00');
    expect(recorded.payment.changeGivenAmount).toBe('29.00');
    expect(recorded.changeGivenMinor).toBe(2900n);
    expect(recorded.remainingBalanceMinor).toBe(0n);

    // #6: the snapshot is frozen forever — even a later rate change on the
    // method never re-values the recorded payment, and any UPDATE of the
    // snapshot (or the amounts) is rejected.
    await methods.update(T, methodUsdId, { fixedExchangeRate: '3.80000000' });
    const stored = await owner.query<{ exchange_rate_snapshot: string }>('SELECT exchange_rate_snapshot::text FROM payments WHERE id = $1 AND tenant_id = $2', [recorded.payment.id, T]);
    expect(row(stored.rows).exchange_rate_snapshot).toBe('3.75000000');

    await expect(owner.query('UPDATE payments SET exchange_rate_snapshot = 4.00000000 WHERE id = $1 AND tenant_id = $2', [recorded.payment.id, T]))
      .rejects.toMatchObject({ code: '42501' });
    await expect(owner.query('UPDATE payments SET amount = 21.00 WHERE id = $1 AND tenant_id = $2', [recorded.payment.id, T]))
      .rejects.toMatchObject({ code: '42501' });
    await expect(owner.query('DELETE FROM payments WHERE id = $1 AND tenant_id = $2', [recorded.payment.id, T]))
      .rejects.toMatchObject({ code: '55006' });

    // A payment with a snapshot that does NOT copy the method's live rate is
    // rejected at insert (the validation trigger).
    const order2 = await newOrder(till);
    await expect(withApp(T, (q) => q.query(
      `INSERT INTO payments (id, tenant_id, order_id, payment_method_id, amount, amount_in_base_currency, exchange_rate_snapshot, shift_id, created_by)
       VALUES ($1, $2, $3, $4, 20.00, 75.00, 9.00000000, $5, $6)`,
      [randomUUID(), T, order2.order.id, methodUsdId, till.shiftId, till.cashierId],
    ))).rejects.toMatchObject({ code: '23514' });
    // Card methods never carry a rate or change.
    await expect(withApp(T, (q) => q.query(
      `INSERT INTO payments (id, tenant_id, order_id, payment_method_id, amount, amount_in_base_currency, exchange_rate_snapshot, change_given_amount, shift_id, created_by)
       VALUES ($1, $2, $3, $4, 10.00, 10.00, 3.75000000, 1.00, $5, $6)`,
      [randomUUID(), T, order2.order.id, methodCardId, till.shiftId, till.cashierId],
    ))).rejects.toMatchObject({ code: '23514' });
  });

  it('split payments across methods (card + cash) and the Void Payment → Reopen sequence', async () => {
    const till = await setupTill();
    const order = await newOrder(till); // 46.00

    // Split: card 20.00 then cash 26.00 (tendered exactly).
    const card = await payments.recordPayment(T, { orderId: order.order.id, paymentMethodId: methodCardId, cashierUserId: till.cashierId, amountText: '20.00' });
    expect(card.remainingBalanceMinor).toBe(2600n);
    expect(card.payment.changeGivenAmount).toBeNull();
    const cash = await payments.recordPayment(T, { orderId: order.order.id, paymentMethodId: methodCashId, cashierUserId: till.cashierId, amountText: '26.00' });
    expect(cash.remainingBalanceMinor).toBe(0n);
    expect((await owner.query<{ payment_status: string }>('SELECT payment_status FROM orders WHERE id = $1 AND tenant_id = $2', [order.order.id, T])).rows[0]?.payment_status).toBe('paid');

    // Void Payment (payments:void) → the order reopens for re-collection.
    const voided = await payments.voidPayment(T, actor(till.cashier), { paymentId: card.payment.id, reason: 'بطاقة مرفوضة' });
    expect(voided.status).toBe('voided');
    expect(voided.voidedById).toBe(till.cashier.userId);
    expect(voided.voidReason).toBe('بطاقة مرفوضة');
    expect((await owner.query<{ payment_status: string }>('SELECT payment_status FROM orders WHERE id = $1 AND tenant_id = $2', [order.order.id, T])).rows[0]?.payment_status).toBe('open');

    // Terminal statuses: a voided payment cannot move again.
    await expect(payments.voidPayment(T, actor(till.cashier), { paymentId: card.payment.id, reason: 'مرة أخرى' }))
      .rejects.toMatchObject({ code: 'validation.failed' });

    // Refund (payments:refund — the spec-mandated SENSITIVE key): the missing
    // permission is refused; the holder refunds and the audit row is written.
    await expect(payments.refundPayment(T, actor(cashierUser), { paymentId: cash.payment.id })).rejects.toMatchObject({ code: 'forbidden' });
    const refunded = await payments.refundPayment(T, actor(till.cashier), { paymentId: cash.payment.id });
    expect(refunded.status).toBe('refunded');
    expect(refunded.voidedById).toBeNull(); // refund evidence lives in audit_log
    const audit = await owner.query<{ action: string }>(
      "SELECT action FROM audit_log WHERE tenant_id = $1 AND resource = $2 AND action = 'payments.refund'", [T, `payments/${cash.payment.id}`],
    );
    expect(audit.rows).toHaveLength(1);

    // Re-collect the voided leg, then refund it: with a VOIDED row still on
    // the ledger the order is NOT 'every payment refunded' — it reopens
    // (balance unpaid, re-collection required).
    const reCollected = await payments.recordPayment(T, { orderId: order.order.id, paymentMethodId: methodCardId, cashierUserId: till.cashierId, amountText: '20.00' });
    await payments.refundPayment(T, actor(till.cashier), { paymentId: reCollected.payment.id });
    expect((await owner.query<{ payment_status: string }>('SELECT payment_status FROM orders WHERE id = $1 AND tenant_id = $2', [order.order.id, T])).rows[0]?.payment_status).toBe('open');

    // A clean order whose EVERY payment is refunded ⇒ 'refunded' (full return of funds).
    const cleanOrder = await newOrder(till);
    const cleanPayment = await payments.recordPayment(T, { orderId: cleanOrder.order.id, paymentMethodId: methodCardId, cashierUserId: till.cashierId, amountText: '46.00' });
    await payments.refundPayment(T, actor(till.cashier), { paymentId: cleanPayment.payment.id });
    expect((await owner.query<{ payment_status: string }>('SELECT payment_status FROM orders WHERE id = $1 AND tenant_id = $2', [cleanOrder.order.id, T])).rows[0]?.payment_status).toBe('refunded');
  });

  it('payment lifecycle changes are impossible after the shift closes (Z-Report numbers are final)', async () => {
    const till = await setupTill();
    const order = await newOrder(till);
    const recorded = await payments.recordPayment(T, { orderId: order.order.id, paymentMethodId: methodCashId, cashierUserId: till.cashierId, amountText: '46.00' });
    await shifts.closeShift(T, {
      shiftId: till.shiftId, closedByUserId: opener.userId, closeVerifiedByUserId: verifier.userId,
      closedAt: new Date(), closeCounts: [{ denominationValue: '246.00', quantity: 1 }], notes: null,
    });
    // The acting cashier holds no OPEN shift at the order's branch anymore —
    // the engine's same-branch reversal gate refuses with the explicit error.
    await expect(payments.refundPayment(T, actor(till.cashier), { paymentId: recorded.payment.id }))
      .rejects.toBeInstanceOf(CashierShiftRequiredError);
    await expect(payments.voidPayment(T, actor(till.cashier), { paymentId: recorded.payment.id, reason: 'x' }))
      .rejects.toBeInstanceOf(CashierShiftRequiredError);
    // Structurally, whatever the code path: the DB guard also refuses the
    // lifecycle change once the shift is closed (the Z-Report numbers are final).
    await expect(withApp(T, (q) => q.query("UPDATE payments SET status = 'refunded' WHERE id = $1 AND tenant_id = $2", [recorded.payment.id, T])))
      .rejects.toMatchObject({ code: '23514' });
  });

  it('a reversal is attributed to the SAME branch: an actor whose open shift is elsewhere is refused (fail-closed)', async () => {
    const tillA = await setupTill();
    const order = await newOrder(tillA);
    const recorded = await payments.recordPayment(T, { orderId: order.order.id, paymentMethodId: methodCashId, cashierUserId: tillA.cashierId, amountText: '46.00' });

    // A senior cashier holding the permissions AND a standing open shift —
    // but at a DIFFERENT branch: the reversal of branch-A money must never be
    // attributed to another branch's drawer.
    const tillB = await setupTill();
    await expect(payments.refundPayment(T, actor(tillB.cashier), { paymentId: recorded.payment.id }))
      .rejects.toBeInstanceOf(CashierShiftRequiredError);
    await expect(payments.voidPayment(T, actor(tillB.cashier), { paymentId: recorded.payment.id, reason: 'فرع خاطئ' }))
      .rejects.toBeInstanceOf(CashierShiftRequiredError);

    // Nothing moved: the payment is still completed and the order still paid.
    const stored = await owner.query<{ status: string }>('SELECT status FROM payments WHERE id = $1 AND tenant_id = $2', [recorded.payment.id, T]);
    expect(row(stored.rows).status).toBe('completed');
    expect((await owner.query<{ payment_status: string }>('SELECT payment_status FROM orders WHERE id = $1 AND tenant_id = $2', [order.order.id, T])).rows[0]?.payment_status).toBe('paid');

    // The same-branch actor — the till-A senior cashier standing in the open
    // shift at the order's branch — performs the reversal fine.
    const refunded = await payments.refundPayment(T, actor(tillA.cashier), { paymentId: recorded.payment.id });
    expect(refunded.status).toBe('refunded');
  });

  it('the Phase-7 void flow after a payment reversal: Void Payment → Reopen → void item → re-collection', async () => {
    const till = await setupTill();
    const order = await newOrder(till); // 25.00 + 15.00 + 15% VAT = 46.00
    const itemA_id = order.items[0]?.item.id;
    if (itemA_id === undefined) throw new Error('Expected the first order item');

    // Pay in full ⇒ 'paid'.
    await payments.recordPayment(T, { orderId: order.order.id, paymentMethodId: methodCashId, cashierUserId: till.cashierId, amountText: '46.00' });
    expect((await owner.query<{ payment_status: string }>('SELECT payment_status FROM orders WHERE id = $1 AND tenant_id = $2', [order.order.id, T])).rows[0]?.payment_status).toBe('paid');

    // While PAID, the Phase-7 item void stays fail-closed: the placeholder
    // demands a payment reversal first (engine + the 0027 DB trigger).
    await expect(voids.voidOrderItem(T, actor(voidServerUser), { orderItemId: itemA_id, voidReasonId: reasonServer }))
      .rejects.toBeInstanceOf(PaymentReversalRequiredError);

    // Void Payment (payments:void) ⇒ the order REOPENS for re-collection.
    const payment = await owner.query<{ id: string }>('SELECT id FROM payments WHERE tenant_id = $1 AND order_id = $2', [T, order.order.id]);
    await payments.voidPayment(T, actor(till.cashier), { paymentId: row(payment.rows).id, reason: 'خطأ في الطلب' });
    expect((await owner.query<{ payment_status: string }>('SELECT payment_status FROM orders WHERE id = $1 AND tenant_id = $2', [order.order.id, T])).rows[0]?.payment_status).toBe('open');

    // NOW the Phase-7 item void goes through on the reopened order…
    const audit = await voids.voidOrderItem(T, actor(voidServerUser), { orderItemId: itemA_id, voidReasonId: reasonServer });
    expect(audit.actorPermissionTier).toBe('server');
    expect(audit.orderPaymentStatusAtVoidTime).toBe('open');

    // …and the totals recompute over the ACTIVE items only: item B 15.00 +
    // 15% VAT = 17.25, with the voided payment contributing nothing.
    const totals = await payments.orderTotals(T, order.order.id);
    expect(totals.subtotalMinor).toBe(1500n);
    expect(totals.taxMinor).toBe(225n);
    expect(totals.totalMinor).toBe(1725n);
    expect(totals.remainingBalanceMinor).toBe(1725n);

    // Re-collection closes the loop: the reopened order is paid again.
    await payments.recordPayment(T, { orderId: order.order.id, paymentMethodId: methodCashId, cashierUserId: till.cashierId, amountText: '17.25' });
    expect((await owner.query<{ payment_status: string }>('SELECT payment_status FROM orders WHERE id = $1 AND tenant_id = $2', [order.order.id, T])).rows[0]?.payment_status).toBe('paid');
  });

  // ── Discounts: the binding pseudocode ────────────────────────────────────

  it('#1 discount capping never produces a negative remainder (DB + engine)', async () => {
    const till = await setupTill();
    const order = await newOrder(till); // subtotal 40.00
    // A fixed discount above the whole subtotal is capped at the subtotal by
    // the ENGINE… (zeroing out ⇒ escalation needed, see #2)
    await expect(discounts.applyDiscount(T, actor(discountUser), {
      orderId: order.order.id, mechanism: 'manual', discountKind: 'fixed_amount', discountValueText: '999.0000',
    })).rejects.toBeInstanceOf(DiscountOverrideRequiredError);
    // …and the DATABASE rejects any stored applied amount above the subtotal.
    await expect(withApp(T, (q) => q.query(
      `INSERT INTO order_discounts (id, tenant_id, order_id, mechanism, discount_kind, discount_value, discount_amount_applied, required_manager_override, manager_override_attempt_id, applied_by)
       VALUES ($1, $2, $3, 'manual', 'fixed_amount', 999.0000, 40.01, true, NULL, $4)`,
      [randomUUID(), T, order.order.id, discountUser.userId],
    ))).rejects.toMatchObject({ code: '23514' });
    // The discount actor must hold the atomic permission key (DB assertion).
    await expect(withApp(T, (q) => q.query(
      `INSERT INTO order_discounts (id, tenant_id, order_id, mechanism, discount_kind, discount_value, discount_amount_applied, required_manager_override, applied_by)
       VALUES ($1, $2, $3, 'manual', 'fixed_amount', 5.0000, 5.00, false, $4)`,
      [randomUUID(), T, order.order.id, cashierUser.userId],
    ))).rejects.toMatchObject({ code: '42501' });
  });

  it('#2 zeroing out the subtotal ALWAYS escalates — and the live Phase-7b override executes it', async () => {
    const till = await setupTill();
    const order = await newOrder(till); // subtotal 40.00

    // 100% zeroes out the subtotal: escalation is MANDATORY even though the
    // requested percentage sits inside the actor's 15% cap… (it does not:
    // 100% > 15%, so this exercises the 'both' reason).
    await expect(discounts.applyDiscount(T, actor(discountUser), {
      orderId: order.order.id, mechanism: 'manual', discountKind: 'percentage', discountValueText: '100.0000',
    })).rejects.toBeInstanceOf(DiscountOverrideRequiredError);

    // Zeroing out WITH the live manager PIN (Phase 7b, unmodified) succeeds
    // and stores the successful attempt id bound to the actor and the order.
    const zeroed = await discounts.applyDiscount(T, actor(discountUser), {
      orderId: order.order.id, mechanism: 'manual', discountKind: 'fixed_amount', discountValueText: '999.0000',
      managerOverride: { managerUserId: overrideManager.userId, managerOverridePin: overrideManager.pin },
    });
    expect(zeroed.requiredManagerOverride).toBe(true);
    expect(zeroed.discountAmountApplied).toBe('40.00');
    expect(zeroed.managerOverrideAttemptId).not.toBeNull();
    const attempt = await owner.query<{ outcome: string; initiating_actor_user_id: string; order_id: string; context_type: string }>(
      'SELECT outcome, initiating_actor_user_id, order_id, context_type FROM manager_override_attempts WHERE id = $1 AND tenant_id = $2',
      [zeroed.managerOverrideAttemptId, T],
    );
    expect(row(attempt.rows)).toMatchObject({ outcome: 'succeeded', initiating_actor_user_id: discountUser.userId, order_id: order.order.id, context_type: 'discount' });

    // The DB refuses a zeroing row WITHOUT the escalation evidence.
    const order2 = await newOrder(till);
    await expect(withApp(T, (q) => q.query(
      `INSERT INTO order_discounts (id, tenant_id, order_id, mechanism, discount_kind, discount_value, discount_amount_applied, required_manager_override, applied_by)
       VALUES ($1, $2, $3, 'manual', 'fixed_amount', 999.0000, 40.00, false, $4)`,
      [randomUUID(), T, order2.order.id, discountUser.userId],
    ))).rejects.toMatchObject({ code: '23514' });

    // An escalated row whose attempt is NOT successful is refused: create a
    // REAL failed attempt on the Phase-7b ledger (wrong PIN), then cite it.
    await expect(authenticator.verifyLiveChallenge(T, overrideManager.userId, '0000', discountUser.userId, 'discount', order2.order.id))
      .rejects.toMatchObject({ code: 'authorization.failed' });
    const failedAttempt = await owner.query<{ id: string }>(
      "SELECT id FROM manager_override_attempts WHERE tenant_id = $1 AND initiating_actor_user_id = $2 AND order_id = $3 AND outcome = 'failed_wrong_pin' ORDER BY created_at DESC LIMIT 1",
      [T, discountUser.userId, order2.order.id],
    );
    await expect(withApp(T, (q) => q.query(
      `INSERT INTO order_discounts (id, tenant_id, order_id, mechanism, discount_kind, discount_value, discount_amount_applied, required_manager_override, manager_override_attempt_id, applied_by)
       VALUES ($1, $2, $3, 'manual', 'fixed_amount', 999.0000, 40.00, true, $4, $5)`,
      [randomUUID(), T, order2.order.id, row(failedAttempt.rows).id, discountUser.userId],
    ))).rejects.toMatchObject({ code: '23514' });

    // Totals after a full zeroing: tax 0, total 0, remaining 0.
    const totals = await payments.orderTotals(T, order.order.id);
    expect(totals.discountedSubtotalMinor).toBe(0n);
    expect(totals.taxMinor).toBe(0n);
    expect(totals.totalMinor).toBe(0n);
  });

  it('override evidence is context-scoped: a void-context success never authorizes a discount', async () => {
    const till = await setupTill();
    const order = await newOrder(till); // subtotal 40.00

    // A SUCCESSFUL challenge of the same actor + manager + order, but issued
    // in the VOID context (e.g. a prior item-void override on this order).
    await authenticator.verifyLiveChallenge(T, overrideManager.userId, overrideManager.pin, discountUser.userId, 'void', order.order.id);
    const voidContextAttempt = await owner.query<{ id: string }>(
      "SELECT id FROM manager_override_attempts WHERE tenant_id = $1 AND initiating_actor_user_id = $2 AND target_manager_user_id = $3 AND order_id = $4 AND outcome = 'succeeded' AND context_type = 'void' ORDER BY created_at DESC LIMIT 1",
      [T, discountUser.userId, overrideManager.userId, order.order.id],
    );

    // A zeroing discount row citing that void-context success as its evidence
    // is rejected by the database (validate_order_discount, upgraded in
    // 0036): evidence must be a DISCOUNT-context attempt, whatever the code
    // path.
    await expect(withApp(T, (q) => q.query(
      `INSERT INTO order_discounts (id, tenant_id, order_id, mechanism, discount_kind, discount_value, discount_amount_applied, required_manager_override, manager_override_attempt_id, applied_by)
       VALUES ($1, $2, $3, 'manual', 'fixed_amount', 999.0000, 40.00, true, $4, $5)`,
      [randomUUID(), T, order.order.id, row(voidContextAttempt.rows).id, discountUser.userId],
    ))).rejects.toMatchObject({ code: '23514' });

    // The discount-context lookup never sees the void-context attempt: the
    // engine-side query (findSuccessfulOverrideAttemptId) is context-filtered.
    const discountContextHit = await owner.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM manager_override_attempts WHERE tenant_id = $1 AND initiating_actor_user_id = $2 AND target_manager_user_id = $3 AND order_id = $4 AND outcome = 'succeeded' AND context_type = 'discount'",
      [T, discountUser.userId, overrideManager.userId, order.order.id],
    );
    expect(row(discountContextHit.rows).count).toBe('0');
  });

  it('caps: within-cap applies without escalation; above-cap escalates; NULL kind = no authority', async () => {
    const till = await setupTill();
    const order = await newOrder(till); // subtotal 40.00

    // Within the caps (15% / 20.00): a 10% manual discount applies cleanly.
    const applied = await discounts.applyDiscount(T, actor(discountUser), {
      orderId: order.order.id, mechanism: 'manual', discountKind: 'percentage', discountValueText: '10.0000',
    });
    expect(applied.requiredManagerOverride).toBe(false);
    expect(applied.discountAmountApplied).toBe('4.00');
    expect(applied.managerOverrideAttemptId).toBeNull();

    // The DB re-verifies the caps: a non-escalated row above the cap is refused.
    const order2 = await newOrder(till);
    await expect(withApp(T, (q) => q.query(
      `INSERT INTO order_discounts (id, tenant_id, order_id, mechanism, discount_kind, discount_value, discount_amount_applied, required_manager_override, applied_by)
       VALUES ($1, $2, $3, 'manual', 'percentage', 50.0000, 20.00, false, $4)`,
      [randomUUID(), T, order2.order.id, discountUser.userId],
    ))).rejects.toMatchObject({ code: '23514' });
    // …and a NULL cap dimension is NOT granted: overrideManager HOLDS the
    // permission but has no caps row — the DB refuses to mint authority.
    await expect(withApp(T, (q) => q.query(
      `INSERT INTO order_discounts (id, tenant_id, order_id, mechanism, discount_kind, discount_value, discount_amount_applied, required_manager_override, applied_by)
       VALUES ($1, $2, $3, 'manual', 'fixed_amount', 1.0000, 1.00, false, $4)`,
      [randomUUID(), T, order2.order.id, overrideManager.userId],
    ))).rejects.toMatchObject({ code: '23514' });

    // Engine level: no caps row ⇒ no discount authority, even with the
    // permission held; and without the permission at all ⇒ forbidden up front.
    await expect(discounts.applyDiscount(T, actor(overrideManager), {
      orderId: order2.order.id, mechanism: 'manual', discountKind: 'percentage', discountValueText: '5.0000',
    })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(discounts.applyDiscount(T, actor(overrideManager), {
      orderId: order2.order.id, mechanism: 'manual', discountKind: 'fixed_amount', discountValueText: '1.0000',
    })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(discounts.applyDiscount(T, actor(cashierUser), {
      orderId: order2.order.id, mechanism: 'manual', discountKind: 'percentage', discountValueText: '5.0000',
    })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('the dual-cap cross gate: a fixed discount inside its own cap but over the percentage-equivalent escalates', async () => {
    const till = await setupTill();
    const order = await newOrder(till); // subtotal 40.00; actor caps: 15% / 20.00

    // Fixed 18.00 sits INSIDE the granted fixed cap (20.00) — the matching
    // gate passes — but equals 45% of the 40.00 basis, far above the granted
    // 15%: the CROSS gate demands a manager override.
    await expect(discounts.applyDiscount(T, actor(discountUser), {
      orderId: order.order.id, mechanism: 'manual', discountKind: 'fixed_amount', discountValueText: '18.0000',
    })).rejects.toBeInstanceOf(DiscountOverrideRequiredError);

    // With the live Phase-7b manager PIN (discount context), it goes through
    // and is recorded as an escalated discount.
    const escalated = await discounts.applyDiscount(T, actor(discountUser), {
      orderId: order.order.id, mechanism: 'manual', discountKind: 'fixed_amount', discountValueText: '18.0000',
      managerOverride: { managerUserId: overrideManager.userId, managerOverridePin: overrideManager.pin },
    });
    expect(escalated.requiredManagerOverride).toBe(true);
    expect(escalated.discountAmountApplied).toBe('18.00');
    expect(escalated.managerOverrideAttemptId).not.toBeNull();

    // A fixed 5.00 (12.5% of the basis, inside BOTH caps) never escalates.
    const order2 = await newOrder(till);
    const plain = await discounts.applyDiscount(T, actor(discountUser), {
      orderId: order2.order.id, mechanism: 'manual', discountKind: 'fixed_amount', discountValueText: '5.0000',
    });
    expect(plain.requiredManagerOverride).toBe(false);
    expect(plain.discountAmountApplied).toBe('5.00');
  });

  it('#3 stacking: rejected while disabled, coupon → manual while enabled, tax on the discounted base', async () => {
    const till = await setupTill();
    const order = await newOrder(till); // subtotal 40.00
    const coupon = await createCoupon({ kind: 'percentage', value: '10.0000' });

    // Default (allow_discount_stacking = false): the FIRST discount applies…
    const couponApplied = await discounts.applyDiscount(T, actor(discountUser), {
      orderId: order.order.id, mechanism: 'coupon', discountKind: 'percentage', discountValueText: '10.0000', couponCode: coupon.code,
    });
    expect(couponApplied.discountAmountApplied).toBe('4.00');
    expect(couponApplied.mechanism).toBe('coupon');
    // …and the SECOND is rejected outright (the DB stacking gate).
    await expect(discounts.applyDiscount(T, actor(discountUser), {
      orderId: order.order.id, mechanism: 'manual', discountKind: 'fixed_amount', discountValueText: '2.0000',
    })).rejects.toMatchObject({ code: '23514' });

    // Enable stacking: coupon → manual each re-run against the REMAINING subtotal.
    await owner.query('UPDATE tenants SET allow_discount_stacking = true WHERE id = $1', [T]);
    try {
      const order2 = await newOrder(till);
      const coupon2 = await createCoupon({ kind: 'percentage', value: '10.0000' });
      await discounts.applyDiscount(T, actor(discountUser), {
        orderId: order2.order.id, mechanism: 'coupon', discountKind: 'percentage', discountValueText: '10.0000', couponCode: coupon2.code,
      }); // −4.00 ⇒ remaining 36.00
      const manual = await discounts.applyDiscount(T, actor(discountUser), {
        orderId: order2.order.id, mechanism: 'manual', discountKind: 'fixed_amount', discountValueText: '5.0000',
      }); // −5.00 of the REMAINING 36.00 ⇒ 31.00
      expect(manual.discountAmountApplied).toBe('5.00');

      // Tax is recomputed on the DISCOUNTED bases: the 9.00 total discount is
      // allocated proportionally across the lines (A 25.00→19.37/19.38,
      // B 15.00→11.63/11.62), then per-line half-up VAT: 291 + 174 = 465
      // whichever side of the largest-remainder tie-break wins.
      const totals = await payments.orderTotals(T, order2.order.id);
      expect(totals.discountTotalMinor).toBe(900n);
      expect(totals.discountedSubtotalMinor).toBe(3100n);
      expect(totals.taxMinor).toBe(465n);
      expect(totals.totalMinor).toBe(3565n);
    } finally {
      await owner.query('UPDATE tenants SET allow_discount_stacking = false WHERE id = $1', [T]);
    }
  });

  it('coupons: expiry, use limits, minimum amount, uses_count, and the deferred points mechanism', async () => {
    const till = await setupTill();
    const order = await newOrder(till); // subtotal 40.00

    // Expired coupon → refused.
    const expired = await createCoupon({ kind: 'fixed_amount', value: '5.0000', expiresAt: new Date(Date.now() - 60_000) });
    await expect(discounts.applyDiscount(T, actor(discountUser), {
      orderId: order.order.id, mechanism: 'coupon', discountKind: 'fixed_amount', discountValueText: '5.0000', couponCode: expired.code,
    })).rejects.toMatchObject({ code: 'validation.failed' });

    // Minimum order amount not met (min 100.00 > subtotal 40.00) → refused.
    const minCoupon = await createCoupon({ kind: 'fixed_amount', value: '5.0000', minOrder: '100.00' });
    await expect(discounts.applyDiscount(T, actor(discountUser), {
      orderId: order.order.id, mechanism: 'coupon', discountKind: 'fixed_amount', discountValueText: '5.0000', couponCode: minCoupon.code,
    })).rejects.toMatchObject({ code: 'validation.failed' });

    // max_uses = 1: first use applies and increments uses_count…
    const single = await createCoupon({ kind: 'fixed_amount', value: '5.0000', maxUses: 1 });
    const applied = await discounts.applyDiscount(T, actor(discountUser), {
      orderId: order.order.id, mechanism: 'coupon', discountKind: 'fixed_amount', discountValueText: '5.0000', couponCode: single.code,
    });
    expect(applied.discountAmountApplied).toBe('5.00');
    const uses = await owner.query<{ uses_count: number }>('SELECT uses_count FROM coupons WHERE id = $1 AND tenant_id = $2', [single.id, T]);
    expect(row(uses.rows).uses_count).toBe(1);
    // …the second use is refused (engine coupon check; the DB re-verifies).
    const order2 = await newOrder(till);
    await expect(discounts.applyDiscount(T, actor(discountUser), {
      orderId: order2.order.id, mechanism: 'coupon', discountKind: 'fixed_amount', discountValueText: '5.0000', couponCode: single.code,
    })).rejects.toMatchObject({ code: 'validation.failed' });

    // Loyalty points: reserved vocabulary, deliberately deferred — the
    // explicit fail-closed refusal, never a silent zero.
    await expect(discounts.applyDiscount(T, actor(discountUser), {
      orderId: order2.order.id, mechanism: 'points', discountKind: 'fixed_amount', discountValueText: '1.0000',
    })).rejects.toBeInstanceOf(LoyaltyPointsDeferredError);
  });

  // ── Split tags ───────────────────────────────────────────────────────────

  it('split tags: display-only people count + the immutable light split group tag', async () => {
    const till = await setupTill();
    const created = await creation.create(T, {
      branchId: till.branchId,
      cashierUserId: till.cashierId,
      orderType: 'dine_in',
      salesChannelCode: 'dine_in',
      deliveryPlatformId: null,
      tableId: null,
      splitPeopleCount: 3,
      items: [
        { menuItemId: itemA, quantity: 1, splitGroupId: 'table-4/alice' },
        { menuItemId: itemB, quantity: 1, splitGroupId: 'table-4/bob' },
      ],
      occurredAt: new Date(),
    });
    expect(created.order.splitPeopleCount).toBe(3);
    expect(created.items.map((i) => i.item.splitGroupId)).toEqual(['table-4/alice', 'table-4/bob']);
    // The tag is purchase evidence: frozen after creation.
    await expect(owner.query("UPDATE order_items SET split_group_id = 'tampered' WHERE id = $1 AND tenant_id = $2", [created.items[0]?.item.id, T]))
      .rejects.toMatchObject({ code: '42501' });
    // An invalid people count is refused up front.
    await expect(creation.create(T, {
      branchId: till.branchId, cashierUserId: till.cashierId, orderType: 'dine_in', salesChannelCode: 'dine_in',
      deliveryPlatformId: null, tableId: null, splitPeopleCount: 0, items: [{ menuItemId: itemA, quantity: 1 }], occurredAt: new Date(),
    })).rejects.toMatchObject({ code: 'validation.failed' });
  });

  it('cash denominations are seeded per currency (global reference data)', async () => {
    const sar = await owner.query<{ value: string; label: string }>(
      "SELECT value::text AS value, label FROM currency_denominations cd WHERE cd.currency_code = 'SAR' ORDER BY cd.value",
    );
    expect(sar.rows.map((r) => r.value)).toContain('100.00');
    expect(sar.rows.length).toBeGreaterThanOrEqual(10);
    const kwd = await owner.query<{ value: string }>(
      "SELECT value::text AS value FROM currency_denominations cd WHERE cd.currency_code = 'KWD' ORDER BY cd.value",
    );
    // Only 2-decimal-representable KWD denominations exist (spec: NUMERIC(18,2)).
    expect(kwd.rows.map((r) => r.value)).toEqual(['0.05', '0.10', '0.25', '0.50', '1.00', '5.00', '10.00', '20.00']);
  });
});
