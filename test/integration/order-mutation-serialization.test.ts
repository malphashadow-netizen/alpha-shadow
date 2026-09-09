/**
 * B2 live acceptance — order/shift mutation serialization (migration 0045).
 *
 * Before the fix every order-mutating transaction ran at REPEATABLE READ with
 * no row locks. Same-row races (full collect × full collect, same-item
 * transitions, double void) already self-serialized through their UPDATEs —
 * the REAL holes were the pairs where NEITHER side updates a shared row:
 *
 *   * partial collect × partial collect (both INSERT-only): both snapshot
 *     the same balance and both commit — the till collects MORE than the
 *     order total;
 *   * close × collect: the Z-Report SUM commits without the concurrent
 *     payment (close and collect touch disjoint rows pre-fix).
 *
 * The fix is lock-first + conflict generation: SELECT … FOR UPDATE on the
 * orders row FIRST (the shift row second for close/collect, uniform order),
 * plus a revision bump that turns the loser into a clean 40001 serialization
 * failure under REPEATABLE READ (mapped to a retryable error by B3). These
 * tests prove exactly-once effects on a REAL PostgreSQL:
 *
 *   * partial double collect (Promise.allSettled): exactly one payment
 *     commits, the loser serialization-fails, the stored SUM equals the one
 *     payment — and retrying the loser for the REMAINDER converges (no
 *     over-collection in the end state). FAILS pre-fix (both commit).
 *   * concurrent same-order transitions: invariant characterization — every
 *     transition already updates the orders row through the
 *     apply_order_item_status → recompute_order_status trigger cascade, so
 *     same-order transitions self-serialized even pre-fix. The B2 order lock
 *     now guarantees this BY DESIGN at the engine level instead of as a
 *     trigger side-effect; the test pins exactly-one-winner + retry
 *     convergence for the uniform-lock audit.
 *   * concurrent transitions on DIFFERENT orders: both succeed — the locks
 *     serialize per order, never globally (a LOCK TABLE-style "fix" fails).
 *   * close-vs-collect: exactly one wins and EITHER outcome is consistent —
 *     a winning close excludes the payment (the retry then fails the shift
 *     gateway cleanly), a winning collect forces the close to retry WITH the
 *     payment in its SUM (variance still zero). FAILS pre-fix (both commit).
 *
 * Loser assertions pin the mapped mechanism: raw 40001/40P01/55P03 deaths
 * surface as ConcurrencyRetryableError ('concurrency.retryable_conflict',
 * HTTP 503) via the central mapPostgresError — the client retries.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CatalogEngine } from '../../src/application/engines/catalog/catalog-engine.ts';
import { OrderCreationEngine } from '../../src/application/engines/orders/order-creation-engine.ts';
import { WorkflowAdminEngine } from '../../src/application/engines/orders/workflow-admin-engine.ts';
import { WorkflowTransitionEngine } from '../../src/application/engines/orders/workflow-transition-engine.ts';
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
import { currencyCode, money } from '../../src/shared/money.ts';
import { testDatabaseUrl } from '../support/database.ts';
import { grantKeys } from '../support/grant-keys.ts';

const PLATFORM_ACTOR = '71000000-0000-4000-8000-000000000005';
let T: string; // dedicated B2 tenant (fresh per run)
const PIN_PEPPER = Buffer.from(randomBytes(48));

function row<R>(rows: readonly R[]): R {
  const first = rows[0];
  if (first === undefined) throw new Error('Expected database row');
  return first;
}

interface TillUser {
  readonly userId: string;
}

describe('B2 live acceptance (order/shift mutation serialization)', () => {
  let owner: pg.Pool;
  let app: pg.Pool;
  let platformPool: pg.Pool;
  let withApp: WithTenantContext;
  let catalog: CatalogEngine;
  let creation: OrderCreationEngine;
  let transitions: WorkflowTransitionEngine;
  let shifts: ShiftEngine;
  let payments: PaymentsEngine;
  let methods: PaymentMethodsEngine;
  let itemId: string; // 40.00 SAR; 15% VAT ⇒ total 46.00
  let methodCashId: string;
  let permWrite: PostgresPermissionWriteRepository;
  let opener: TillUser;
  let verifier: TillUser;
  let preparingId: string;
  let readyId: string;

  beforeAll(async () => {
    owner = new pg.Pool({ connectionString: testDatabaseUrl(), max: 5 });
    T = randomUUID();
    await owner.query('INSERT INTO tenants (id, name) VALUES ($1, $2)', [T, 'b2-serialization']);
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
    const workflowAdmin = new WorkflowAdminEngine({ store: ordersStore });
    shifts = new ShiftEngine({ store: new PostgresShiftsStore({ withTenantContext: withApp }), authorization });
    const authenticator = new PostgresManagerOverrideAuthenticator({ withTenantContext: withApp, pepper: PIN_PEPPER });
    payments = new PaymentsEngine({ store: new PostgresPaymentsStore({ withTenantContext: withApp }), authorization });
    creation = new OrderCreationEngine({ store: ordersStore, authorization, managerAuthenticator: authenticator });
    transitions = new WorkflowTransitionEngine({ store: ordersStore });
    methods = new PaymentMethodsEngine({ store: new PostgresPaymentsStore({ withTenantContext: withApp }), authorization });

    // Platform tax fixture: SA, per-line rounding, 15% exclusive VAT.
    const platform = new PlatformTaxAdminEngine(new PostgresPlatformTaxAdminRepository(createWithPlatformTaxContext(platformPool)));
    await platform.configureJurisdiction(PLATFORM_ACTOR, 'SA', 'per_line', true);
    const saCategory = await platform.createCategory(PLATFORM_ACTOR, {
      countryCode: 'SA', code: randomUUID(), kind: 'standard', taxFamily: 'vat', cascadePriority: 50,
      name: { en: 'B2 fixture VAT' }, isActive: true,
    });
    await platform.createTaxRate(PLATFORM_ACTOR, { taxCategoryId: saCategory.id, rateBps: 1500, isPriceInclusiveDefault: false, effectiveFrom: '2020-01-01', effectiveTo: null });
    await owner.query("UPDATE tenants SET vat_registration_status = 'registered', vat_registration_number = 'b2-vat' WHERE id = $1", [T]);

    await workflowAdmin.ensureWorkflow(T, [
      { kindCode: 'received', position: 10, label: { ar: 'مستلم' } },
      { kindCode: 'preparing', position: 20, label: { ar: 'قيد التحضير' } },
      { kindCode: 'ready', position: 30, label: { ar: 'جاهز' } },
      { kindCode: 'delivered', position: 40, label: { ar: 'تم التسليم' } },
    ]);
    const states = (await owner.query<{ id: string; kind_code: string }>(
      'SELECT id, kind_code FROM tenant_order_workflow_states WHERE tenant_id = $1', [T],
    )).rows;
    preparingId = states.find((s) => s.kind_code === 'preparing')?.id ?? '';
    readyId = states.find((s) => s.kind_code === 'ready')?.id ?? '';
    expect([preparingId, readyId].every((id) => id !== '')).toBe(true);

    opener = await createUser();
    verifier = await createUser();
    permWrite = new PostgresPermissionWriteRepository({ withTenantContext: withApp });
    await grantKeys(permWrite, T, opener.userId, ['shift:open', 'shift:close', 'catalog:write', 'payments:methods_admin']);

    const menuCategoryId = (await catalog.createCategory(T, opener.userId, { name: { ar: 'قائمة B2' } })).id;
    itemId = (await catalog.createItem(T, opener.userId, {
      categoryId: menuCategoryId, name: { ar: 'طبق B2' }, basePrice: money(4000n, currencyCode('SAR')), taxRuleId: saCategory.id,
    })).id;

    methodCashId = (await methods.create(T, opener.userId, { name: 'نقدي B2', type: 'cash', branchId: null, currencyCode: null, fixedExchangeRate: null, isActive: true })).id;
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
      await q.query('INSERT INTO branches (id, tenant_id, name, base_currency, timezone, country_code) VALUES ($1, $2, $3, $4, $5, $6)', [branchId, T, `B2 ${randomUUID()}`, 'SAR', 'Asia/Riyadh', 'SA']);
      await q.query('INSERT INTO stations (id, tenant_id, branch_id, name) VALUES ($1, $2, $3, $4)', [stationId, T, branchId, 'main']);
      await q.query('INSERT INTO station_routing_rules (id, tenant_id, branch_id, station_id, menu_item_id) VALUES ($1, $2, $3, $4, $5)', [randomUUID(), T, branchId, stationId, itemId]);
    });
    const shift = await shifts.openShift(T, {
      branchId, cashierUserId: cashier.userId, openedByUserId: opener.userId, openVerifiedByUserId: verifier.userId,
      openedAt: new Date(), openCounts: [{ denominationValue: '100.00', quantity: 2 }],
    });
    return { branchId, cashier, shiftId: shift.id };
  }

  async function newOrder(branchId: string, cashierId: string, lineCount = 1) {
    return creation.create(T, {
      branchId, cashierUserId: cashierId, orderType: 'dine_in', salesChannelCode: 'dine_in',
      deliveryPlatformId: null, tableId: null,
      items: Array.from({ length: lineCount }, () => ({ menuItemId: itemId, quantity: 1 })), occurredAt: new Date(),
    });
  }

  it('partial double collect: exactly one payment commits, the loser serialization-fails (40001), the retry converges', async () => {
    const till = await setupTill();
    const created = await newOrder(till.branchId, till.cashier.userId);
    const orderId = created.order.id;

    // Two PARTIAL collects (30.00 each on a 46.00 balance): pre-fix both are
    // INSERT-only, so both commit and the till over-collects 60.00.
    const collect = () => payments.recordPayment(T, {
      orderId, paymentMethodId: methodCashId, cashierUserId: till.cashier.userId, amountText: '30.00',
    });
    const [first, second] = await Promise.allSettled([collect(), collect()]);
    const fulfilled = [first, second].filter((r) => r.status === 'fulfilled');
    const rejected = [first, second].filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    // The loser dies on the order lock: the winner's revision bump makes the
    // waiter's FOR UPDATE raise 40001 under REPEATABLE READ (mapped to the
    // retryable ConcurrencyRetryableError → 503).
    expect(rejected[0]).toMatchObject({ status: 'rejected', reason: { code: 'concurrency.retryable_conflict' } });
    if (fulfilled[0]?.status !== 'fulfilled') throw new Error('Expected one fulfilled collect');
    expect(fulfilled[0].value.remainingBalanceMinor).toBe(1600n);

    // Exactly-once effects: one payment, one SUM, still open, one revision.
    const payAgg = row((await owner.query<{ n: string; total: string }>(
      `SELECT count(*)::text AS n, COALESCE(SUM(amount_in_base_currency), 0)::text AS total
       FROM payments WHERE tenant_id = $1 AND order_id = $2 AND status = 'completed'`, [T, orderId],
    )).rows);
    expect(payAgg.n).toBe('1');
    expect(payAgg.total).toBe('30.0000');
    const orderRow = row((await owner.query<{ payment_status: string; revision: string }>(
      'SELECT payment_status, revision::text AS revision FROM orders WHERE id = $1', [orderId],
    )).rows);
    expect(orderRow.payment_status).toBe('open');
    expect(orderRow.revision).toBe('1');

    // Retry-convergence: collecting the 16.00 remainder now succeeds and the
    // end state collects EXACTLY the total — never more.
    const retried = await payments.recordPayment(T, {
      orderId, paymentMethodId: methodCashId, cashierUserId: till.cashier.userId, amountText: '16.00',
    });
    expect(retried.remainingBalanceMinor).toBe(0n);
    const finalAgg = row((await owner.query<{ n: string; total: string; payment_status: string }>(
      `SELECT count(*)::text AS n, COALESCE(SUM(p.amount_in_base_currency), 0)::text AS total,
              (SELECT payment_status FROM orders WHERE id = $2) AS payment_status
       FROM payments p WHERE p.tenant_id = $1 AND p.order_id = $2 AND p.status = 'completed'`, [T, orderId],
    )).rows);
    expect(finalAgg.n).toBe('2');
    expect(finalAgg.total).toBe('46.0000');
    expect(finalAgg.payment_status).toBe('paid');
  });

  it('concurrent transitions on one order: exactly one wins immediately, the retry converges', async () => {
    const till = await setupTill();
    const created = await newOrder(till.branchId, till.cashier.userId, 2);
    const itemOne = created.items[0]?.item.id ?? '';
    const itemTwo = created.items[1]?.item.id ?? '';
    expect([itemOne, itemTwo].every((id) => id !== '')).toBe(true);

    // Invariant characterization (holds with AND without the B2 lock): every
    // transition already updates the orders row through the
    // apply_order_item_status → recompute_order_status trigger cascade, so
    // same-order transitions self-serialize at REPEATABLE READ. The B2 order
    // lock now guarantees this BY DESIGN at the engine level instead of as a
    // trigger side-effect; this test pins exactly-one-winner + retry
    // convergence for the uniform-lock audit.
    const moveOne = () => transitions.transitionItem(T, { orderItemId: itemOne, toWorkflowStateId: preparingId, actorUserId: till.cashier.userId });
    const moveTwo = () => transitions.transitionItem(T, { orderItemId: itemTwo, toWorkflowStateId: readyId, actorUserId: till.cashier.userId });
    const [rOne, rTwo] = await Promise.allSettled([moveOne(), moveTwo()]);
    const fulfilled = [rOne, rTwo].filter((r) => r.status === 'fulfilled');
    const rejected = [rOne, rTwo].filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ status: 'rejected', reason: { code: 'concurrency.retryable_conflict' } });

    // Retry-convergence: the loser retries cleanly and both items land.
    if (rOne.status === 'rejected') await moveOne();
    else await moveTwo();
    const itemRows = (await owner.query<{ id: string; current_status_kind_id: string }>(
      'SELECT id, current_status_kind_id FROM order_items WHERE id = ANY($1::uuid[])', [[itemOne, itemTwo]],
    )).rows;
    expect(itemRows.find((r) => r.id === itemOne)?.current_status_kind_id).toBe(preparingId);
    expect(itemRows.find((r) => r.id === itemTwo)?.current_status_kind_id).toBe(readyId);
    const eventCount = row((await owner.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM order_item_status_events WHERE tenant_id = $1 AND order_item_id = ANY($2::uuid[])', [T, [itemOne, itemTwo]],
    )).rows);
    expect(eventCount.n).toBe('4'); // 2 initial + 2 transitions, no duplicates
  });

  it('concurrent transitions on DIFFERENT orders: both succeed (locks are per-order, never global)', async () => {
    const tillA = await setupTill();
    const tillB = await setupTill();
    const orderA = await newOrder(tillA.branchId, tillA.cashier.userId);
    const orderB = await newOrder(tillB.branchId, tillB.cashier.userId);
    const itemA = orderA.items[0]?.item.id ?? '';
    const itemB = orderB.items[0]?.item.id ?? '';
    expect([itemA, itemB].every((id) => id !== '')).toBe(true);

    // Independence: disjoint orders never share a locked row, so both
    // transitions commit — the B2 locks serialize per order, never globally
    // (a LOCK TABLE-style "fix" would fail here).
    const [rA, rB] = await Promise.allSettled([
      transitions.transitionItem(T, { orderItemId: itemA, toWorkflowStateId: preparingId, actorUserId: tillA.cashier.userId }),
      transitions.transitionItem(T, { orderItemId: itemB, toWorkflowStateId: readyId, actorUserId: tillB.cashier.userId }),
    ]);
    expect(rA.status).toBe('fulfilled');
    expect(rB.status).toBe('fulfilled');
    const itemRows = (await owner.query<{ id: string; current_status_kind_id: string }>(
      'SELECT id, current_status_kind_id FROM order_items WHERE id = ANY($1::uuid[])', [[itemA, itemB]],
    )).rows;
    expect(itemRows.find((r) => r.id === itemA)?.current_status_kind_id).toBe(preparingId);
    expect(itemRows.find((r) => r.id === itemB)?.current_status_kind_id).toBe(readyId);
  });

  it('close-vs-collect: exactly one wins and either outcome is consistent', async () => {
    const till = await setupTill();
    const created = await newOrder(till.branchId, till.cashier.userId);
    const orderId = created.order.id;
    // Counted 246.00 = float 200.00 + 46.00 sales.
    const closeCounts = [
      { denominationValue: '100.00', quantity: 2 },
      { denominationValue: '20.00', quantity: 2 },
      { denominationValue: '5.00', quantity: 1 },
      { denominationValue: '1.00', quantity: 1 },
    ];
    const close = () => shifts.closeShift(T, {
      shiftId: till.shiftId, closedByUserId: opener.userId, closeVerifiedByUserId: verifier.userId,
      closedAt: new Date(), closeCounts, notes: null,
    });
    const collect = () => payments.recordPayment(T, {
      orderId, paymentMethodId: methodCashId, cashierUserId: till.cashier.userId, amountText: '46.00',
    });

    const [closeResult, collectResult] = await Promise.allSettled([close(), collect()]);
    expect([closeResult.status, collectResult.status].filter((s) => s === 'fulfilled')).toHaveLength(1);

    if (collectResult.status === 'fulfilled') {
      // Collect won: the close serialization-failed on the touched shift row;
      // retrying the close MUST see the payment in its SUM (variance zero).
      expect(closeResult).toMatchObject({ status: 'rejected', reason: { code: 'concurrency.retryable_conflict' } });
      const retried = await close();
      expect(retried.status).toBe('closed');
      expect(retried.varianceType).toBe('exact');
      const shiftRow = row((await owner.query<{ recorded: string; variance: string }>(
        'SELECT recorded_cash_sales::text AS recorded, variance::text AS variance FROM shift_reconciliations WHERE id = $1', [till.shiftId],
      )).rows);
      expect(shiftRow.recorded).toBe('46.0000');
      expect(shiftRow.variance).toBe('0.0000');
    } else {
      // Close won: no payment was recorded; re-collecting fails the shift
      // gateway cleanly (no open shift anymore), never a 40001 retry loop.
      expect(collectResult).toMatchObject({ status: 'rejected', reason: { code: 'concurrency.retryable_conflict' } });
      expect(closeResult.status).toBe('fulfilled');
      const payCount = row((await owner.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM payments WHERE tenant_id = $1 AND order_id = $2', [T, orderId],
      )).rows);
      expect(payCount.n).toBe('0');
      await expect(collect()).rejects.toMatchObject({ code: 'payments.shift_required' });
    }
  });
});
