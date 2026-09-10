/**
 * B8 live acceptance: payment idempotency keys.
 *
 * T1 the same key twice (sequential) replays: same payment id, exactly one
 *    row, identical figures;
 * T2 the same key on a DIFFERENT order → 409 (a key is one operation);
 * T3 the same key with a different amount → 409;
 * T4 the same key concurrently: the B2 loser retries with the same key and
 *    converges to the SAME payment (exactly one row — the double-charge the
 *    pre-B8 retry would have caused);
 * T5 the same key with a conflicting explicit change → 409.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CatalogEngine } from '../../src/application/engines/catalog/catalog-engine.ts';
import { OrderCreationEngine } from '../../src/application/engines/orders/order-creation-engine.ts';
import { WorkflowAdminEngine } from '../../src/application/engines/orders/workflow-admin-engine.ts';
import { PaymentMethodsEngine } from '../../src/application/engines/payments/payment-methods-engine.ts';
import { PaymentsEngine } from '../../src/application/engines/payments/payments-engine.ts';
import { AuthorizationEngine } from '../../src/application/engines/rbac/authorization-engine.ts';
import { ShiftEngine } from '../../src/application/engines/shifts/shift-engine.ts';
import { PlatformTaxAdminEngine } from '../../src/application/engines/tax/platform-tax-admin-engine.ts';
import { createWithTenantContext, type WithTenantContext } from '../../src/infrastructure/db/tenant-context.ts';
import { createWithPlatformTaxContext } from '../../src/infrastructure/db/platform-tax-context.ts';
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
import { ConcurrencyRetryableError } from '../../src/shared/errors.ts';
import { currencyCode, money } from '../../src/shared/money.ts';
import { testDatabaseUrl } from '../support/database.ts';
import { grantKeys } from '../support/grant-keys.ts';

interface TillUser {
  readonly userId: string;
}

const PLATFORM_ACTOR = '71000000-0000-4000-8000-000000000005';
const PIN_PEPPER = Buffer.from(randomBytes(48));

describe('B8 payment idempotency (live)', () => {
  let owner: pg.Pool;
  let app: pg.Pool;
  let platformPool: pg.Pool;
  let withApp: WithTenantContext;
  let T: string;
  let catalog: CatalogEngine;
  let creation: OrderCreationEngine;
  let shifts: ShiftEngine;
  let payments: PaymentsEngine;
  let methods: PaymentMethodsEngine;
  let permWrite: PostgresPermissionWriteRepository;
  let itemId: string; // 40.00 SAR; 15% VAT ⇒ total 46.00
  let methodCashId: string;
  let opener: TillUser;
  let verifier: TillUser;

  beforeAll(async () => {
    owner = new pg.Pool({ connectionString: testDatabaseUrl(), max: 5 });
    T = randomUUID();
    await owner.query('INSERT INTO tenants (id, name) VALUES ($1, $2)', [T, 'b8-idempotency']);
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
    catalog = new CatalogEngine({ catalog: new PostgresCatalogRepository({ withTenantContext: withApp }), taxAssignments: new PostgresTenantTaxAdminRepository(withApp), authorization });
    const ordersStore = new PostgresOrdersStore({ withTenantContext: withApp });
    const workflowAdmin = new WorkflowAdminEngine({ store: ordersStore, authorization });
    shifts = new ShiftEngine({ store: new PostgresShiftsStore({ withTenantContext: withApp }), authorization });
    const authenticator = new PostgresManagerOverrideAuthenticator({ withTenantContext: withApp, pepper: PIN_PEPPER });
    payments = new PaymentsEngine({ store: new PostgresPaymentsStore({ withTenantContext: withApp }), authorization });
    creation = new OrderCreationEngine({ store: ordersStore, authorization, permissionRead: new PostgresPermissionReadRepository({ withTenantContext: withApp }), managerAuthenticator: authenticator });
    methods = new PaymentMethodsEngine({ store: new PostgresPaymentsStore({ withTenantContext: withApp }), authorization });
    permWrite = new PostgresPermissionWriteRepository({ withTenantContext: withApp });

    // Platform tax fixture: SA, per-line rounding, 15% exclusive VAT.
    const platform = new PlatformTaxAdminEngine(new PostgresPlatformTaxAdminRepository(createWithPlatformTaxContext(platformPool)));
    await platform.configureJurisdiction(PLATFORM_ACTOR, 'SA', 'per_line', true);
    const saCategory = await platform.createCategory(PLATFORM_ACTOR, {
      countryCode: 'SA', code: randomUUID(), kind: 'standard', taxFamily: 'vat', cascadePriority: 50,
      name: { en: 'B8 fixture VAT' }, isActive: true,
    });
    await platform.createTaxRate(PLATFORM_ACTOR, { taxCategoryId: saCategory.id, rateBps: 1500, isPriceInclusiveDefault: false, effectiveFrom: '2020-01-01', effectiveTo: null });
    await owner.query("UPDATE tenants SET vat_registration_status = 'registered', vat_registration_number = 'b8-vat' WHERE id = $1", [T]);

    await workflowAdmin.ensureWorkflow(T, [
      { kindCode: 'received', position: 10, label: { ar: 'مستلم' } },
      { kindCode: 'preparing', position: 20, label: { ar: 'قيد التحضير' } },
      { kindCode: 'ready', position: 30, label: { ar: 'جاهز' } },
      { kindCode: 'delivered', position: 40, label: { ar: 'تم التسليم' } },
    ]);

    opener = await createUser();
    verifier = await createUser();
    await grantKeys(permWrite, T, opener.userId, ['shift:open', 'catalog:write', 'payments:methods_admin']);

    const menuCategoryId = (await catalog.createCategory(T, opener.userId, { name: { ar: 'قائمة B8' } })).id;
    itemId = (await catalog.createItem(T, opener.userId, {
      categoryId: menuCategoryId, name: { ar: 'طبق B8' }, basePrice: money(4000n, currencyCode('SAR')), taxRuleId: saCategory.id,
    })).id;
    methodCashId = (await methods.create(T, opener.userId, { name: 'نقدي B8', type: 'cash', branchId: null, currencyCode: null, fixedExchangeRate: null, isActive: true })).id;
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
    await grantKeys(permWrite, T, cashier.userId, ['payments:collect']);
    await withApp(T, async (q) => {
      await q.query('INSERT INTO branches (id, tenant_id, name, base_currency, timezone, country_code) VALUES ($1, $2, $3, $4, $5, $6)', [branchId, T, `B8 ${randomUUID()}`, 'SAR', 'Asia/Riyadh', 'SA']);
      await q.query('INSERT INTO stations (id, tenant_id, branch_id, name) VALUES ($1, $2, $3, $4)', [stationId, T, branchId, 'main']);
      await q.query('INSERT INTO station_routing_rules (id, tenant_id, branch_id, station_id, menu_item_id) VALUES ($1, $2, $3, $4, $5)', [randomUUID(), T, branchId, stationId, itemId]);
    });
    const shift = await shifts.openShift(T, {
      branchId, cashierUserId: cashier.userId, openedByUserId: opener.userId, openVerifiedByUserId: verifier.userId,
      openedAt: new Date(), openCounts: [{ denominationValue: '100.00', quantity: 2 }],
    });
    return { branchId, cashier, shiftId: shift.id };
  }

  async function newOrder(branchId: string, cashierId: string): Promise<string> {
    const created = await creation.create(T, {
      branchId, cashierUserId: cashierId, orderType: 'dine_in', salesChannelCode: 'dine_in',
      deliveryPlatformId: null, tableId: null,
      items: [{ menuItemId: itemId, quantity: 1 }], occurredAt: new Date(),
    });
    return created.order.id;
  }

  async function paymentRowCount(orderId: string): Promise<number> {
    const result = await owner.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM payments WHERE tenant_id = $1 AND order_id = $2',
      [T, orderId],
    );
    return Number((result.rows[0] ?? { count: '0' }).count);
  }

  it('T1 the same key twice (sequential) replays: same id, one row, identical figures', async () => {
    const till = await setupTill();
    const orderId = await newOrder(till.branchId, till.cashier.userId);
    const key = `b8-t1-${randomUUID()}`;
    const first = await payments.recordPayment(T, {
      orderId, paymentMethodId: methodCashId, cashierUserId: till.cashier.userId, amountText: '46.00', idempotencyKey: key,
    });
    const second = await payments.recordPayment(T, {
      orderId, paymentMethodId: methodCashId, cashierUserId: till.cashier.userId, amountText: '46.00', idempotencyKey: key,
    });
    expect(second.payment.id).toBe(first.payment.id);
    expect(second.orderTotalMinor).toBe(first.orderTotalMinor);
    expect(second.remainingBalanceMinor).toBe(0n);
    expect(second.changeGivenMinor).toBe(first.changeGivenMinor);
    expect(await paymentRowCount(orderId)).toBe(1);
  });

  it('T2 the same key on a DIFFERENT order → 409 (a key is one operation)', async () => {
    const till = await setupTill();
    const orderA = await newOrder(till.branchId, till.cashier.userId);
    const orderB = await newOrder(till.branchId, till.cashier.userId);
    const key = `b8-t2-${randomUUID()}`;
    await payments.recordPayment(T, {
      orderId: orderA, paymentMethodId: methodCashId, cashierUserId: till.cashier.userId, amountText: '46.00', idempotencyKey: key,
    });
    await expect(payments.recordPayment(T, {
      orderId: orderB, paymentMethodId: methodCashId, cashierUserId: till.cashier.userId, amountText: '46.00', idempotencyKey: key,
    })).rejects.toMatchObject({ code: 'conflict', message: expect.stringContaining('different order or payment method') as unknown as string });
    expect(await paymentRowCount(orderB)).toBe(0);
  });

  it('T3 the same key with a different amount → 409 (and the order keeps its single payment)', async () => {
    const till = await setupTill();
    const orderId = await newOrder(till.branchId, till.cashier.userId);
    const key = `b8-t3-${randomUUID()}`;
    await payments.recordPayment(T, {
      orderId, paymentMethodId: methodCashId, cashierUserId: till.cashier.userId, amountText: '46.00', idempotencyKey: key,
    });
    await expect(payments.recordPayment(T, {
      orderId, paymentMethodId: methodCashId, cashierUserId: till.cashier.userId, amountText: '10.00', idempotencyKey: key,
    })).rejects.toMatchObject({ code: 'conflict', message: expect.stringContaining('different amount or change') as unknown as string });
    expect(await paymentRowCount(orderId)).toBe(1);
  });

  it('T4 the same key concurrently: the loser retries with the same key and converges to the SAME payment', async () => {
    const till = await setupTill();
    const orderId = await newOrder(till.branchId, till.cashier.userId);
    const key = `b8-t4-${randomUUID()}`;
    const attempt = () => payments.recordPayment(T, {
      orderId, paymentMethodId: methodCashId, cashierUserId: till.cashier.userId, amountText: '46.00', idempotencyKey: key,
    });
    const results = await Promise.allSettled([attempt(), attempt()]);
    const converged = [];
    for (const result of results) {
      if (result.status === 'fulfilled') {
        converged.push(result.value);
      } else {
        // The B2 serialization loser: a real client retries the 503 with the
        // SAME key — and must land on the recorded payment, not a new row.
        expect(result.reason).toBeInstanceOf(ConcurrencyRetryableError);
        converged.push(await attempt());
      }
    }
    expect(converged).toHaveLength(2);
    expect(converged[0]?.payment.id).toBe(converged[1]?.payment.id);
    expect(await paymentRowCount(orderId)).toBe(1);
  });

  it('T5 the same key with a conflicting explicit change → 409', async () => {
    const till = await setupTill();
    const orderId = await newOrder(till.branchId, till.cashier.userId);
    const key = `b8-t5-${randomUUID()}`;
    // Tender 50.00 on a 46.00 order: auto change 4.00, net 46.00.
    await payments.recordPayment(T, {
      orderId, paymentMethodId: methodCashId, cashierUserId: till.cashier.userId, amountText: '50.00', idempotencyKey: key,
    });
    await expect(payments.recordPayment(T, {
      orderId, paymentMethodId: methodCashId, cashierUserId: till.cashier.userId, amountText: '50.00',
      explicitChangeMinor: 0n, idempotencyKey: key,
    })).rejects.toMatchObject({ code: 'conflict', message: expect.stringContaining('different amount or change') as unknown as string });
    expect(await paymentRowCount(orderId)).toBe(1);
  });
});
