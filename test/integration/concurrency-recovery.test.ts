/**
 * B3 — concurrency recovery (LIVE, real PostgreSQL).
 *
 * Where B2 proves that races are DETECTED (exactly one winner), B3 proves that
 * the loser RECOVERS through a stable, client-safe contract:
 *
 * - T1 (lock_timeout): a collect piled behind a held shift lock fails FAST
 *   with `concurrency.retryable_conflict` / `55P03` — never the 30s statement
 *   timeout — and the SAME collect converges once the pile-up clears.
 * - T2 (deadlock): a deliberate lock-order inversion deadlocks; PostgreSQL
 *   aborts exactly one victim with `40P01`, and the survivor commits. The
 *   victim maps to the same retryable shape.
 * - T3 (per-shift ceiling): twelve concurrent collectors hammering ONE shift
 *   all converge with bounded client retries, and every order's end state is
 *   EXACT (3 payments × 46.00, payment_status paid). The retry budget below is
 *   the executable half of the documented per-branch ceiling.
 *
 * NOTE on helper overlap: the B2 DoubleCollect spec owns the "both submitted,
 * exactly one wins" postcondition. These tests assert the OPPOSITE direction
 * (the loser is retryable / the pile-up converges), so they keep their own
 * setup and assertions rather than sharing a helper whose contract differs.
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
import { isConcurrencyRetryableError } from '../../src/shared/errors.ts';
import { currencyCode, money } from '../../src/shared/money.ts';
import { testDatabaseUrl } from '../support/database.ts';
import { grantKeys } from '../support/grant-keys.ts';

const PLATFORM_ACTOR = '71000000-0000-4000-8000-000000000005';
let T: string; // dedicated B3 tenant (fresh per run)
const PIN_PEPPER = Buffer.from(randomBytes(48));

function row<R>(rows: readonly R[]): R {
  const first = rows[0];
  if (first === undefined) throw new Error('Expected database row');
  return first;
}

interface TillUser {
  readonly userId: string;
}

describe('B3 concurrency recovery (live)', () => {
  let owner: pg.Pool;
  let app: pg.Pool;
  let platformPool: pg.Pool;
  let withApp: WithTenantContext;
  let creation: OrderCreationEngine;
  let shifts: ShiftEngine;
  let payments: PaymentsEngine;
  let authorization: AuthorizationEngine;
  let itemId: string; // 40.00 SAR; 15% VAT ⇒ total 46.00
  let methodCashId: string;
  let permWrite: PostgresPermissionWriteRepository;
  let opener: TillUser;
  let verifier: TillUser;

  beforeAll(async () => {
    owner = new pg.Pool({ connectionString: testDatabaseUrl(), max: 5 });
    T = randomUUID();
    await owner.query('INSERT INTO tenants (id, name) VALUES ($1, $2)', [T, 'b3-recovery']);
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

    authorization = new AuthorizationEngine({ read: new PostgresPermissionReadRepository({ withTenantContext: withApp }), hash: sha256Hex });
    const catalog = new CatalogEngine({ catalog: new PostgresCatalogRepository({ withTenantContext: withApp }), taxAssignments: new PostgresTenantTaxAdminRepository(withApp), authorization });
    const ordersStore = new PostgresOrdersStore({ withTenantContext: withApp });
    shifts = new ShiftEngine({ store: new PostgresShiftsStore({ withTenantContext: withApp }), authorization });
    const authenticator = new PostgresManagerOverrideAuthenticator({ withTenantContext: withApp, pepper: PIN_PEPPER });
    payments = new PaymentsEngine({ store: new PostgresPaymentsStore({ withTenantContext: withApp }), authorization });
    creation = new OrderCreationEngine({ store: ordersStore, authorization, managerAuthenticator: authenticator });
    const methods = new PaymentMethodsEngine({ store: new PostgresPaymentsStore({ withTenantContext: withApp }), authorization });

    // Platform tax fixture: SA, per-line rounding, 15% exclusive VAT.
    const platform = new PlatformTaxAdminEngine(new PostgresPlatformTaxAdminRepository(createWithPlatformTaxContext(platformPool)));
    await platform.configureJurisdiction(PLATFORM_ACTOR, 'SA', 'per_line', true);
    const saCategory = await platform.createCategory(PLATFORM_ACTOR, {
      countryCode: 'SA', code: randomUUID(), kind: 'standard', taxFamily: 'vat', cascadePriority: 50,
      name: { en: 'B3 fixture VAT' }, isActive: true,
    });
    await platform.createTaxRate(PLATFORM_ACTOR, { taxCategoryId: saCategory.id, rateBps: 1500, isPriceInclusiveDefault: false, effectiveFrom: '2020-01-01', effectiveTo: null });
    await owner.query("UPDATE tenants SET vat_registration_status = 'registered', vat_registration_number = 'b3-vat' WHERE id = $1", [T]);

    // Order creation requires an enabled workflow with an initial state.
    const workflowAdmin = new WorkflowAdminEngine({ store: ordersStore });
    await workflowAdmin.ensureWorkflow(T, [
      { kindCode: 'received', position: 10, label: { ar: 'مستلم' } },
      { kindCode: 'preparing', position: 20, label: { ar: 'قيد التحضير' } },
      { kindCode: 'ready', position: 30, label: { ar: 'جاهز' } },
      { kindCode: 'delivered', position: 40, label: { ar: 'تم التسليم' } },
    ]);

    opener = await createUser();
    verifier = await createUser();
    permWrite = new PostgresPermissionWriteRepository({ withTenantContext: withApp });
    await grantKeys(permWrite, T, opener.userId, ['shift:open', 'catalog:write', 'payments:methods_admin']);

    const menuCategoryId = (await catalog.createCategory(T, opener.userId, { name: { ar: 'قائمة B3' } })).id;
    itemId = (await catalog.createItem(T, opener.userId, {
      categoryId: menuCategoryId, name: { ar: 'طبق B3' }, basePrice: money(4000n, currencyCode('SAR')), taxRuleId: saCategory.id,
    })).id;

    methodCashId = (await methods.create(T, opener.userId, { name: 'نقدي B3', type: 'cash', branchId: null, currencyCode: null, fixedExchangeRate: null, isActive: true })).id;
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
      await q.query('INSERT INTO branches (id, tenant_id, name, base_currency, timezone, country_code) VALUES ($1, $2, $3, $4, $5, $6)', [branchId, T, `B3 ${randomUUID()}`, 'SAR', 'Asia/Riyadh', 'SA']);
      await q.query('INSERT INTO stations (id, tenant_id, branch_id, name) VALUES ($1, $2, $3, $4)', [stationId, T, branchId, 'main']);
      await q.query('INSERT INTO station_routing_rules (id, tenant_id, branch_id, station_id, menu_item_id) VALUES ($1, $2, $3, $4, $5)', [randomUUID(), T, branchId, stationId, itemId]);
    });
    const shift = await shifts.openShift(T, {
      branchId, cashierUserId: cashier.userId, openedByUserId: opener.userId, openVerifiedByUserId: verifier.userId,
      openedAt: new Date(), openCounts: [{ denominationValue: '100.00', quantity: 2 }],
    });
    return { branchId, cashier, shiftId: shift.id };
  }

  async function newOrder(branchId: string, cashierId: string) {
    return creation.create(T, {
      branchId, cashierUserId: cashierId, orderType: 'dine_in', salesChannelCode: 'dine_in',
      deliveryPlatformId: null, tableId: null,
      items: [{ menuItemId: itemId, quantity: 1 }], occurredAt: new Date(),
    });
  }

  it('T1 engine-level lock_timeout: a piled-up collect fails fast retryable, then converges', async () => {
    const till = await setupTill();
    const created = await newOrder(till.branchId, till.cashier.userId);
    const orderId = created.order.id;

    // A second connection holds the shift row lock, simulating a pile-up
    // behind a slow committer.
    const holder = await app.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT set_config($1, $2, true)', ['app.current_tenant_id', T]);
      await holder.query('SELECT id FROM shift_reconciliations WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [
        T,
        till.shiftId,
      ]);

      const impatientPayments = new PaymentsEngine({
        store: new PostgresPaymentsStore({ withTenantContext: withApp, lockTimeoutMs: 150 }),
        authorization,
      });
      const start = Date.now();
      const failure = await impatientPayments
        .recordPayment(T, {
          orderId, paymentMethodId: methodCashId, cashierUserId: till.cashier.userId, amountText: '46.00',
        })
        .then(
          () => null,
          (error: unknown) => error,
        );
      const elapsedMs = Date.now() - start;

      expect(isConcurrencyRetryableError(failure)).toBe(true);
      expect(failure).toMatchObject({ code: 'concurrency.retryable_conflict', pgCode: '55P03' });
      // The 150ms lock bound fails FAST: nowhere near the 30s statement timeout.
      expect(elapsedMs).toBeLessThan(10_000);
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }

    // Recovery: with the pile-up gone, the SAME collect converges first try.
    const paid = await payments.recordPayment(T, {
      orderId, paymentMethodId: methodCashId, cashierUserId: till.cashier.userId, amountText: '46.00',
    });
    expect(paid.payment.orderId).toBe(orderId);
    expect(paid.remainingBalanceMinor).toBe(0n);
  }, 20_000);

  it('T2 deliberate lock-order inversion deadlocks (40P01) and maps to the retryable shape', async () => {
    const till = await setupTill();
    const orderA = (await newOrder(till.branchId, till.cashier.userId)).order.id;
    const orderB = (await newOrder(till.branchId, till.cashier.userId)).order.id;

    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const lockPairInOrder = (firstId: string, secondId: string) =>
      withApp(T, async (q) => {
        await q.query('SELECT id FROM orders WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [T, firstId]);
        // Hold the first lock until the rival certainly holds ITS first.
        await sleep(250);
        await q.query('SELECT id FROM orders WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [T, secondId]);
      });

    const [left, right] = await Promise.allSettled([
      lockPairInOrder(orderA, orderB),
      lockPairInOrder(orderB, orderA),
    ]);

    const fulfilled = [left, right].filter((result) => result.status === 'fulfilled');
      const rejected = [left, right].filter(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      );
      // Exactly one waiter survives: no silent double-commit, no double-abort.
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      const reason: unknown = rejected[0]?.reason;
    expect(isConcurrencyRetryableError(reason)).toBe(true);
    expect(reason).toMatchObject({ code: 'concurrency.retryable_conflict', pgCode: '40P01' });
  }, 20_000);

  it('T3 per-shift ceiling: twelve concurrent collectors on one shift converge with bounded retries', async () => {
    const till = await setupTill();
    const orderIds: string[] = [];
    for (let index = 0; index < 4; index++) {
      orderIds.push((await newOrder(till.branchId, till.cashier.userId)).order.id);
    }

    let retryCount = 0;
    const collectWithBoundedRetries = async (orderId: string, amountText: string): Promise<void> => {
      for (let attempt = 0; ; attempt++) {
        try {
          await payments.recordPayment(T, {
            orderId, paymentMethodId: methodCashId, cashierUserId: till.cashier.userId, amountText,
          });
          return;
        } catch (error) {
          // Budget: 25 attempts per collect. Anything beyond proves
          // livelock, not contention — and fails the test loudly.
          if (!isConcurrencyRetryableError(error) || attempt >= 25) throw error;
          retryCount++;
        }
      }
    };

    // Four orders × (20.00 + 20.00 + 6.00): every interleaving FITS the 46.00
    // total, so a retry NEVER masks a balance error — any non-retryable
    // throw fails the test.
    const jobs = orderIds.flatMap((orderId) =>
      ['20.00', '20.00', '6.00'].map((amountText) => collectWithBoundedRetries(orderId, amountText)),
    );
    await Promise.all(jobs);
    // Contention REALLY happened — a zero-retry pass would be vacuous.
    expect(retryCount).toBeGreaterThan(0);

    // Exact end state: 3 completed payments × 46.00 per order, every order paid.
    const totals = await owner.query<{ order_id: string; payment_count: string; paid_total: string }>(
      `SELECT p.order_id, COUNT(*)::text AS payment_count, SUM(p.amount_in_base_currency)::text AS paid_total
       FROM payments p
       WHERE p.tenant_id = $1 AND p.order_id = ANY($2) AND p.status = 'completed'
       GROUP BY p.order_id`,
      [T, orderIds],
    );
    expect(totals.rows).toHaveLength(4);
    for (const agg of totals.rows) {
      expect(agg.payment_count).toBe('3');
      expect(agg.paid_total).toBe('46.0000');
    }
    const statuses = await owner.query<{ id: string; payment_status: string }>(
      'SELECT id, payment_status FROM orders WHERE tenant_id = $1 AND id = ANY($2)',
      [T, orderIds],
    );
    expect(statuses.rows).toHaveLength(4);
    for (const order of statuses.rows) {
      expect(order.payment_status).toBe('paid');
    }
  }, 30_000);
});
