/**
 * Phase 9 live acceptance — inventory-backed selling (stock gate, manager
 * override, void/refund stock side-effects, receiving with unit conversion,
 * manual adjustments).
 *
 * Everything below runs against a REAL PostgreSQL (RLS, triggers, grants,
 * REPEATABLE READ order transactions). Every locked edge is asserted on
 * REAL state — ledger rows, balances, claims, order/outbox counts — never on
 * a function merely returning.
 *
 * Case map (the 7 locked cases + the hardening extras):
 *   1. Whole-order fail-closed refusal on ANY shortage (+ nothing written).
 *   2. Manager override approves a negative balance (claim + attempt rows).
 *   3. Trigger-level rejection of a forged `sale_deduction` (shortage,
 *      fabricated override, sign/link/scope, branch, permission, immutability).
 *   4. Two concurrent orders against one unit of stock (exactly one wins).
 *   5. Void before the kitchen ticket restores; after the ticket wastes
 *      (per-line branching on an order-level void).
 *   6. Post-payment refund writes zero-delta `waste_refund` (dedup across
 *      two legs; voided lines excluded); `voidPayment` stays stock-free.
 *   7. Receiving converts purchase → base units (rounding, same-unit,
 *      missing conversion, strict scales); the sale path NEVER converts.
 *   8. `stock_override_claims` single-use (reuse rejected; concurrent double
 *      claim → exactly one wins; foreign-context attempts never authorize;
 *      stale attempts never authorize even WITH a claim row).
 *   9. No stock oracle: a shiftless / non-member / wrong-branch cashier gets
 *      the gateway error with zero stock information in the message.
 *  10. `recipe_ingredients` tenant isolation (cross-tenant invisibility).
 *  11. Permissions: receive/adjust keys enforced at engine AND trigger level;
 *      adjust validation (strict scales, branch, unknown item).
 *  12. Modifier recipes scale per unit; recipe-less lines pass through with
 *      zero movements; restoration mirrors RECORDED rows, not the live recipe.
 *  13. Central reporting aggregates per-branch quantities (read-only).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CatalogEngine } from '../../src/application/engines/catalog/catalog-engine.ts';
import { InventoryEngine } from '../../src/application/engines/inventory/inventory-engine.ts';
import { OrderCreationEngine } from '../../src/application/engines/orders/order-creation-engine.ts';
import { VoidModificationEngine } from '../../src/application/engines/orders/void-modification-engine.ts';
import { WorkflowAdminEngine } from '../../src/application/engines/orders/workflow-admin-engine.ts';
import { WorkflowTransitionEngine } from '../../src/application/engines/orders/workflow-transition-engine.ts';
import { PaymentMethodsEngine } from '../../src/application/engines/payments/payment-methods-engine.ts';
import { PaymentsEngine } from '../../src/application/engines/payments/payments-engine.ts';
import { AuthorizationEngine } from '../../src/application/engines/rbac/authorization-engine.ts';
import { ShiftEngine } from '../../src/application/engines/shifts/shift-engine.ts';
import { PlatformTaxAdminEngine } from '../../src/application/engines/tax/platform-tax-admin-engine.ts';
import type {
  CreatedOrder,
  ManagerOverrideChallenge,
  NewOrderItemLine,
} from '../../src/domain/contracts/orders.ts';
import { deriveSecV } from '../../src/domain/contracts/sec-v.ts';
import type { TaxCategory } from '../../src/domain/contracts/tax.ts';
import { createWithPlatformTaxContext } from '../../src/infrastructure/db/platform-tax-context.ts';
import { createWithTenantContext, type WithTenantContext } from '../../src/infrastructure/db/tenant-context.ts';
import { PostgresCatalogRepository } from '../../src/infrastructure/db/repositories/postgres-catalog-repository.ts';
import { PostgresInventoryStore } from '../../src/infrastructure/db/repositories/postgres-inventory-store.ts';
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
  AdjustmentReasonUnavailableError,
  CashierShiftRequiredError,
  ConcurrencyRetryableError,
  ForbiddenError,
  InsufficientStockError,
  ManagerOverrideAuthenticationError,
  NotFoundError,
  ValidationError,
  isConcurrencyRetryableError,
  toErrorResponse,
} from '../../src/shared/errors.ts';
import { currencyCode, money } from '../../src/shared/money.ts';
import { testDatabaseUrl } from '../support/database.ts';

const T = '9b999999-9999-4999-8999-999999999999'; // phase 9 stock tenant
const T2 = '9c999999-9999-4999-8999-999999999999'; // cross-tenant isolation probe
const PLATFORM_ACTOR = '71000000-0000-4000-8000-000000000005';

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
  readonly cashier: TieredUser;
  readonly shiftId: string;
}

describe('Phase 9 inventory-backed selling (live)', () => {
  let owner: pg.Pool;
  let app: pg.Pool;
  let platformPool: pg.Pool;
  let withApp: WithTenantContext;
  let platform: PlatformTaxAdminEngine;
  let catalog: CatalogEngine;
  let permissionRead: PostgresPermissionReadRepository;
  let authorization: AuthorizationEngine;
  let ordersStore: PostgresOrdersStore;
  let authenticator: PostgresManagerOverrideAuthenticator;
  let creation: OrderCreationEngine;
  let transitions: WorkflowTransitionEngine;
  let workflowAdmin: WorkflowAdminEngine;
  let voids: VoidModificationEngine;
  let shifts: ShiftEngine;
  let payments: PaymentsEngine;
  let methods: PaymentMethodsEngine;
  let inventory: InventoryEngine;
  let saCategory: TaxCategory;
  let menuCategoryId: string;
  let itemMeal: string; // 20.00 SAR, has menu-item + modifier recipes
  let itemDrink: string; // 10.00 SAR, deliberately recipe-less
  let modifierCheese: string; // +2.00 SAR, has a modifier recipe
  let opener: TieredUser;
  let verifier: TieredUser;
  let stockManager: TieredUser; // holds inventory:adjust (override approver)
  let receiverUser: TieredUser; // holds inventory:receive only
  let adjustUser: TieredUser; // holds inventory:adjust only
  let voidServerUser: TieredUser; // holds order:void
  let reasonServer: string;
  let methodCashId: string;
  let preparingStateId: string;
  let tillCounter = 0;

  beforeAll(async () => {
    owner = new pg.Pool({ connectionString: testDatabaseUrl(), max: 5 });
    for (const file of ['001_app_login.sql', '002_app_login_rbac.sql', '004_app_login_phase4.sql', '005_app_login_catalog.sql', '006_phase6_tax.sql', '007_phase7_orders.sql', '008_phase7_manager_override_rate_limiting.sql',
      '009_phase8_payments.sql', '010_phase9_inventory.sql', '011_backlog_i1_adjustment_reasons.sql', '012_backlog_i3_low_stock.sql', '013_backlog_i4_unit_registry.sql']) {
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
    await owner.query('INSERT INTO tenants (id, name) VALUES ($1, $2), ($3, $4)', [T, 'phase9-inventory', T2, 'phase9-isolation-probe']);
    withApp = createWithTenantContext(app, { verifyTenantExists: true });
    platform = new PlatformTaxAdminEngine(new PostgresPlatformTaxAdminRepository(createWithPlatformTaxContext(platformPool)));
    permissionRead = new PostgresPermissionReadRepository({ withTenantContext: withApp });
    authorization = new AuthorizationEngine({ read: permissionRead, hash: sha256Hex });
    catalog = new CatalogEngine({ catalog: new PostgresCatalogRepository({ withTenantContext: withApp }), taxAssignments: new PostgresTenantTaxAdminRepository(withApp), authorization });
    ordersStore = new PostgresOrdersStore({ withTenantContext: withApp });
    authenticator = new PostgresManagerOverrideAuthenticator({ withTenantContext: withApp, pepper: PIN_PEPPER });
    creation = new OrderCreationEngine({ store: ordersStore, authorization, permissionRead, managerAuthenticator: authenticator });
    workflowAdmin = new WorkflowAdminEngine({ store: ordersStore, authorization });
    transitions = new WorkflowTransitionEngine({ store: ordersStore, authorization });
    voids = new VoidModificationEngine({ store: ordersStore, authorization, managerAuthenticator: authenticator });
    shifts = new ShiftEngine({ store: new PostgresShiftsStore({ withTenantContext: withApp }), authorization });
    payments = new PaymentsEngine({ store: new PostgresPaymentsStore({ withTenantContext: withApp }), authorization });
    methods = new PaymentMethodsEngine({ store: new PostgresPaymentsStore({ withTenantContext: withApp }), authorization });
    inventory = new InventoryEngine({ store: new PostgresInventoryStore({ withTenantContext: withApp }), authorization });

    // Platform tax fixture: SA, per-line rounding, 15% exclusive VAT.
    await platform.configureJurisdiction(PLATFORM_ACTOR, 'SA', 'per_line', true);
    saCategory = await platform.createCategory(PLATFORM_ACTOR, {
      countryCode: 'SA', code: randomUUID(), kind: 'standard', taxFamily: 'vat', cascadePriority: 50,
      name: { en: 'Phase 9 fixture VAT' }, isActive: true,
    });
    await platform.createTaxRate(PLATFORM_ACTOR, { taxCategoryId: saCategory.id, rateBps: 1500, isPriceInclusiveDefault: false, effectiveFrom: '2020-01-01', effectiveTo: null });
    await owner.query("UPDATE tenants SET vat_registration_status = 'registered', vat_registration_number = 'phase9-vat' WHERE id = $1", [T]);

    await workflowAdmin.ensureWorkflow(T, [
      { kindCode: 'received', position: 10, label: { ar: 'مستلم' } },
      { kindCode: 'preparing', position: 20, label: { ar: 'قيد التحضير' } },
      { kindCode: 'ready', position: 30, label: { ar: 'جاهز' } },
      { kindCode: 'delivered', position: 40, label: { ar: 'تم التسليم' } },
    ]);
    const states = await ordersStore.run(T, (scope) => scope.loadWorkflowStates(T, true));
    const preparing = states.find((s) => s.kindCode === 'preparing' && s.parentKindCode === null);
    if (preparing === undefined) throw new Error('preparing state missing');
    preparingStateId = preparing.id;
    // Sanity-pin the premise of the void tests below: preparing fires the ticket.
    const kinds = row((await owner.query<{ fires: boolean }>("SELECT (behavior_flags->>'fires_kitchen_ticket')::boolean AS fires FROM order_status_kinds WHERE code = 'preparing'")).rows);
    expect(kinds.fires).toBe(true);

    // People: plain shift identities + tiered permission holders. (B7: the
    // opener carries the shift/catalog/methods keys; the till cashier carries
    // payments:collect.)
    opener = await createTieredUser(['shift:open', 'catalog:write', 'payments:methods_admin'], '1111');
    verifier = await createPlainUser('2222');
    stockManager = await createTieredUser(['inventory:adjust'], '5555');
    receiverUser = await createTieredUser(['inventory:receive'], '6666');
    adjustUser = await createTieredUser(['inventory:adjust'], '7777');
    voidServerUser = await createTieredUser(['order:void'], '9999');

    menuCategoryId = (await catalog.createCategory(T, opener.userId, { name: { ar: 'قائمة المخزون' } })).id;
    itemMeal = (await catalog.createItem(T, opener.userId, {
      categoryId: menuCategoryId, name: { ar: 'وجبة' }, basePrice: money(2000n, currencyCode('SAR')), taxRuleId: saCategory.id,
    })).id;
    itemDrink = (await catalog.createItem(T, opener.userId, {
      categoryId: menuCategoryId, name: { ar: 'مشروب' }, basePrice: money(1000n, currencyCode('SAR')), taxRuleId: saCategory.id,
    })).id;
    const extrasGroupId = (await catalog.createModifierGroup(T, opener.userId, {
      name: { ar: 'إضافات' }, selectionType: 'multiple', minSelections: 0, maxSelections: null, isRequired: false,
    })).id;
    modifierCheese = (await catalog.createModifier(T, opener.userId, {
      modifierGroupId: extrasGroupId, name: { ar: 'جبن' }, priceDeltaAmountMinor: 200n,
    })).id;
    await catalog.attachModifierGroupToItem(T, opener.userId, itemMeal, extrasGroupId, 0);
    reasonServer = randomUUID();
    await withApp(T, (q) => q.query(
      'INSERT INTO tenant_void_reasons (id, tenant_id, void_reason_kind_code, label, required_permission_tier) VALUES ($1, $2, $3, $4, $5)',
      [reasonServer, T, 'customer_request', `سبب فحص ${reasonServer}`, 'server'],
    ));

    methodCashId = (await methods.create(T, opener.userId, { name: 'نقدي', type: 'cash', branchId: null, currencyCode: null, fixedExchangeRate: null, isActive: true })).id;
  });

  afterAll(async () => {
    await app?.end();
    await platformPool?.end();
    await owner?.end();
  });

  beforeEach(() => {
    tillCounter += 1;
  });

  // Recipe rows are tenant-level per menu item / modifier while components are
  // branch-level per test-till: without cleanup, rows from earlier tests would
  // accumulate on the shared catalog items as phantom requirements. Movements,
  // components and conversions are branch/order-scoped and need no cleanup.
  afterEach(async () => {
    await owner.query('DELETE FROM menu_item_recipes WHERE tenant_id = $1', [T]);
    await owner.query('DELETE FROM modifier_recipes WHERE tenant_id = $1', [T]);
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

  async function createTieredUser(keys: readonly string[], pin: string): Promise<TieredUser> {
    const user = await createPlainUser(pin);
    const roleId = randomUUID();
    await withApp(T, async (q) => {
      await q.query('INSERT INTO roles (id, tenant_id, name) VALUES ($1, $2, $3)', [roleId, T, `phase9-${roleId}`]);
      for (const key of keys) {
        await q.query('INSERT INTO role_permissions (tenant_id, role_id, permission_key) VALUES ($1, $2, $3)', [T, roleId, key]);
      }
      await q.query("INSERT INTO user_roles (tenant_id, user_id, role_id, scope_type, scope_id) VALUES ($1, $2, $3, 'tenant', NULL)", [T, user.userId, roleId]);
    });
    const tokenSecV = deriveSecV(await permissionRead.listActiveUserRoles(T, user.userId), await permissionRead.getSecurityVersion(T, user.userId), sha256Hex);
    return { userId: user.userId, tokenSecV, pin };
  }

  async function createBranchTieredUser(keys: readonly string[], pin: string, branchId: string): Promise<TieredUser> {
    const user = await createPlainUser(pin);
    const roleId = randomUUID();
    await withApp(T, async (q) => {
      await q.query('INSERT INTO roles (id, tenant_id, name) VALUES ($1, $2, $3)', [roleId, T, `phase9-branch-${roleId}`]);
      for (const key of keys) {
        await q.query('INSERT INTO role_permissions (tenant_id, role_id, permission_key) VALUES ($1, $2, $3)', [T, roleId, key]);
      }
      await q.query("INSERT INTO user_roles (tenant_id, user_id, role_id, scope_type, scope_id) VALUES ($1, $2, $3, 'branch', $4)", [T, user.userId, roleId, branchId]);
    });
    const tokenSecV = deriveSecV(await permissionRead.listActiveUserRoles(T, user.userId), await permissionRead.getSecurityVersion(T, user.userId), sha256Hex);
    return { userId: user.userId, tokenSecV, pin };
  }

  /** One till = one fresh branch + station + routing + shift cashier (fresh branch per test keeps stock ledgers independent). */
  async function setupTill(): Promise<Till> {
    const branchId = randomUUID();
    const stationId = randomUUID();
    const cashier = await createTieredUser(['payments:refund', 'payments:void', 'payments:collect', 'order:item:transition'], '3333');
    await withApp(T, async (q) => {
      await q.query("INSERT INTO branches (id, tenant_id, name, base_currency, timezone, country_code) VALUES ($1, $2, $3, 'SAR', 'Asia/Riyadh', 'SA')", [branchId, T, `فرع فحص ${tillCounter}`]);
      await q.query('INSERT INTO stations (id, tenant_id, branch_id, name) VALUES ($1, $2, $3, $4)', [stationId, T, branchId, 'main']);
      await q.query('INSERT INTO station_routing_rules (id, tenant_id, branch_id, station_id, menu_item_id) VALUES ($1, $2, $3, $4, $5), ($6, $2, $3, $4, $7)', [
        randomUUID(), T, branchId, stationId, itemMeal, randomUUID(), itemDrink,
      ]);
    });
    const shift = await shifts.openShift(T, {
      branchId, cashierUserId: cashier.userId, openedByUserId: opener.userId, openVerifiedByUserId: verifier.userId,
      openedAt: new Date(), openCounts: [],
    });
    return { branchId, cashier, shiftId: shift.id };
  }

  /** Dine-in order placement with the stock-relevant knobs exposed. */
  async function placeOrder(
    cashierUserId: string,
    till: Till,
    items: readonly NewOrderItemLine[],
    opts: { readonly managerOverride?: ManagerOverrideChallenge; readonly occurredAt?: Date } = {},
  ): Promise<CreatedOrder> {
    return creation.create(T, {
      branchId: till.branchId, cashierUserId, orderType: 'dine_in', salesChannelCode: 'dine_in',
      items, occurredAt: opts.occurredAt ?? new Date(),
      ...(opts.managerOverride === undefined ? {} : { managerOverride: opts.managerOverride }),
    });
  }

  /**
   * Stock-component fixture via direct SQL (admin CRUD for catalog-side
   * inventory items is out of Phase 9 scope; the app role holds INSERT on
   * these tables, so this also exercises the 010 grants).
   */
  async function createComponent(branchId: string, nameAr: string, nameEn: string, baseUnit: string, quantityText: string): Promise<string> {
    const id = randomUUID();
    await withApp(T, (q) => q.query(
      'INSERT INTO inventory_items (id, tenant_id, branch_id, name, base_unit, current_quantity, is_active) VALUES ($1, $2, $3, $4::jsonb, $5, $6, true)',
      [id, T, branchId, JSON.stringify({ ar: nameAr, en: nameEn }), baseUnit, quantityText],
    ));
    return id;
  }

  /** I1: a tenant coded adjustment reason (void-reason mirror fixture). */
  async function createAdjustmentReason(opts: { kindCode?: string; label?: string; isEnabled?: boolean; tenantId?: string } = {}): Promise<string> {
    const id = randomUUID();
    const tenant = opts.tenantId ?? T;
    await withApp(tenant, (q) => q.query(
      'INSERT INTO tenant_adjustment_reasons (id, tenant_id, adjustment_reason_kind_code, label, is_enabled) VALUES ($1, $2, $3, $4, $5)',
      [id, tenant, opts.kindCode ?? 'damage', opts.label ?? `سبب ${id.slice(0, 8)}`, opts.isEnabled ?? true],
    ));
    return id;
  }

  /** I3: set a component's low-stock threshold (config write — the guard only blocks quantities). */
  async function setThreshold(inventoryItemId: string, thresholdText: string): Promise<void> {
    await withApp(T, (q) => q.query(
      'UPDATE inventory_items SET low_stock_threshold = $1 WHERE tenant_id = $2 AND id = $3',
      [thresholdText, T, inventoryItemId],
    ));
  }

  async function removeMenuRecipe(menuItemId: string, inventoryItemId: string): Promise<void> {
    await owner.query('DELETE FROM menu_item_recipes WHERE tenant_id = $1 AND menu_item_id = $2 AND inventory_item_id = $3', [T, menuItemId, inventoryItemId]);
  }

  async function addMenuRecipe(menuItemId: string, inventoryItemId: string, quantityText: string): Promise<void> {
    await withApp(T, (q) => q.query(
      'INSERT INTO menu_item_recipes (tenant_id, menu_item_id, inventory_item_id, quantity_required) VALUES ($1, $2, $3, $4)',
      [T, menuItemId, inventoryItemId, quantityText],
    ));
  }

  async function addModifierRecipe(modifierId: string, inventoryItemId: string, quantityText: string): Promise<void> {
    await withApp(T, (q) => q.query(
      'INSERT INTO modifier_recipes (tenant_id, modifier_id, inventory_item_id, quantity_required) VALUES ($1, $2, $3, $4)',
      [T, modifierId, inventoryItemId, quantityText],
    ));
  }

  async function addConversion(inventoryItemId: string, fromUnit: string, toUnit: string, factorText: string): Promise<void> {
    await withApp(T, (q) => q.query(
      'INSERT INTO unit_conversions (tenant_id, inventory_item_id, from_unit, to_unit, conversion_factor) VALUES ($1, $2, $3, $4, $5)',
      [T, inventoryItemId, fromUnit, toUnit, factorText],
    ));
  }

  async function stockOf(inventoryItemId: string): Promise<string> {
    return row((await owner.query<{ current_quantity: string }>('SELECT current_quantity::text AS current_quantity FROM inventory_items WHERE id = $1', [inventoryItemId])).rows).current_quantity;
  }

  interface MovementRow {
    readonly movement_type: string;
    readonly inventory_item_id: string;
    readonly order_id: string | null;
    readonly order_item_id: string | null;
    readonly quantity_delta: string;
    readonly actor_user_id: string;
    readonly manager_override_id: string | null;
    readonly occurred_at: Date;
  }

  async function movementsFor(orderId: string): Promise<readonly MovementRow[]> {
    const result = await owner.query<MovementRow>(
      `SELECT movement_type, inventory_item_id, order_id, order_item_id, quantity_delta::text AS quantity_delta,
              actor_user_id, manager_override_id, occurred_at
         FROM stock_movements WHERE tenant_id = $1 AND order_id = $2 ORDER BY created_at, id`,
      [T, orderId],
    );
    return result.rows;
  }

  async function countWhere(table: string, where: string, params: readonly unknown[]): Promise<number> {
    return row((await owner.query<{ c: number }>(`SELECT count(*)::int AS c FROM ${table} WHERE ${where}`, [...params])).rows).c;
  }

  function minorToText(minor: bigint): string {
    const sign = minor < 0n ? '-' : '';
    const absolute = minor < 0n ? -minor : minor;
    return `${sign}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
  }

  // ── Case 1: whole-order fail-closed refusal ──────────────────────────────

  it('1/ rejects a multi-line order when ANY line is short, writing nothing (no order, no movements, no outbox)', async () => {
    const till = await setupTill();
    const flour = await createComponent(till.branchId, 'دقيق', 'Flour', 'kg', '1.0000');
    await addMenuRecipe(itemMeal, flour, '0.5000');

    // Line 1 fits (0.5000 ≤ 1.0000) but line 2 pushes the order total to 1.5000 > 1.0000.
    const ordersBefore = await countWhere('orders', 'tenant_id = $1', [T]);
    const movementsBefore = await countWhere('stock_movements', 'tenant_id = $1', [T]);
    const outboxBefore = await countWhere('order_events_outbox', 'tenant_id = $1', [T]);

    const failure = await placeOrder(till.cashier.userId, till, [
      { menuItemId: itemMeal, quantity: 1 },
      { menuItemId: itemMeal, quantity: 2 },
    ]).then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(InsufficientStockError);
    const shortage = failure as InsufficientStockError;
    expect(shortage.code).toBe('inventory.insufficient_stock');
    // The cashier-readable message names the component (Arabic display name) + branch and asks for an override.
    expect(shortage.message).toContain('دقيق');
    expect(shortage.message).toContain(till.branchId);
    expect(shortage.message).toMatch(/manager override/i);
    expect(shortage.inventoryItemId).toBe(flour);
    expect(shortage.branchId).toBe(till.branchId);

    // Fail-closed: the refusal wrote NOTHING, and the untouched balance still stands.
    expect(await countWhere('orders', 'tenant_id = $1', [T])).toBe(ordersBefore);
    expect(await countWhere('stock_movements', 'tenant_id = $1', [T])).toBe(movementsBefore);
    expect(await countWhere('order_events_outbox', 'tenant_id = $1', [T])).toBe(outboxBefore);
    expect(await stockOf(flour)).toBe('1.0000');
  });

  // ── Happy path: exact deductions ─────────────────────────────────────────

  it('deducts exact base-unit amounts on success and stamps movements with order, item and actor', async () => {
    const till = await setupTill();
    const flour = await createComponent(till.branchId, 'دقيق', 'Flour', 'kg', '5.0000');
    await addMenuRecipe(itemMeal, flour, '0.5000');
    const occurredAt = new Date();

    const created = await placeOrder(till.cashier.userId, till, [
      { menuItemId: itemMeal, quantity: 3 },
    ], { occurredAt });

    expect(await stockOf(flour)).toBe('3.5000');
    const movements = await movementsFor(created.order.id);
    expect(movements).toHaveLength(1);
    const movement = row([...movements]);
    expect(movement.movement_type).toBe('sale_deduction');
    expect(movement.inventory_item_id).toBe(flour);
    expect(movement.quantity_delta).toBe('-1.5000');
    expect(movement.order_item_id).toBe(created.items[0]?.item.id);
    expect(movement.actor_user_id).toBe(till.cashier.userId);
    expect(movement.manager_override_id).toBeNull();
    expect(movement.occurred_at.getTime()).toBe(occurredAt.getTime());
  });

  // ── Case 2: manager override → negative ──────────────────────────────────

  it('2/ a live manager override approves the sale into a negative balance and binds attempt → claim → order', async () => {
    const till = await setupTill();
    const flour = await createComponent(till.branchId, 'دقيق', 'Flour', 'kg', '1.0000');
    await addMenuRecipe(itemMeal, flour, '0.5000');

    const created = await placeOrder(till.cashier.userId, till, [
      { menuItemId: itemMeal, quantity: 5 }, // needs 2.5000 of 1.0000
    ], { managerOverride: { managerUserId: stockManager.userId, managerOverridePin: stockManager.pin } });

    // Negative balance is the APPROVED outcome, not a bug.
    expect(await stockOf(flour)).toBe('-1.5000');
    const movements = await movementsFor(created.order.id);
    expect(movements).toHaveLength(1);
    const movement = row([...movements]);
    expect(movement.quantity_delta).toBe('-2.5000');
    expect(movement.manager_override_id).not.toBeNull();

    // Attempt ledger: succeeded, stock context, bound to the initiating cashier, order NULL.
    const attempt = row((await owner.query<{
      outcome: string; context_type: string; initiating_actor_user_id: string; order_id: string | null; target_manager_user_id: string;
    }>('SELECT outcome, context_type, initiating_actor_user_id, order_id, target_manager_user_id FROM manager_override_attempts WHERE id = $1', [movement.manager_override_id])).rows);
    expect(attempt).toMatchObject({ outcome: 'succeeded', context_type: 'stock_override', initiating_actor_user_id: till.cashier.userId, order_id: null, target_manager_user_id: stockManager.userId });

    // The claim binds this exact attempt to this exact order (single-use; see case 8).
    const claims = await owner.query('SELECT manager_override_id, order_id FROM stock_override_claims WHERE tenant_id = $1 AND order_id = $2', [T, created.order.id]);
    expect(claims.rows).toHaveLength(1);
    expect(claims.rows[0]).toMatchObject({ manager_override_id: movement.manager_override_id, order_id: created.order.id });
  });

  it('2b/ a wrong manager PIN rejects the override attempt and writes nothing', async () => {
    const till = await setupTill();
    const flour = await createComponent(till.branchId, 'دقيق', 'Flour', 'kg', '1.0000');
    await addMenuRecipe(itemMeal, flour, '0.5000');
    const ordersBefore = await countWhere('orders', 'tenant_id = $1', [T]);
    const movementsBefore = await countWhere('stock_movements', 'tenant_id = $1', [T]);

    const failure = await placeOrder(till.cashier.userId, till, [
      { menuItemId: itemMeal, quantity: 5 },
    ], { managerOverride: { managerUserId: stockManager.userId, managerOverridePin: '0000' } }).then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(ManagerOverrideAuthenticationError);

    expect(await countWhere('orders', 'tenant_id = $1', [T])).toBe(ordersBefore);
    expect(await countWhere('stock_movements', 'tenant_id = $1', [T])).toBe(movementsBefore);
    expect(await stockOf(flour)).toBe('1.0000');
  });

  it('2c/ a manager WITHOUT the inventory:adjust key cannot approve a stock override', async () => {
    const till = await setupTill();
    const flour = await createComponent(till.branchId, 'دقيق', 'Flour', 'kg', '1.0000');
    await addMenuRecipe(itemMeal, flour, '0.5000');

    // receiverUser holds inventory:receive ONLY — the stock gate demands inventory:adjust.
    const failure = await placeOrder(till.cashier.userId, till, [
      { menuItemId: itemMeal, quantity: 5 },
    ], { managerOverride: { managerUserId: receiverUser.userId, managerOverridePin: receiverUser.pin } }).then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(ManagerOverrideAuthenticationError);
    expect(await stockOf(flour)).toBe('1.0000');
  });

  it('2d/ a manager holding inventory:adjust only on a DIFFERENT branch cannot approve a stock override', async () => {
    const tillA = await setupTill();
    const tillB = await setupTill();
    const branchBManager = await createBranchTieredUser(['inventory:adjust'], '8888', tillB.branchId);
    const flour = await createComponent(tillA.branchId, 'دقيق', 'Flour', 'kg', '1.0000');
    await addMenuRecipe(itemMeal, flour, '0.5000');

    const failure = await placeOrder(tillA.cashier.userId, tillA, [
      { menuItemId: itemMeal, quantity: 5 },
    ], { managerOverride: { managerUserId: branchBManager.userId, managerOverridePin: branchBManager.pin } }).then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(ManagerOverrideAuthenticationError);
    expect(await stockOf(flour)).toBe('1.0000');
  });

  it('2e/ a manager holding inventory:adjust on the SAME branch can approve a stock override', async () => {
    const tillA = await setupTill();
    const branchManager = await createBranchTieredUser(['inventory:adjust'], '8989', tillA.branchId);
    const flour = await createComponent(tillA.branchId, 'دقيق', 'Flour', 'kg', '1.0000');
    await addMenuRecipe(itemMeal, flour, '0.5000');

    const created = await placeOrder(tillA.cashier.userId, tillA, [
      { menuItemId: itemMeal, quantity: 5 },
    ], { managerOverride: { managerUserId: branchManager.userId, managerOverridePin: branchManager.pin } });
    expect(await stockOf(flour)).toBe('-1.5000');
    expect(row(await movementsFor(created.order.id)).manager_override_id).not.toBeNull();
  });

  it('B2/ an override cannot sell a component missing AT THIS BRANCH (409, not a trigger 500)', async () => {
    const tillA = await setupTill();
    const tillB = await setupTill();
    // Saffron is stocked ONLY at branch B; the recipe names it tenant-wide.
    const saffron = await createComponent(tillB.branchId, 'زعفران', 'Saffron', 'g', '100.0000');
    // itemDrink is recipe-less at this point (cases 5d/12b depend on that),
    // so the requirement set is exactly { saffron } — then restore it.
    await addMenuRecipe(itemDrink, saffron, '1.0000');
    try {
      const ordersBefore = await countWhere('orders', 'tenant_id = $1', [T]);
      const movementsBefore = await countWhere('stock_movements', 'tenant_id = $1', [T]);

      // Branch-A sale with a LIVE manager override: the component has NO
      // row at A — the override covers the shortage, never the non-existence.
      const failure = await placeOrder(tillA.cashier.userId, tillA, [
        { menuItemId: itemDrink, quantity: 1 },
      ], { managerOverride: { managerUserId: stockManager.userId, managerOverridePin: stockManager.pin } }).then(() => null, (error: unknown) => error);
      expect(failure).toBeInstanceOf(InsufficientStockError);

      // The write transaction rolled back whole (no order, no claim, no
      // movement) and branch B's stock is untouched.
      expect(await countWhere('orders', 'tenant_id = $1', [T])).toBe(ordersBefore);
      expect(await countWhere('stock_movements', 'tenant_id = $1', [T])).toBe(movementsBefore);
      expect(await stockOf(saffron)).toBe('100.0000');
    } finally {
      await owner.query('DELETE FROM menu_item_recipes WHERE tenant_id = $1 AND menu_item_id = $2 AND inventory_item_id = $3', [T, itemDrink, saffron]);
    }
  });

  // ── Case 3: trigger-level backstop ───────────────────────────────────────

  it('3/ the trigger rejects a forged sale_deduction: uncovered shortage, fabricated override, and every sign/link/scope CHECK', async () => {
    const till = await setupTill();
    const flour = await createComponent(till.branchId, 'دقيق', 'Flour', 'kg', '0.5000');
    await addMenuRecipe(itemMeal, flour, '0.1000');
    const created = await placeOrder(till.cashier.userId, till, [
      { menuItemId: itemMeal, quantity: 1 },
    ]);
    const orderId = created.order.id;
    const itemId = row([...created.items]).item.id;
    // I1: the sign-CHECK probe below targets a manual_adjustment row, which
    // structurally demands a reason — carry a valid one to reach the CHECK.
    const reason = await createAdjustmentReason();

    async function expectTriggerReject(statement: string, params: readonly unknown[], expected: RegExp): Promise<void> {
      const failure = await withApp(T, (q) => q.query(statement, [...params])).then(() => null, (error: unknown) => error) as { code?: string; message?: string } | null;
      expect(failure).not.toBeNull();
      expect(failure?.code).toBe('23514');
      expect(failure?.message ?? '').toMatch(expected);
    }

    const baseInsert = (overrides: { type?: string; delta?: string; order?: string | null; item?: string | null; override?: string | null; reason?: string | null; actor?: string }) =>
      ({
        text: `INSERT INTO stock_movements (tenant_id, branch_id, inventory_item_id, movement_type, quantity_delta, order_id, order_item_id, manager_override_id, adjustment_reason_id, actor_user_id, occurred_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())`,
        params: [T, till.branchId, flour, overrides.type ?? 'sale_deduction', overrides.delta ?? '-1.0000',
          overrides.order === undefined ? orderId : overrides.order, overrides.item === undefined ? itemId : overrides.item,
          overrides.override === undefined ? null : overrides.override, overrides.reason === undefined ? null : overrides.reason,
          overrides.actor ?? till.cashier.userId],
      });

    // (a) uncovered shortage: would drive 0.4000 below zero with no override.
    {
      const { text, params } = baseInsert({ delta: '-1.0000' });
      await expectTriggerReject(text, params, /^stock: insufficient quantity/);
    }
    // (b) fabricated override: a random UUID that names no succeeded attempt.
    // A CITED-but-invalid override fails closed with the override message —
    // distinct from the no-override shortage prefix the store maps (D9 stays surgical).
    {
      const { text, params } = baseInsert({ delta: '-1.0000', override: randomUUID() });
      await expectTriggerReject(text, params, /sale_deduction override requires a successful stock_override attempt/);
    }
    // (b2) migration 0042: the same gate on a WASTE row names the actual type,
    // not the old hard-coded 'sale_deduction' prefix (sale text is byte-identical).
    {
      const { text, params } = baseInsert({ type: 'waste_void', delta: '0.0000', override: randomUUID() });
      await expectTriggerReject(text, params, /waste_void override requires a successful stock_override attempt/);
    }
    // (c) sign CHECKs: sale must be negative, waste exactly zero, receiving positive, adjustment non-zero.
    {
      const { text, params } = baseInsert({ delta: '1.0000' });
      await expectTriggerReject(text, params, /stock_movements_sign/);
    }
    {
      const { text, params } = baseInsert({ type: 'waste_void', delta: '-0.1000' });
      await expectTriggerReject(text, params, /stock_movements_sign/);
    }
    // Manual types carry a permission gate that fires BEFORE the sign CHECK, so
    // these two rows act as KEYED users to reach the CHECK itself (the keyless
    // path is proven separately to fail with 42501 in cases 11a/11b).
    {
      const { text, params } = baseInsert({ type: 'manual_receiving', delta: '-2.0000', order: null, item: null, actor: receiverUser.userId });
      await expectTriggerReject(text, params, /stock_movements_sign/);
    }
    {
      const { text, params } = baseInsert({ type: 'manual_adjustment', delta: '0.0000', order: null, item: null, reason, actor: adjustUser.userId });
      await expectTriggerReject(text, params, /stock_movements_sign/);
    }
    // (d) link CHECKs: sale/waste/restoration REQUIRE an order+item; manual types FORBID them.
    // A NULL-order SALE dies in the trigger's shortage gate before any CHECK runs,
    // so the order_link CHECK is proven with a waste row (no shortage logic applies).
    {
      const { text, params } = baseInsert({ type: 'waste_void', delta: '0.0000', order: null, item: null });
      await expectTriggerReject(text, params, /stock_movements_order_link/);
    }
    {
      const { text, params } = baseInsert({ type: 'manual_receiving', delta: '2.0000', actor: receiverUser.userId });
      await expectTriggerReject(text, params, /stock_movements_order_link/);
    }
    // (e) scope CHECK: an override may only ever back a sale_deduction.
    // The trigger validates ANY cited override first, so the CHECK itself is
    // reached with a FULLY-VALID override (succeeded attempt + claim) cited on
    // a non-sale row: the trigger passes, the CHECK fires.
    {
      const verified = await authenticator.verifyLiveChallengeWithId(T, stockManager.userId, stockManager.pin, till.cashier.userId, 'stock_override');
      await withApp(T, (q) => q.query(
        'INSERT INTO stock_override_claims (tenant_id, manager_override_id, order_id) VALUES ($1, $2, $3)',
        [T, verified.attemptId, orderId],
      ));
      const { text, params } = baseInsert({ type: 'waste_refund', delta: '0.0000', override: verified.attemptId });
      await expectTriggerReject(text, params, /stock_movements_override_scope/);
    }
    // (f) branch assertion: the movement branch must equal the order branch.
    {
      const otherTill = await setupTill();
      const failure = await withApp(T, (q) => q.query(
        `INSERT INTO stock_movements (tenant_id, branch_id, inventory_item_id, movement_type, quantity_delta, order_id, order_item_id, manager_override_id, actor_user_id, occurred_at)
         VALUES ($1, $2, $3, 'sale_deduction', '-0.1000', $4, $5, NULL, $6, now())`,
        [T, otherTill.branchId, flour, orderId, itemId, till.cashier.userId],
      )).then(() => null, (error: unknown) => error) as { code?: string; message?: string } | null;
      expect(failure?.code).toBe('23514');
      expect(failure?.message ?? '').toMatch(/branch must match/);
    }
    // (g) actor assertion: an inactive user cannot write movements.
    {
      await owner.query('UPDATE users SET is_active = false WHERE id = $1', [till.cashier.userId]);
      try {
        const { text, params } = baseInsert({ delta: '-0.1000' });
        await expectTriggerReject(text, params, /actor/);
      } finally {
        await owner.query('UPDATE users SET is_active = true WHERE id = $1', [till.cashier.userId]);
      }
    }
  });

  it('3b/ the ledger is append-only: grants reject UPDATE/DELETE first, and the trigger backstop rejects even the owner', async () => {
    const till = await setupTill();
    const flour = await createComponent(till.branchId, 'دقيق', 'Flour', 'kg', '5.0000');
    await addMenuRecipe(itemMeal, flour, '0.5000');
    const created = await placeOrder(till.cashier.userId, till, [
      { menuItemId: itemMeal, quantity: 1 },
    ]);

    async function expectAppCode(statement: string, params: readonly unknown[], code: string): Promise<void> {
      const failure = await withApp(T, (q) => q.query(statement, [...params])).then(() => null, (error: unknown) => error) as { code?: string } | null;
      expect(failure?.code).toBe(code);
    }
    async function expectOwnerCode(statement: string, params: readonly unknown[], code: string): Promise<void> {
      const failure = await owner.query(statement, [...params]).then(() => null, (error: unknown) => error) as { code?: string } | null;
      expect(failure?.code).toBe(code);
    }

    // The app role holds no UPDATE/DELETE grants at all: rejected before any trigger fires.
    await expectAppCode('UPDATE stock_movements SET quantity_delta = $1 WHERE tenant_id = $2 AND order_id = $3', ['-9.0000', T, created.order.id], '42501');
    await expectAppCode('DELETE FROM stock_movements WHERE tenant_id = $1 AND order_id = $2', [T, created.order.id], '42501');
    // The immutability trigger is the backstop: it rejects even the RLS-bypassing owner.
    await expectOwnerCode('UPDATE stock_movements SET quantity_delta = $1 WHERE tenant_id = $2 AND order_id = $3', ['-9.0000', T, created.order.id], '55006');
    await expectOwnerCode('DELETE FROM stock_movements WHERE tenant_id = $1 AND order_id = $2', [T, created.order.id], '55006');
    await expectAppCode('UPDATE inventory_items SET current_quantity = $1 WHERE id = $2', ['999.0000', flour], '42501');
    expect(await stockOf(flour)).toBe('4.5000');
  });

  // ── Case 4: the two-order race ────────────────────────────────────────────

  it('4/ two concurrent orders against one unit of stock: exactly one wins and the ledger stays consistent', async () => {
    const till = await setupTill();
    const flour = await createComponent(till.branchId, 'دقيق', 'Flour', 'kg', '2.0000');
    await addMenuRecipe(itemMeal, flour, '2.0000');
    const ordersBefore = await countWhere('orders', 'tenant_id = $1', [T]);

    const attempt = () => placeOrder(till.cashier.userId, till, [
      { menuItemId: itemMeal, quantity: 1 },
    ]);
    const results = await Promise.allSettled([attempt(), attempt()]);
    const winners = results.filter((r): r is PromiseFulfilledResult<CreatedOrder> => r.status === 'fulfilled');
    const losers = results.filter((r) => r.status === 'rejected');
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);

    // Exactly one order exists more than before, the stock is exactly empty,
    // and the ledger nets to exactly -2.0000 (no double deduction, no phantom).
    expect(await countWhere('orders', 'tenant_id = $1', [T])).toBe(ordersBefore + 1);
    expect(await stockOf(flour)).toBe('0.0000');
    const net = row((await owner.query<{ net: string }>(
      "SELECT coalesce(sum(quantity_delta), 0)::text AS net FROM stock_movements WHERE tenant_id = $1 AND inventory_item_id = $2 AND movement_type = 'sale_deduction'",
      [T, flour],
    )).rows).net;
    expect(net).toBe('-2.0000');
  });

  it('4b/ B3 pin: the inventory-path race loser is a retryable 503 (never raw 500, never a mislabelled 409)', async () => {
    const till = await setupTill();
    // AMPLE stock (100 units, 1 per order): a genuine stockout (409) is
    // ARITHMETICALLY IMPOSSIBLE in this scenario — the (a)-vs-(b) split is
    // structural, not probabilistic. Any loser here failed at the trigger's
    // SELECT FOR UPDATE gate (40001: lock/serialization BEFORE the
    // sufficiency arithmetic runs) — the B3 case — or is a leak (bug).
    // The (a) shape stays pinned by the InsufficientStockError legs above.
    const flour = await createComponent(till.branchId, 'دقيق', 'Flour', 'kg', '100.0000');
    await addMenuRecipe(itemMeal, flour, '1.0000');
    try {
      const attempt = () => placeOrder(till.cashier.userId, till, [
        { menuItemId: itemMeal, quantity: 1 },
      ]);
      // Overlap is the norm for two simultaneous multi-statement txs, but a
      // fully-serialized round (both win) is legal — loop until a round
      // yields a loser, bounded. Two losers in one round is arithmetically
      // impossible and fails the round outright.
      const MAX_ROUNDS = 10;
      let decided: { readonly loser: unknown } | null = null;
      let totalWins = 0;
      for (let round = 0; round < MAX_ROUNDS && decided === null; round++) {
        const results = await Promise.allSettled([attempt(), attempt()]);
        const losers = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
        totalWins += results.length - losers.length;
        if (losers.length > 0) {
          expect(losers).toHaveLength(1);
          decided = { loser: losers[0]?.reason };
        }
      }
      if (decided === null) throw new Error(`no overlapped round within ${String(MAX_ROUNDS)} attempts`);
      // The B3 contract, on the inventory path specifically — the PREDICATE,
      // not just the code, so future client retry loops work here too.
      expect(decided.loser).toBeInstanceOf(ConcurrencyRetryableError);
      expect(isConcurrencyRetryableError(decided.loser)).toBe(true);
      expect(toErrorResponse(decided.loser, () => undefined)).toMatchObject({ status: 503, code: 'concurrency.retryable_conflict' });
      // The loser's transaction rolled back CLEANLY (B3's retry-safety
      // claim): stock equals exactly the winners' deductions, nothing more.
      expect(await stockOf(flour)).toBe(`${String(100 - totalWins)}.0000`);
    } finally {
      await removeMenuRecipe(itemMeal, flour);
    }
  });

  // ── Case 5: void before / after the kitchen ticket ───────────────────────

  it('5a/ voiding an item BEFORE the ticket fires restores the recorded deduction exactly', async () => {
    const till = await setupTill();
    const flour = await createComponent(till.branchId, 'دقيق', 'Flour', 'kg', '5.0000');
    await addMenuRecipe(itemMeal, flour, '1.0000');
    const created = await placeOrder(till.cashier.userId, till, [
      { menuItemId: itemMeal, quantity: 2 },
    ]);
    expect(await stockOf(flour)).toBe('3.0000');

    await voids.voidOrderItem(T, { userId: voidServerUser.userId, tokenSecV: voidServerUser.tokenSecV }, {
      orderItemId: row([...created.items]).item.id, voidReasonId: reasonServer,
    });

    expect(await stockOf(flour)).toBe('5.0000');
    const movements = await movementsFor(created.order.id);
    expect(movements.map((m) => [m.movement_type, m.quantity_delta])).toEqual([
      ['sale_deduction', '-2.0000'],
      ['void_restoration', '2.0000'],
    ]);
    expect(row([...movements].slice(1)).manager_override_id).toBeNull();
  });

  it('5b/ voiding an item AFTER the ticket fired writes zero-delta waste and keeps the deduction', async () => {
    const till = await setupTill();
    const flour = await createComponent(till.branchId, 'دقيق', 'Flour', 'kg', '5.0000');
    await addMenuRecipe(itemMeal, flour, '1.0000');
    const created = await placeOrder(till.cashier.userId, till, [
      { menuItemId: itemMeal, quantity: 2 },
    ]);
    const itemId = row([...created.items]).item.id;
    await transitions.transitionItem(T, { orderItemId: itemId, toWorkflowStateId: preparingStateId, actorUserId: till.cashier.userId, tokenSecV: till.cashier.tokenSecV });

    await voids.voidOrderItem(T, { userId: voidServerUser.userId, tokenSecV: voidServerUser.tokenSecV }, {
      orderItemId: itemId, voidReasonId: reasonServer,
    });

    expect(await stockOf(flour)).toBe('3.0000');
    const movements = await movementsFor(created.order.id);
    expect(movements.map((m) => [m.movement_type, m.quantity_delta])).toEqual([
      ['sale_deduction', '-2.0000'],
      ['waste_void', '0.0000'],
    ]);
  });

  it('5c/ an order-level void branches PER LINE: fired lines waste, unfired lines restore', async () => {
    const till = await setupTill();
    const flour = await createComponent(till.branchId, 'دقيق', 'Flour', 'kg', '10.0000');
    await addMenuRecipe(itemMeal, flour, '1.0000');
    const created = await placeOrder(till.cashier.userId, till, [
      { menuItemId: itemMeal, quantity: 2 },
      { menuItemId: itemMeal, quantity: 3 },
    ]);
    expect(await stockOf(flour)).toBe('5.0000');
    // Fire the ticket on the FIRST line only.
    await transitions.transitionItem(T, { orderItemId: row([...created.items]).item.id, toWorkflowStateId: preparingStateId, actorUserId: till.cashier.userId, tokenSecV: till.cashier.tokenSecV });

    await voids.voidOrder(T, { userId: voidServerUser.userId, tokenSecV: voidServerUser.tokenSecV }, {
      orderId: created.order.id, voidReasonId: reasonServer,
    });

    // Fired line (2.0000) stays deducted as waste; unfired line (3.0000) restores.
    expect(await stockOf(flour)).toBe('8.0000');
    const movements = await movementsFor(created.order.id);
    expect(movements.map((m) => [m.movement_type, m.quantity_delta]).sort()).toEqual([
      ['sale_deduction', '-2.0000'],
      ['sale_deduction', '-3.0000'],
      ['void_restoration', '3.0000'],
      ['waste_void', '0.0000'],
    ]);
  });

  it('5d/ voiding a recipe-less line writes no stock movements at all', async () => {
    const till = await setupTill();
    const created = await placeOrder(till.cashier.userId, till, [
      { menuItemId: itemDrink, quantity: 1 },
    ]);
    expect(await movementsFor(created.order.id)).toHaveLength(0);

    await voids.voidOrderItem(T, { userId: voidServerUser.userId, tokenSecV: voidServerUser.tokenSecV }, {
      orderItemId: row([...created.items]).item.id, voidReasonId: reasonServer,
    });
    expect(await movementsFor(created.order.id)).toHaveLength(0);
  });

  // ── Case 6: post-payment refunds ──────────────────────────────────────────

  it('6a/ a post-payment refund AFTER the ticket fired writes zero-delta waste per deducted component and leaves the balance deducted', async () => {
    const till = await setupTill();
    const flour = await createComponent(till.branchId, 'دقيق', 'Flour', 'kg', '5.0000');
    await addMenuRecipe(itemMeal, flour, '1.0000');
    const created = await placeOrder(till.cashier.userId, till, [
      { menuItemId: itemMeal, quantity: 2 },
    ]);
    // Fire the ticket BEFORE payment: the prepared line is waste, never restocked.
    await transitions.transitionItem(T, { orderItemId: row([...created.items]).item.id, toWorkflowStateId: preparingStateId, actorUserId: till.cashier.userId, tokenSecV: till.cashier.tokenSecV });
    expect(await stockOf(flour)).toBe('3.0000');
    const totals = await payments.orderTotals(T, created.order.id);
    const payment = await payments.recordPayment(T, {
      orderId: created.order.id, paymentMethodId: methodCashId, cashierUserId: till.cashier.userId,
      amountText: minorToText(totals.totalMinor),
    });

    await payments.refundPayment(T, { userId: till.cashier.userId, tokenSecV: till.cashier.tokenSecV }, {
      paymentId: payment.payment.id,
    });

    expect(await stockOf(flour)).toBe('3.0000');
    const movements = await movementsFor(created.order.id);
    expect(movements.map((m) => [m.movement_type, m.quantity_delta])).toEqual([
      ['sale_deduction', '-2.0000'],
      ['waste_refund', '0.0000'],
    ]);
    const paymentStatus = row((await owner.query<{ payment_status: string }>('SELECT payment_status FROM orders WHERE id = $1', [created.order.id])).rows).payment_status;
    expect(paymentStatus).toBe('refunded');
  });

  it('6b/ two refunded legs of one order write the restoration row ONCE (dedup), and a corrected payment writes none', async () => {
    const till = await setupTill();
    const flour = await createComponent(till.branchId, 'دقيق', 'Flour', 'kg', '5.0000');
    await addMenuRecipe(itemMeal, flour, '1.0000');
    const created = await placeOrder(till.cashier.userId, till, [
      { menuItemId: itemMeal, quantity: 1 }, // 20.00 + 15% VAT = 23.00
    ]);
    const leg1 = await payments.recordPayment(T, {
      orderId: created.order.id, paymentMethodId: methodCashId, cashierUserId: till.cashier.userId, amountText: '10.00',
    });
    const leg2 = await payments.recordPayment(T, {
      orderId: created.order.id, paymentMethodId: methodCashId, cashierUserId: till.cashier.userId, amountText: '13.00',
    });

    await payments.refundPayment(T, { userId: till.cashier.userId, tokenSecV: till.cashier.tokenSecV }, { paymentId: leg1.payment.id });
    expect((await movementsFor(created.order.id)).filter((m) => m.movement_type === 'void_restoration')).toHaveLength(1);
    await payments.refundPayment(T, { userId: till.cashier.userId, tokenSecV: till.cashier.tokenSecV }, { paymentId: leg2.payment.id });
    expect((await movementsFor(created.order.id)).filter((m) => m.movement_type === 'void_restoration')).toHaveLength(1);
    expect(await stockOf(flour)).toBe('5.0000');

    // A voided (corrected) payment is NOT a customer return: no refund movement at all.
    const created2 = await placeOrder(till.cashier.userId, till, [
      { menuItemId: itemMeal, quantity: 1 },
    ]);
    const payment2 = await payments.recordPayment(T, {
      orderId: created2.order.id, paymentMethodId: methodCashId, cashierUserId: till.cashier.userId, amountText: '23.00',
    });
    await payments.voidPayment(T, { userId: till.cashier.userId, tokenSecV: till.cashier.tokenSecV }, {
      paymentId: payment2.payment.id, reason: 'تصحيح قبل الإغلاق',
    });
    expect((await movementsFor(created2.order.id)).filter((m) => m.movement_type === 'waste_refund')).toHaveLength(0);
    expect((await movementsFor(created2.order.id)).filter((m) => m.movement_type === 'void_restoration')).toHaveLength(0);
  });

  it('6c/ a refund after a pre-ticket void restores the still-live line (the voided line is never double-counted)', async () => {
    const till = await setupTill();
    const flour = await createComponent(till.branchId, 'دقيق', 'Flour', 'kg', '10.0000');
    await addMenuRecipe(itemMeal, flour, '1.0000');
    const created = await placeOrder(till.cashier.userId, till, [
      { menuItemId: itemMeal, quantity: 1 },
      { menuItemId: itemMeal, quantity: 1 },
    ]);
    // Void the first line BEFORE its ticket (restores), then pay + refund the rest.
    await voids.voidOrderItem(T, { userId: voidServerUser.userId, tokenSecV: voidServerUser.tokenSecV }, {
      orderItemId: row([...created.items]).item.id, voidReasonId: reasonServer,
    });
    expect(await stockOf(flour)).toBe('9.0000');
    const totals = await payments.orderTotals(T, created.order.id);
    const payment = await payments.recordPayment(T, {
      orderId: created.order.id, paymentMethodId: methodCashId, cashierUserId: till.cashier.userId,
      amountText: minorToText(totals.remainingBalanceMinor),
    });
    await payments.refundPayment(T, { userId: till.cashier.userId, tokenSecV: till.cashier.tokenSecV }, { paymentId: payment.payment.id });

    const movements = await movementsFor(created.order.id);
    expect(movements.map((m) => [m.movement_type, m.quantity_delta]).sort()).toEqual([
      ['sale_deduction', '-1.0000'],
      ['sale_deduction', '-1.0000'],
      ['void_restoration', '1.0000'],
      ['void_restoration', '1.0000'],
    ]);
    expect((await movementsFor(created.order.id)).filter((m) => m.movement_type === 'waste_refund')).toHaveLength(0);
    expect(await stockOf(flour)).toBe('10.0000');
  });

  it('6d/ a pre-ticket refund RESTORES the recorded deduction exactly (balance rises)', async () => {
    const till = await setupTill();
    const flour = await createComponent(till.branchId, 'دقيق', 'Flour', 'kg', '5.0000');
    await addMenuRecipe(itemMeal, flour, '1.0000');
    const created = await placeOrder(till.cashier.userId, till, [
      { menuItemId: itemMeal, quantity: 2 },
    ]);
    expect(await stockOf(flour)).toBe('3.0000');
    const totals = await payments.orderTotals(T, created.order.id);
    const payment = await payments.recordPayment(T, {
      orderId: created.order.id, paymentMethodId: methodCashId, cashierUserId: till.cashier.userId,
      amountText: minorToText(totals.totalMinor),
    });

    // No ticket fired: the unprepared line restores, mirroring the void path (5a).
    await payments.refundPayment(T, { userId: till.cashier.userId, tokenSecV: till.cashier.tokenSecV }, {
      paymentId: payment.payment.id,
    });

    expect(await stockOf(flour)).toBe('5.0000');
    const movements = await movementsFor(created.order.id);
    expect(movements.map((m) => [m.movement_type, m.quantity_delta])).toEqual([
      ['sale_deduction', '-2.0000'],
      ['void_restoration', '2.0000'],
    ]);
  });

  it('6e/ a partial refund followed by a void does NOT double-restore (the void skips the refund-restored line)', async () => {
    const till = await setupTill();
    const flour = await createComponent(till.branchId, 'دقيق', 'Flour', 'kg', '5.0000');
    await addMenuRecipe(itemMeal, flour, '1.0000');
    const created = await placeOrder(till.cashier.userId, till, [
      { menuItemId: itemMeal, quantity: 1 }, // 20.00 + 15% VAT = 23.00
    ]);
    const itemId = row([...created.items]).item.id;
    const leg1 = await payments.recordPayment(T, {
      orderId: created.order.id, paymentMethodId: methodCashId, cashierUserId: till.cashier.userId, amountText: '10.00',
    });
    await payments.recordPayment(T, {
      orderId: created.order.id, paymentMethodId: methodCashId, cashierUserId: till.cashier.userId, amountText: '13.00',
    });

    // Partial refund on the UNFIRED line: stock comes home, status back to 'open'.
    await payments.refundPayment(T, { userId: till.cashier.userId, tokenSecV: till.cashier.tokenSecV }, { paymentId: leg1.payment.id });
    expect(await stockOf(flour)).toBe('5.0000');

    // The later void must NOT restore a second time (stock already home).
    await voids.voidOrderItem(T, { userId: voidServerUser.userId, tokenSecV: voidServerUser.tokenSecV }, {
      orderItemId: itemId, voidReasonId: reasonServer,
    });

    expect(await stockOf(flour)).toBe('5.0000');
    const movements = await movementsFor(created.order.id);
    expect(movements.map((m) => [m.movement_type, m.quantity_delta])).toEqual([
      ['sale_deduction', '-1.0000'],
      ['void_restoration', '1.0000'],
    ]);
  });

  // ── Case 7: receiving conversions ─────────────────────────────────────────

  it('7a/ receiving converts the purchase unit to the base unit with banker rounding at scale 4', async () => {
    const till = await setupTill();
    const sugar = await createComponent(till.branchId, 'سكر', 'Sugar', 'g', '0.0000');
    await addConversion(sugar, 'kg', 'g', '1000.00000000');
    const actor = { userId: receiverUser.userId, tokenSecV: receiverUser.tokenSecV };

    const received = await inventory.receiveStock(T, actor, {
      branchId: till.branchId, inventoryItemId: sugar, purchaseUnit: 'kg', quantityText: '2.50000000', occurredAt: new Date(),
    });
    expect(received.quantityDelta).toBe('2500.0000');
    expect(received.movementType).toBe('manual_receiving');
    expect(await stockOf(sugar)).toBe('2500.0000');

    // Same-unit receiving skips the conversion lookup entirely.
    const sameUnit = await inventory.receiveStock(T, actor, {
      branchId: till.branchId, inventoryItemId: sugar, purchaseUnit: 'g', quantityText: '3.5', occurredAt: new Date(),
    });
    expect(sameUnit.quantityDelta).toBe('3.5000');
    expect(await stockOf(sugar)).toBe('2503.5000');

    // Repeating factor rounds HALF_EVEN at scale 4: 1 lb × 0.45359237 = 0.4536 kg.
    const spice = await createComponent(till.branchId, 'بهارات', 'Spice', 'kg', '0.0000');
    await addConversion(spice, 'lb', 'kg', '0.45359237');
    const rounded = await inventory.receiveStock(T, actor, {
      branchId: till.branchId, inventoryItemId: spice, purchaseUnit: 'lb', quantityText: '1.00000000', occurredAt: new Date(),
    });
    expect(rounded.quantityDelta).toBe('0.4536');
    expect(await stockOf(spice)).toBe('0.4536');
  });

  it('F-B/a caller-supplied movement occurredAt (past or future) is ignored: receive + adjust stamp server time', async () => {
    const till = await setupTill();
    const sugar = await createComponent(till.branchId, 'سكر', 'Sugar', 'g', '10.0000');
    const flour = await createComponent(till.branchId, 'دقيق', 'Flour', 'kg', '10.0000');
    const reason = await createAdjustmentReason();
    const past = new Date('2020-01-01T00:00:00.000Z');
    const future = new Date('2031-01-01T00:00:00.000Z');

    const before = Date.now();
    const received = await inventory.receiveStock(T, { userId: receiverUser.userId, tokenSecV: receiverUser.tokenSecV }, {
      branchId: till.branchId, inventoryItemId: sugar, purchaseUnit: 'kg', quantityText: '1.00000000', occurredAt: past,
    });
    const adjusted = await inventory.adjustStock(T, { userId: adjustUser.userId, tokenSecV: adjustUser.tokenSecV }, {
      branchId: till.branchId, inventoryItemId: flour, adjustmentReasonId: reason, quantityDeltaText: '-1.0000', occurredAt: future,
    });
    const after = Date.now();
    for (const [movement, supplied] of [[received, past], [adjusted, future]] as const) {
      expect(movement.occurredAt.getTime()).toBeGreaterThanOrEqual(before - 1_000);
      expect(movement.occurredAt.getTime()).toBeLessThanOrEqual(after + 1_000);
      expect(Math.abs(movement.occurredAt.getTime() - supplied.getTime())).toBeGreaterThan(365 * 24 * 3_600_000);
    }
  });

  it('7b/ receiving rejects a missing conversion and every malformed quantity', async () => {
    const till = await setupTill();
    const sugar = await createComponent(till.branchId, 'سكر', 'Sugar', 'g', '10.0000');
    const actor = { userId: receiverUser.userId, tokenSecV: receiverUser.tokenSecV };

    // I4: 'oz' is now a registered universal unit, so the unknown-unit leg
    // uses 'sachet' — no item row AND no registry entry, still rejected.
    // No sachet→g conversion exists anywhere for this component.
    await expect(inventory.receiveStock(T, actor, {
      branchId: till.branchId, inventoryItemId: sugar, purchaseUnit: 'sachet', quantityText: '1.00000000',
    })).rejects.toBeInstanceOf(ValidationError);

    for (const bad of ['1.000000001', '0', '0.00000000', '-5', 'abc', '1,000']) {
      await expect(inventory.receiveStock(T, actor, {
        branchId: till.branchId, inventoryItemId: sugar, purchaseUnit: 'g', quantityText: bad,
      })).rejects.toBeInstanceOf(ValidationError);
    }
    expect(await stockOf(sugar)).toBe('10.0000');
  });

  it('7c/ the SALE path never converts: deductions are pure base-unit math against the already-converted balance', async () => {
    const till = await setupTill();
    const sugar = await createComponent(till.branchId, 'سكر', 'Sugar', 'g', '0.0000');
    await addConversion(sugar, 'kg', 'g', '1000.00000000');
    await addMenuRecipe(itemMeal, sugar, '100.0000'); // 100 g per unit, base units
    const actor = { userId: receiverUser.userId, tokenSecV: receiverUser.tokenSecV };

    // Stock arrives in kg (converted once, at receiving) …
    await inventory.receiveStock(T, actor, {
      branchId: till.branchId, inventoryItemId: sugar, purchaseUnit: 'kg', quantityText: '1.00000000', occurredAt: new Date(),
    });
    expect(await stockOf(sugar)).toBe('1000.0000');

    // … and the sale deducts exactly 100.0000 base grams — no factor applied.
    const created = await placeOrder(till.cashier.userId, till, [
      { menuItemId: itemMeal, quantity: 1 },
    ]);
    const movements = await movementsFor(created.order.id);
    expect(movements).toHaveLength(1);
    expect(row([...movements]).quantity_delta).toBe('-100.0000');
    expect(await stockOf(sugar)).toBe('900.0000');
  });

  // ── Case 8: claim single-use ─────────────────────────────────────────────

  it('8a/ a consumed override attempt cannot authorize a SECOND order (claim single-use at the trigger)', async () => {
    const till = await setupTill();
    const flour = await createComponent(till.branchId, 'دقيق', 'Flour', 'kg', '10.0000');
    await addMenuRecipe(itemMeal, flour, '0.5000');

    // Order A: override-approved (consumes the attempt via its claim).
    const orderA = await placeOrder(till.cashier.userId, till, [
      { menuItemId: itemMeal, quantity: 30 }, // needs 15.0000 of 10.0000
    ], { managerOverride: { managerUserId: stockManager.userId, managerOverridePin: stockManager.pin } });
    const attemptId = row(await movementsFor(orderA.order.id)).manager_override_id;
    expect(attemptId).not.toBeNull();

    // Restock so order B is genuinely in-stock (balance -5.0000 + 10.0000 = 5.0000).
    await inventory.receiveStock(T, { userId: receiverUser.userId, tokenSecV: receiverUser.tokenSecV }, {
      branchId: till.branchId, inventoryItemId: flour, purchaseUnit: 'kg', quantityText: '10.00000000', occurredAt: new Date(),
    });

    // Order B: a plain in-stock order, fully paid-up on its own deductions.
    const orderB = await placeOrder(till.cashier.userId, till, [
      { menuItemId: itemMeal, quantity: 1 },
    ]);
    const itemB = row([...orderB.items]).item.id;

    // Forgery: a sale_deduction for order B citing order A's STILL-FRESH attempt.
    // The attempt is valid (succeeded, stock context, in-window) but no claim
    // binds it to order B → the trigger MUST reject with the single-use message.
    const failure = await withApp(T, (q) => q.query(
      `INSERT INTO stock_movements (tenant_id, branch_id, inventory_item_id, movement_type, quantity_delta, order_id, order_item_id, manager_override_id, actor_user_id, occurred_at)
       VALUES ($1, $2, $3, 'sale_deduction', '-99.0000', $4, $5, $6, $7, now())`,
      [T, till.branchId, flour, orderB.order.id, itemB, attemptId, till.cashier.userId],
    )).then(() => null, (error: unknown) => error) as { code?: string; message?: string } | null;
    expect(failure?.code).toBe('23514');
    expect(failure?.message ?? '').toMatch(/requires a single-use claim binding the attempt to this order/);
  });

  it('8b/ two concurrent claims on one attempt: exactly one wins (PK single-use)', async () => {
    const till = await setupTill();
    const flour = await createComponent(till.branchId, 'دقيق', 'Flour', 'kg', '10.0000');
    await addMenuRecipe(itemMeal, flour, '0.1000');
    const created = await placeOrder(till.cashier.userId, till, [
      { menuItemId: itemMeal, quantity: 1 },
    ]);

    // A fresh, succeeded, stock-context attempt not yet bound to any order.
    const verified = await authenticator.verifyLiveChallengeWithId(T, stockManager.userId, stockManager.pin, till.cashier.userId, 'stock_override');

    const claim = () => withApp(T, (q) => q.query(
      'INSERT INTO stock_override_claims (tenant_id, manager_override_id, order_id) VALUES ($1, $2, $3)',
      [T, verified.attemptId, created.order.id],
    ));
    const results = await Promise.allSettled([claim(), claim()]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const losers = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(losers).toHaveLength(1);
    expect(losers[0]?.reason?.code).toBe('23505');
    expect(await countWhere('stock_override_claims', 'tenant_id = $1 AND manager_override_id = $2', [T, verified.attemptId])).toBe(1);
  });

  it('8c/ a void-context override attempt NEVER authorizes a sale_deduction (context scoping at the trigger)', async () => {
    const till = await setupTill();
    const flour = await createComponent(till.branchId, 'دقيق', 'Flour', 'kg', '10.0000');
    await addMenuRecipe(itemMeal, flour, '0.1000');
    const created = await placeOrder(till.cashier.userId, till, [
      { menuItemId: itemMeal, quantity: 1 },
    ]);
    const itemId = row([...created.items]).item.id;

    // A succeeded VOID-context attempt (created the same way the void engine does).
    const verified = await authenticator.verifyLiveChallengeWithId(T, stockManager.userId, stockManager.pin, till.cashier.userId, 'void', created.order.id);
    // Even WITH a claim row present, the movement trigger checks the context.
    // A foreign-context attempt fails with the override message, never the shortage prefix.
    await withApp(T, (q) => q.query(
      'INSERT INTO stock_override_claims (tenant_id, manager_override_id, order_id) VALUES ($1, $2, $3)',
      [T, verified.attemptId, created.order.id],
    ));
    const failure = await withApp(T, (q) => q.query(
      `INSERT INTO stock_movements (tenant_id, branch_id, inventory_item_id, movement_type, quantity_delta, order_id, order_item_id, manager_override_id, actor_user_id, occurred_at)
       VALUES ($1, $2, $3, 'sale_deduction', '-99.0000', $4, $5, $6, $7, now())`,
      [T, till.branchId, flour, created.order.id, itemId, verified.attemptId, till.cashier.userId],
    )).then(() => null, (error: unknown) => error) as { code?: string; message?: string } | null;
    expect(failure?.code).toBe('23514');
    expect(failure?.message ?? '').toMatch(/sale_deduction override requires a successful stock_override attempt/);
  });

  it('8d/ a STALE override attempt NEVER authorizes a sale_deduction even WITH a claim row (freshness at the trigger)', async () => {
    const till = await setupTill();
    const flour = await createComponent(till.branchId, 'دقيق', 'Flour', 'kg', '10.0000');
    await addMenuRecipe(itemMeal, flour, '0.1000');
    const created = await placeOrder(till.cashier.userId, till, [
      { menuItemId: itemMeal, quantity: 1 },
    ]);
    const itemId = row([...created.items]).item.id;

    // A succeeded stock_override attempt that went STALE (16 minutes old).
    // Attempts are UPDATE-immutable (0028), so the aged row is forged
    // directly — the only way a stale attempt can exist at the trigger.
    // The deduction below is IN-STOCK on purpose: the shortage gate (block g)
    // stays silent, so the ONLY possible rejection is block (f) staleness.
    const staleAttemptId = randomUUID();
    await owner.query(
      `INSERT INTO manager_override_attempts (id, tenant_id, target_manager_user_id, initiating_actor_user_id, outcome, context_type, created_at)
       VALUES ($1, $2, $3, $4, 'succeeded', 'stock_override', now() - make_interval(mins => 16))`,
      [staleAttemptId, T, stockManager.userId, till.cashier.userId],
    );
    // Even WITH a claim row binding the old authorization to this order, the
    // movement trigger checks freshness: it cannot fund a new sale.
    await withApp(T, (q) => q.query(
      'INSERT INTO stock_override_claims (tenant_id, manager_override_id, order_id) VALUES ($1, $2, $3)',
      [T, staleAttemptId, created.order.id],
    ));
    const failure = await withApp(T, (q) => q.query(
      `INSERT INTO stock_movements (tenant_id, branch_id, inventory_item_id, movement_type, quantity_delta, order_id, order_item_id, manager_override_id, actor_user_id, occurred_at)
       VALUES ($1, $2, $3, 'sale_deduction', '-0.1000', $4, $5, $6, $7, now())`,
      [T, till.branchId, flour, created.order.id, itemId, staleAttemptId, till.cashier.userId],
    )).then(() => null, (error: unknown) => error) as { code?: string; message?: string } | null;
    expect(failure?.code).toBe('23514');
    expect(failure?.message ?? '').toMatch(/sale_deduction override attempt is stale \(older than 15 minutes\)/);

    // Sensitivity control: the IDENTICAL forgery with a FRESH attempt
    // succeeds — staleness is the only rejected property.
    const fresh = await authenticator.verifyLiveChallengeWithId(T, stockManager.userId, stockManager.pin, till.cashier.userId, 'stock_override');
    await withApp(T, (q) => q.query(
      'INSERT INTO stock_override_claims (tenant_id, manager_override_id, order_id) VALUES ($1, $2, $3)',
      [T, fresh.attemptId, created.order.id],
    ));
    await withApp(T, (q) => q.query(
      `INSERT INTO stock_movements (tenant_id, branch_id, inventory_item_id, movement_type, quantity_delta, order_id, order_item_id, manager_override_id, actor_user_id, occurred_at)
       VALUES ($1, $2, $3, 'sale_deduction', '-0.1000', $4, $5, $6, $7, now())`,
      [T, till.branchId, flour, created.order.id, itemId, fresh.attemptId, till.cashier.userId],
    ));
    expect(await countWhere('stock_movements', 'tenant_id = $1 AND order_id = $2 AND manager_override_id = $3', [T, created.order.id, fresh.attemptId])).toBe(1);
  });

  // ── Case 9: no stock oracle ──────────────────────────────────────────────

  it('9/ a shiftless cashier gets the gateway error — with ZERO stock information in the message', async () => {
    const till = await setupTill();
    const flour = await createComponent(till.branchId, 'دقيق', 'Flour', 'kg', '0.0000');
    await addMenuRecipe(itemMeal, flour, '1.0000');
    const shiftless = await createPlainUser('1212');
    const lines: readonly NewOrderItemLine[] = [{ menuItemId: itemMeal, quantity: 1 }];

    // (a) No shift at all → gateway error, no leak.
    const noShift = await placeOrder(shiftless.userId, till, lines).then(() => null, (error: unknown) => error);
    expect(noShift).toBeInstanceOf(CashierShiftRequiredError);
    expect((noShift as Error).message).not.toContain('دقيق');
    expect((noShift as Error).message).not.toContain(flour);
    expect((noShift as Error).message.toLowerCase()).not.toContain('stock');
    expect((noShift as Error).message.toLowerCase()).not.toContain('insufficient');

    // (b) Non-member (well-formed but unknown user) → Forbidden, no leak.
    const stranger = await placeOrder(randomUUID(), till, lines).then(() => null, (error: unknown) => error);
    expect(stranger).toBeInstanceOf(ForbiddenError);
    expect((stranger as Error).message).not.toContain('دقيق');
    expect((stranger as Error).message).not.toContain(flour);

    // (c) Shift open at ANOTHER branch → gateway error, no leak.
    const otherTill = await setupTill();
    const wrongBranch = await placeOrder(otherTill.cashier.userId, till, lines).then(() => null, (error: unknown) => error);
    expect(wrongBranch).toBeInstanceOf(CashierShiftRequiredError);
    expect((wrongBranch as Error).message).not.toContain('دقيق');

    // (d) CONTROL: the same empty stock WITH an open shift DOES report the shortage by name.
    const control = await placeOrder(till.cashier.userId, till, lines).then(() => null, (error: unknown) => error);
    expect(control).toBeInstanceOf(InsufficientStockError);
    expect((control as Error).message).toContain('دقيق');
  });

  // ── Case 10: view isolation ──────────────────────────────────────────────

  it('10/ recipe_ingredients is tenant-isolated: each tenant sees only its own rows', async () => {
    // Minimal T2 world: branch + category + item + component + recipe.
    const t2Branch = randomUUID();
    await owner.query(
      "INSERT INTO branches (id, tenant_id, name, base_currency, timezone, country_code) VALUES ($1, $2, 'فرع العزل', 'SAR', 'Asia/Riyadh', 'SA')",
      [t2Branch, T2],
    );
    const t2Category = randomUUID();
    await owner.query('INSERT INTO menu_categories (id, tenant_id, name, sort_order) VALUES ($1, $2, $3::jsonb, 0)', [t2Category, T2, JSON.stringify({ ar: 'عزل' })]);
    const t2Item = randomUUID();
    await owner.query(
      'INSERT INTO menu_items (id, tenant_id, category_id, name, base_price_amount_minor, base_price_currency_code) VALUES ($1, $2, $3, $4::jsonb, 1000, $5)',
      [t2Item, T2, t2Category, JSON.stringify({ ar: 'صنف عزل' }), 'SAR'],
    );
    const t2Component = randomUUID();
    await owner.query(
      'INSERT INTO inventory_items (id, tenant_id, branch_id, name, base_unit, current_quantity, is_active) VALUES ($1, $2, $3, $4::jsonb, $5, $6, true)',
      [t2Component, T2, t2Branch, JSON.stringify({ ar: 'مكون عزل', en: 'Isolation' }), 'kg', '7.0000'],
    );
    await owner.query('INSERT INTO menu_item_recipes (tenant_id, menu_item_id, inventory_item_id, quantity_required) VALUES ($1, $2, $3, $4)', [T2, t2Item, t2Component, '1.0000']);

    const seenFromT = await withApp(T, (q) => q.query('SELECT inventory_item_id FROM recipe_ingredients WHERE tenant_id = $1', [T2]));
    expect(seenFromT.rows).toHaveLength(0);
    const seenFromT2 = await withApp(T2, (q) => q.query('SELECT inventory_item_id FROM recipe_ingredients'));
    expect(seenFromT2.rows).toHaveLength(1);
    expect(row(seenFromT2.rows)['inventory_item_id']).toBe(t2Component);
    // Sanity: the owner (RLS-bypassing) sees the T2 row, so the test above is not vacuous.
    expect(await countWhere('recipe_ingredients', 'tenant_id = $1', [T2])).toBe(1);
  });

  // ── Case 11: permissions ─────────────────────────────────────────────────

  it('11a/ receiving demands inventory:receive at the engine AND at the trigger', async () => {
    const till = await setupTill();
    const sugar = await createComponent(till.branchId, 'سكر', 'Sugar', 'g', '0.0000');
    const keyless = await createPlainUser('1313');

    await expect(inventory.receiveStock(T, { userId: keyless.userId, tokenSecV: keyless.tokenSecV }, {
      branchId: till.branchId, inventoryItemId: sugar, purchaseUnit: 'g', quantityText: '5.00000000',
    })).rejects.toBeInstanceOf(ForbiddenError);

    // Defense in depth: even raw SQL as the keyless user is rejected by the trigger (42501, not 23514).
    const failure = await withApp(T, (q) => q.query(
      `INSERT INTO stock_movements (tenant_id, branch_id, inventory_item_id, movement_type, quantity_delta, order_id, order_item_id, manager_override_id, actor_user_id, occurred_at)
       VALUES ($1, $2, $3, 'manual_receiving', '5.0000', NULL, NULL, NULL, $4, now())`,
      [T, till.branchId, sugar, keyless.userId],
    )).then(() => null, (error: unknown) => error) as { code?: string; message?: string } | null;
    expect(failure?.code).toBe('42501');
    expect(failure?.message ?? '').toMatch(/inventory:receive/);
    expect(await stockOf(sugar)).toBe('0.0000');
  });

  it('11b/ adjusting demands inventory:adjust at the engine AND at the trigger, with strict signed deltas', async () => {
    const till = await setupTill();
    const flour = await createComponent(till.branchId, 'دقيق', 'Flour', 'kg', '10.0000');
    const reason = await createAdjustmentReason();
    const keyless = await createPlainUser('1414');

    await expect(inventory.adjustStock(T, { userId: keyless.userId, tokenSecV: keyless.tokenSecV }, {
      branchId: till.branchId, inventoryItemId: flour, adjustmentReasonId: reason, quantityDeltaText: '-1.0000',
    })).rejects.toBeInstanceOf(ForbiddenError);

    const failure = await withApp(T, (q) => q.query(
      `INSERT INTO stock_movements (tenant_id, branch_id, inventory_item_id, movement_type, quantity_delta, order_id, order_item_id, manager_override_id, actor_user_id, occurred_at)
       VALUES ($1, $2, $3, 'manual_adjustment', '-1.0000', NULL, NULL, NULL, $4, now())`,
      [T, till.branchId, flour, keyless.userId],
    )).then(() => null, (error: unknown) => error) as { code?: string; message?: string } | null;
    expect(failure?.code).toBe('42501');
    expect(failure?.message ?? '').toMatch(/inventory:adjust/);

    // The keyed path works in both directions and records the actor.
    const actor = { userId: adjustUser.userId, tokenSecV: adjustUser.tokenSecV };
    const down = await inventory.adjustStock(T, actor, {
      branchId: till.branchId, inventoryItemId: flour, adjustmentReasonId: reason, quantityDeltaText: '-2.5000', occurredAt: new Date(),
    });
    expect(down.movementType).toBe('manual_adjustment');
    expect(down.quantityDelta).toBe('-2.5000');
    expect(down.actorUserId).toBe(adjustUser.userId);
    expect(down.orderId).toBeNull();
    const up = await inventory.adjustStock(T, actor, {
      branchId: till.branchId, inventoryItemId: flour, adjustmentReasonId: reason, quantityDeltaText: '0.2500', occurredAt: new Date(),
    });
    expect(up.quantityDelta).toBe('0.2500');
    expect(await stockOf(flour)).toBe('7.7500');

    // Strict validation: zero, 5-decimal, branch mismatch, unknown item.
    await expect(inventory.adjustStock(T, actor, { branchId: till.branchId, inventoryItemId: flour, adjustmentReasonId: reason, quantityDeltaText: '0.0000' })).rejects.toBeInstanceOf(ValidationError);
    await expect(inventory.adjustStock(T, actor, { branchId: till.branchId, inventoryItemId: flour, adjustmentReasonId: reason, quantityDeltaText: '1.00000' })).rejects.toBeInstanceOf(ValidationError);
    await expect(inventory.adjustStock(T, actor, { branchId: randomUUID(), inventoryItemId: flour, adjustmentReasonId: reason, quantityDeltaText: '1.0000' })).rejects.toBeInstanceOf(ValidationError);
    await expect(inventory.adjustStock(T, actor, { branchId: till.branchId, inventoryItemId: randomUUID(), adjustmentReasonId: reason, quantityDeltaText: '1.0000' })).rejects.toBeInstanceOf(NotFoundError);
    expect(await stockOf(flour)).toBe('7.7500');
  });

  // ── Case 12: modifiers, no-op, mirror ────────────────────────────────────

  it('12a/ menu-item and modifier recipes deduct separately and scale with the line quantity', async () => {
    const till = await setupTill();
    const flour = await createComponent(till.branchId, 'دقيق', 'Flour', 'kg', '10.0000');
    const cheese = await createComponent(till.branchId, 'جبن', 'Cheese', 'kg', '10.0000');
    await addMenuRecipe(itemMeal, flour, '0.5000');
    await addModifierRecipe(modifierCheese, cheese, '0.1000');

    const created = await placeOrder(till.cashier.userId, till, [{
      menuItemId: itemMeal, quantity: 2,
      modifiers: [{ modifierId: modifierCheese, name: { ar: 'جبن' }, priceDeltaMinor: 200n }],
    }]);

    expect(await stockOf(flour)).toBe('9.0000');
    expect(await stockOf(cheese)).toBe('9.8000');
    const movements = await movementsFor(created.order.id);
    const expected = [[cheese, '-0.2000'], [flour, '-1.0000']].sort();
    expect(movements.map((m) => [m.inventory_item_id, m.quantity_delta]).sort()).toEqual(expected);
  });

  it('12b/ recipe-less lines sell through with zero movements (pre-Phase-9 no-op)', async () => {
    const till = await setupTill();
    const created = await placeOrder(till.cashier.userId, till, [
      { menuItemId: itemDrink, quantity: 3 },
    ]);
    expect(created.items).toHaveLength(1);
    expect(await movementsFor(created.order.id)).toHaveLength(0);
  });

  it('12c/ restoration mirrors the RECORDED deduction, not the live recipe (recipe edited after the sale)', async () => {
    const till = await setupTill();
    const flour = await createComponent(till.branchId, 'دقيق', 'Flour', 'kg', '10.0000');
    await addMenuRecipe(itemMeal, flour, '1.0000');
    const created = await placeOrder(till.cashier.userId, till, [
      { menuItemId: itemMeal, quantity: 2 },
    ]);
    expect(await stockOf(flour)).toBe('8.0000');

    // The recipe changes AFTER the sale (chef re-portions to 9 kg per unit).
    await owner.query('UPDATE menu_item_recipes SET quantity_required = $1 WHERE tenant_id = $2 AND menu_item_id = $3', ['9.0000', T, itemMeal]);

    await voids.voidOrderItem(T, { userId: voidServerUser.userId, tokenSecV: voidServerUser.tokenSecV }, {
      orderItemId: row([...created.items]).item.id, voidReasonId: reasonServer,
    });

    // Restores the recorded 2.0000 — NOT 18.0000 from the live recipe.
    expect(await stockOf(flour)).toBe('10.0000');
    const movements = await movementsFor(created.order.id);
    expect(movements.map((m) => [m.movement_type, m.quantity_delta])).toEqual([
      ['sale_deduction', '-2.0000'],
      ['void_restoration', '2.0000'],
    ]);
  });

  // ── Case 13: central reporting ───────────────────────────────────────────

  it('13/ central reporting aggregates per-branch on-hand quantities (read-only, no new objects)', async () => {
    const tillA = await setupTill();
    const tillB = await setupTill();
    const flourA = await createComponent(tillA.branchId, 'دقيق', 'Flour', 'kg', '5.0000');
    const flourB = await createComponent(tillB.branchId, 'دقيق', 'Flour', 'kg', '7.0000');

    const report = await owner.query<{ branch_id: string; on_hand: string }>(
      'SELECT branch_id, sum(current_quantity)::text AS on_hand FROM inventory_items WHERE tenant_id = $1 AND id = ANY($2) GROUP BY branch_id ORDER BY on_hand',
      [T, [flourA, flourB]],
    );
    expect(report.rows).toEqual([
      { branch_id: tillA.branchId, on_hand: '5.0000' },
      { branch_id: tillB.branchId, on_hand: '7.0000' },
    ]);
  });

  // ── I1: mandatory coded adjustment reasons ───────────────────────────────

  it('I1a/ adjusting with an unknown reason is rejected and writes nothing', async () => {
    const till = await setupTill();
    const flour = await createComponent(till.branchId, 'دقيق', 'Flour', 'kg', '10.0000');
    const actor = { userId: adjustUser.userId, tokenSecV: adjustUser.tokenSecV };
    const movementsBefore = await countWhere('stock_movements', 'tenant_id = $1', [T]);

    const failure = await inventory.adjustStock(T, actor, {
      branchId: till.branchId, inventoryItemId: flour, quantityDeltaText: '-1.0000', adjustmentReasonId: randomUUID(),
    }).then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(AdjustmentReasonUnavailableError);

    expect(await countWhere('stock_movements', 'tenant_id = $1', [T])).toBe(movementsBefore);
    expect(await stockOf(flour)).toBe('10.0000');
  });

  it('I1b/ a disabled reason — or a disabled platform kind — cannot authorize an adjustment', async () => {
    const till = await setupTill();
    const flour = await createComponent(till.branchId, 'دقيق', 'Flour', 'kg', '10.0000');
    const actor = { userId: adjustUser.userId, tokenSecV: adjustUser.tokenSecV };
    const disabled = await createAdjustmentReason({ isEnabled: false });
    const failure = await inventory.adjustStock(T, actor, {
      branchId: till.branchId, inventoryItemId: flour, quantityDeltaText: '-1.0000', adjustmentReasonId: disabled,
    }).then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(AdjustmentReasonUnavailableError);

    // Disable the whole KIND for the tenant: a still-enabled reason of that
    // kind stops working too (disable-instead-of-delete, void mirror).
    const kinded = await createAdjustmentReason({ kindCode: 'shrinkage' });
    await withApp(T, (q) => q.query(
      `INSERT INTO tenant_adjustment_reason_kind_settings (tenant_id, adjustment_reason_kind_code, is_enabled)
       VALUES ($1, 'shrinkage', false) ON CONFLICT (tenant_id, adjustment_reason_kind_code)
       DO UPDATE SET is_enabled = false`,
      [T],
    ));
    try {
      const kindFailure = await inventory.adjustStock(T, actor, {
        branchId: till.branchId, inventoryItemId: flour, quantityDeltaText: '-1.0000', adjustmentReasonId: kinded,
      }).then(() => null, (error: unknown) => error);
      expect(kindFailure).toBeInstanceOf(AdjustmentReasonUnavailableError);
    } finally {
      await withApp(T, (q) => q.query(
        'UPDATE tenant_adjustment_reason_kind_settings SET is_enabled = true WHERE tenant_id = $1 AND adjustment_reason_kind_code = $2',
        [T, 'shrinkage'],
      ));
    }
    expect(await stockOf(flour)).toBe('10.0000');
  });

  it('I1c/ the happy path stamps the movement with the reason; a foreign-tenant reason is rejected', async () => {
    const till = await setupTill();
    const flour = await createComponent(till.branchId, 'دقيق', 'Flour', 'kg', '10.0000');
    const actor = { userId: adjustUser.userId, tokenSecV: adjustUser.tokenSecV };
    const reason = await createAdjustmentReason({ kindCode: 'expiry' });

    const movement = await inventory.adjustStock(T, actor, {
      branchId: till.branchId, inventoryItemId: flour, quantityDeltaText: '-2.0000', adjustmentReasonId: reason,
    });
    expect(movement.movementType).toBe('manual_adjustment');
    expect(movement.adjustmentReasonId).toBe(reason);
    expect(await stockOf(flour)).toBe('8.0000');

    // A reason of ANOTHER tenant is invisible (RLS) ⇒ unavailable.
    const foreign = await createAdjustmentReason({ tenantId: T2 });
    const failure = await inventory.adjustStock(T, actor, {
      branchId: till.branchId, inventoryItemId: flour, quantityDeltaText: '-1.0000', adjustmentReasonId: foreign,
    }).then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(AdjustmentReasonUnavailableError);
    expect(await stockOf(flour)).toBe('8.0000');
  });

  it('I1d/ the structure backstops the engine: manual rows demand a reason, all other rows forbid one', async () => {
    const till = await setupTill();
    const flour = await createComponent(till.branchId, 'دقيق', 'Flour', 'kg', '10.0000');
    const reason = await createAdjustmentReason();

    const missing = await withApp(T, (q) => q.query(
      `INSERT INTO stock_movements (tenant_id, branch_id, inventory_item_id, movement_type, quantity_delta, order_id, order_item_id, manager_override_id, adjustment_reason_id, actor_user_id, occurred_at)
       VALUES ($1, $2, $3, 'manual_adjustment', '-1.0000', NULL, NULL, NULL, NULL, $4, now())`,
      [T, till.branchId, flour, adjustUser.userId],
    )).then(() => null, (error: unknown) => error) as { code?: string; message?: string } | null;
    expect(missing?.code).toBe('23514');
    expect(missing?.message ?? '').toMatch(/reason/);

    const smuggled = await withApp(T, (q) => q.query(
      `INSERT INTO stock_movements (tenant_id, branch_id, inventory_item_id, movement_type, quantity_delta, order_id, order_item_id, manager_override_id, adjustment_reason_id, actor_user_id, occurred_at)
       VALUES ($1, $2, $3, 'manual_receiving', '1.0000', NULL, NULL, NULL, $4, $5, now())`,
      [T, till.branchId, flour, reason, receiverUser.userId],
    )).then(() => null, (error: unknown) => error) as { code?: string; message?: string } | null;
    expect(smuggled?.code).toBe('23514');
    expect(smuggled?.message ?? '').toMatch(/reason/);

    expect(await stockOf(flour)).toBe('10.0000');
  });

  // ── I3: low-stock crossings + branch mutes ───────────────────────────────

  it('I3a/ draining across the threshold emits exactly one event; deeper drains stay silent until recovery re-arms', async () => {
    const till = await setupTill();
    const flour = await createComponent(till.branchId, 'دقيق', 'Flour', 'kg', '10.0000');
    await setThreshold(flour, '5.0000');
    await addMenuRecipe(itemMeal, flour, '1.0000');
    try {
      // 10 → 4: crossing. Exactly one event, payload pinned.
      await placeOrder(till.cashier.userId, till, [{ menuItemId: itemMeal, quantity: 6 }]);
      expect(await stockOf(flour)).toBe('4.0000');
      const first = await inventory.listInventoryEvents(T, till.branchId, 0, 10);
      expect(first).toHaveLength(1);
      expect(first[0]?.eventType).toBe('inventory.low_stock');
      expect(first[0]?.sequenceId).toBe(1);
      expect(first[0]?.payload).toEqual({
        inventory_item_id: flour,
        branch_id: till.branchId,
        low_stock_threshold: '5.0000',
        balance_before: '10.0000',
        balance_after: '4.0000',
      });
      const alerts = await inventory.listLowStockAlerts(T, till.branchId);
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toEqual({
        branchId: till.branchId,
        inventoryItemId: flour,
        name: { ar: 'دقيق', en: 'Flour' },
        baseUnit: 'kg',
        currentQuantity: '4.0000',
        lowStockThreshold: '5.0000',
      });

      // 4 → 3: already below. Edge, not level — still one event.
      await placeOrder(till.cashier.userId, till, [{ menuItemId: itemMeal, quantity: 1 }]);
      expect(await inventory.listInventoryEvents(T, till.branchId, 0, 10)).toHaveLength(1);

      // 3 → 13: recovery above the line re-arms, but emits nothing itself.
      await inventory.receiveStock(T, { userId: receiverUser.userId, tokenSecV: receiverUser.tokenSecV }, {
        branchId: till.branchId, inventoryItemId: flour, purchaseUnit: 'kg', quantityText: '10.00000000',
      });
      expect(await stockOf(flour)).toBe('13.0000');
      expect(await inventory.listLowStockAlerts(T, till.branchId)).toHaveLength(0);
      expect(await inventory.listInventoryEvents(T, till.branchId, 0, 10)).toHaveLength(1);

      // 13 → 4: second crossing, gapless second sequence — and the after-cursor pages honestly.
      await placeOrder(till.cashier.userId, till, [{ menuItemId: itemMeal, quantity: 9 }]);
      const both = await inventory.listInventoryEvents(T, till.branchId, 0, 10);
      expect(both).toHaveLength(2);
      expect(both[1]?.sequenceId).toBe(2);
      expect(both[1]?.payload).toMatchObject({ balance_before: '13.0000', balance_after: '4.0000' });
      const page = await inventory.listInventoryEvents(T, till.branchId, 1, 10);
      expect(page).toHaveLength(1);
      expect(page[0]?.sequenceId).toBe(2);
    } finally {
      await removeMenuRecipe(itemMeal, flour);
    }
  });

  it('I3b/ a component with no threshold never emits and never alerts', async () => {
    const till = await setupTill();
    const flour = await createComponent(till.branchId, 'دقيق', 'Flour', 'kg', '10.0000');
    await addMenuRecipe(itemMeal, flour, '1.0000');
    try {
      await placeOrder(till.cashier.userId, till, [{ menuItemId: itemMeal, quantity: 6 }]);
      expect(await stockOf(flour)).toBe('4.0000');
      expect(await inventory.listInventoryEvents(T, till.branchId, 0, 10)).toHaveLength(0);
      expect(await inventory.listLowStockAlerts(T, till.branchId)).toHaveLength(0);
    } finally {
      await removeMenuRecipe(itemMeal, flour);
    }
  });

  it('I3c/ muting hides a branch\u2019s alerts but never its history; muting is branch-scoped and adjust-gated', async () => {
    const tillA = await setupTill();
    const tillB = await setupTill();
    const flourA = await createComponent(tillA.branchId, 'دقيق', 'Flour', 'kg', '10.0000');
    const flourB = await createComponent(tillB.branchId, 'دقيق', 'Flour', 'kg', '10.0000');
    await setThreshold(flourA, '5.0000');
    await setThreshold(flourB, '5.0000');
    // One menu item = one recipe set (branch-scoped deduction still needs
    // EVERY recipe component at the sale branch), so each branch sells a
    // DIFFERENT item: itemMeal drains A, recipe-less itemDrink drains B.
    await addMenuRecipe(itemMeal, flourA, '1.0000');
    await addMenuRecipe(itemDrink, flourB, '1.0000');
    try {
      await placeOrder(tillA.cashier.userId, tillA, [{ menuItemId: itemMeal, quantity: 6 }]);
      await placeOrder(tillB.cashier.userId, tillB, [{ menuItemId: itemDrink, quantity: 6 }]);
      expect(await inventory.listLowStockAlerts(T, tillA.branchId)).toHaveLength(1);
      expect(await inventory.listLowStockAlerts(T, tillB.branchId)).toHaveLength(1);

      const adjustActor = { userId: adjustUser.userId, tokenSecV: adjustUser.tokenSecV };
      await inventory.muteLowStockAlerts(T, adjustActor, tillA.branchId);

      // Alerts: branch A silenced, branch B untouched (branch-scoped mute).
      expect(await inventory.listLowStockAlerts(T, tillA.branchId)).toHaveLength(0);
      expect(await inventory.listLowStockAlerts(T, tillB.branchId)).toHaveLength(1);
      // History: intact — the mute filters NOTHING from the outbox.
      expect(await inventory.listInventoryEvents(T, tillA.branchId, 0, 10)).toHaveLength(1);

      await inventory.unmuteLowStockAlerts(T, adjustActor, tillA.branchId);
      expect(await inventory.listLowStockAlerts(T, tillA.branchId)).toHaveLength(1);

      // Gates: muting hides shrinkage signals → inventory:adjust, real branches only.
      const keyless = await createPlainUser('1515');
      await expect(inventory.muteLowStockAlerts(T, { userId: keyless.userId, tokenSecV: keyless.tokenSecV }, tillA.branchId))
        .rejects.toBeInstanceOf(ForbiddenError);
      await expect(inventory.muteLowStockAlerts(T, adjustActor, randomUUID())).rejects.toBeInstanceOf(NotFoundError);
      await expect(inventory.unmuteLowStockAlerts(T, adjustActor, randomUUID())).rejects.toBeInstanceOf(NotFoundError);
    } finally {
      await removeMenuRecipe(itemMeal, flourA);
      await removeMenuRecipe(itemDrink, flourB);
      await inventory.unmuteLowStockAlerts(T, { userId: adjustUser.userId, tokenSecV: adjustUser.tokenSecV }, tillA.branchId);
    }
  });

  // ── I4: universal unit registry ──────────────────────────────────────────

  it('I4a/ universal same-kind pairs convert with no item row; an explicit item row wins on conflict', async () => {
    const till = await setupTill();
    const actor = { userId: receiverUser.userId, tokenSecV: receiverUser.tokenSecV };
    // 1 lb → kg, NO conversion row: 0.45359237 → banker → '0.4536'.
    const spice = await createComponent(till.branchId, 'بهار', 'Spice', 'kg', '0.0000');
    await inventory.receiveStock(T, actor, {
      branchId: till.branchId, inventoryItemId: spice, purchaseUnit: 'lb', quantityText: '1.00000000',
    });
    expect(await stockOf(spice)).toBe('0.4536');
    // 2500 g → kg: exact math → '2.5000'.
    const sugar = await createComponent(till.branchId, 'سكر', 'Sugar', 'kg', '0.0000');
    await inventory.receiveStock(T, actor, {
      branchId: till.branchId, inventoryItemId: sugar, purchaseUnit: 'g', quantityText: '2500.00000000',
    });
    expect(await stockOf(sugar)).toBe('2.5000');
    // 1 oz → g: exact seeded factor (28.34952313), banker at the quantity → '28.3495'.
    const salt = await createComponent(till.branchId, 'ملح', 'Salt', 'g', '0.0000');
    await inventory.receiveStock(T, actor, {
      branchId: till.branchId, inventoryItemId: salt, purchaseUnit: 'oz', quantityText: '1.00000000',
    });
    expect(await stockOf(salt)).toBe('28.3495');
    // 100 g → oz: non-terminating division, banker-derived factor 0.03527396 → '3.5274'.
    const saffron = await createComponent(till.branchId, 'زعفران', 'Saffron', 'oz', '0.0000');
    await inventory.receiveStock(T, actor, {
      branchId: till.branchId, inventoryItemId: saffron, purchaseUnit: 'g', quantityText: '100.00000000',
    });
    expect(await stockOf(saffron)).toBe('3.5274');
    // Precedence: an explicit kg→g item row of 999 beats the universal 1000.
    const odd = await createComponent(till.branchId, 'غريب', 'Odd', 'g', '0.0000');
    await addConversion(odd, 'kg', 'g', '999.00000000');
    await inventory.receiveStock(T, actor, {
      branchId: till.branchId, inventoryItemId: odd, purchaseUnit: 'kg', quantityText: '1.00000000',
    });
    expect(await stockOf(odd)).toBe('999.0000');
  });

  it('I4b/ cross-kind pairs and unknown units fail closed with the unchanged message', async () => {
    const till = await setupTill();
    const actor = { userId: receiverUser.userId, tokenSecV: receiverUser.tokenSecV };
    const milk = await createComponent(till.branchId, 'حليب', 'Milk', 'L', '0.0000');
    // kg→L: BOTH registered, kinds differ (mass vs volume) → rejected.
    const cross = await inventory.receiveStock(T, actor, {
      branchId: till.branchId, inventoryItemId: milk, purchaseUnit: 'kg', quantityText: '1.00000000',
    }).then(() => null, (error: unknown) => error);
    expect(cross).toBeInstanceOf(ValidationError);
    expect((cross as ValidationError).message).toBe(`No conversion from 'kg' to base unit 'L' for this component`);
    // 'sachet': no row, no registry entry → the same message shape.
    const unknown = await inventory.receiveStock(T, actor, {
      branchId: till.branchId, inventoryItemId: milk, purchaseUnit: 'sachet', quantityText: '1.00000000',
    }).then(() => null, (error: unknown) => error);
    expect(unknown).toBeInstanceOf(ValidationError);
    expect((unknown as ValidationError).message).toBe(`No conversion from 'sachet' to base unit 'L' for this component`);
    expect(await stockOf(milk)).toBe('0.0000');
  });

  it('I4c/ the registry seeds the audited 8-code vocabulary (and the app role can read it)', async () => {
    const rows = await withApp(T, (q) => q.query<{ code: string; kind: string; kind_base_unit: string; to_base_factor: string }>(
      'SELECT code, kind, kind_base_unit, to_base_factor::text AS to_base_factor FROM unit_registry ORDER BY code',
    ));
    expect(rows.rows).toEqual([
      { code: 'L', kind: 'volume', kind_base_unit: 'ml', to_base_factor: '1000.00000000' },
      { code: 'g', kind: 'mass', kind_base_unit: 'g', to_base_factor: '1.00000000' },
      { code: 'kg', kind: 'mass', kind_base_unit: 'g', to_base_factor: '1000.00000000' },
      { code: 'lb', kind: 'mass', kind_base_unit: 'g', to_base_factor: '453.59237000' },
      { code: 'mg', kind: 'mass', kind_base_unit: 'g', to_base_factor: '0.00100000' },
      { code: 'ml', kind: 'volume', kind_base_unit: 'ml', to_base_factor: '1.00000000' },
      { code: 'oz', kind: 'mass', kind_base_unit: 'g', to_base_factor: '28.34952313' },
      { code: 'piece', kind: 'count', kind_base_unit: 'piece', to_base_factor: '1.00000000' },
    ]);
    // Tenant-context writes are structurally rejected (guard mirror — the
    // SELECT-only grant and the guard trigger both speak 42501).
    const failure = await withApp(T, (q) => q.query(
      `INSERT INTO unit_registry (code, kind, kind_base_unit, to_base_factor) VALUES ('sachet', 'count', 'piece', 1)`,
    )).then(() => null, (error: unknown) => error) as { code?: string } | null;
    expect(failure?.code).toBe('42501');
  });

  it('I4d/ unit matching is case-insensitive (LOWER); outputs always use the canonical registry code', async () => {
    const till = await setupTill();
    const actor = { userId: receiverUser.userId, tokenSecV: receiverUser.tokenSecV };
    // Upper-base + lower-purchase: 'KG' base, 'kg' purchase → the same kg row, exact math.
    const flour = await createComponent(till.branchId, 'دقيق', 'Flour', 'KG', '0.0000');
    await inventory.receiveStock(T, actor, {
      branchId: till.branchId, inventoryItemId: flour, purchaseUnit: 'kg', quantityText: '2.50000000',
    });
    expect(await stockOf(flour)).toBe('2.5000');
    // Reverse: 'ML' base, 'ml' purchase → the ml row (NOT the L row): a
    // passthrough reads '1000.0000'; had it matched L (×1000) it would read a million.
    const juice = await createComponent(till.branchId, 'عصير', 'Juice', 'ML', '0.0000');
    await inventory.receiveStock(T, actor, {
      branchId: till.branchId, inventoryItemId: juice, purchaseUnit: 'ml', quantityText: '1000.00000000',
    });
    expect(await stockOf(juice)).toBe('1000.0000');
    // Lowercase 'l' matches canonical 'L' (volume): 2 L → ml = '2000.0000'.
    const milk = await createComponent(till.branchId, 'حليب', 'Milk', 'ml', '0.0000');
    await inventory.receiveStock(T, actor, {
      branchId: till.branchId, inventoryItemId: milk, purchaseUnit: 'l', quantityText: '2.00000000',
    });
    expect(await stockOf(milk)).toBe('2000.0000');
    // Canonical form in failure outputs: raw 'KG'/'ML' surface as 'kg'/'ml'.
    const cross = await inventory.receiveStock(T, actor, {
      branchId: till.branchId, inventoryItemId: juice, purchaseUnit: 'KG', quantityText: '1.00000000',
    }).then(() => null, (error: unknown) => error);
    expect(cross).toBeInstanceOf(ValidationError);
    expect((cross as ValidationError).message).toBe(`No conversion from 'kg' to base unit 'ml' for this component`);
    // Unknown units keep their raw form (no registry row ⇒ nothing canonical to map to).
    const unknown = await inventory.receiveStock(T, actor, {
      branchId: till.branchId, inventoryItemId: juice, purchaseUnit: 'SACHET', quantityText: '1.00000000',
    }).then(() => null, (error: unknown) => error);
    expect(unknown).toBeInstanceOf(ValidationError);
    expect((unknown as ValidationError).message).toBe(`No conversion from 'SACHET' to base unit 'ml' for this component`);
    // Structural invariant: LOWER(code) is collision-free across the registry.
    const collision = await withApp(T, (q) => q.query<{ codes: number; lowers: number }>(
      'SELECT count(*)::int AS codes, count(DISTINCT LOWER(code))::int AS lowers FROM unit_registry',
    ));
    expect(collision.rows[0]).toEqual({ codes: 8, lowers: 8 });
  });

  it('[AUTH-BR-01/02] a branch-only inventory:receive + inventory:adjust grant authorizes branch A and rejects branch B at the base permission gate', async () => {
    const tillA = await setupTill();
    const tillB = await setupTill();
    const itemA = await createComponent(tillA.branchId, 'دقيق', 'Flour', 'kg', '0.0000');
    const itemB = await createComponent(tillB.branchId, 'دقيق', 'Flour', 'kg', '0.0000');
    const reasonId = await createAdjustmentReason();
    const subject = await createBranchTieredUser(
      ['inventory:receive', 'inventory:adjust'],
      '',
      tillA.branchId,
    );
    const actor = { userId: subject.userId, tokenSecV: subject.tokenSecV };

    const receiveA = await inventory.receiveStock(T, actor, {
      branchId: tillA.branchId,
      inventoryItemId: itemA,
      purchaseUnit: 'kg',
      quantityText: '5.00000000',
    });
    console.log('[AUTH-BR-01] branch A actual=', receiveA.movementType);
    expect(receiveA.movementType).toBe('manual_receiving');

    const receiveB = await inventory.receiveStock(T, actor, {
      branchId: tillB.branchId,
      inventoryItemId: itemB,
      purchaseUnit: 'kg',
      quantityText: '5.00000000',
    }).then(() => null, (error: unknown) => error);
    console.log('[AUTH-BR-01] branch B actual=', `${(receiveB as Error).name}: ${(receiveB as Error).message}`);
    expect(receiveB).toBeInstanceOf(ForbiddenError);
    expect((receiveB as ForbiddenError).message).toContain('inventory:receive');

    const adjustA = await inventory.adjustStock(T, actor, {
      branchId: tillA.branchId,
      inventoryItemId: itemA,
      quantityDeltaText: '-1.0000',
      adjustmentReasonId: reasonId,
    });
    console.log('[AUTH-BR-02] branch A actual=', adjustA.movementType);
    expect(adjustA.movementType).toBe('manual_adjustment');

    const adjustB = await inventory.adjustStock(T, actor, {
      branchId: tillB.branchId,
      inventoryItemId: itemB,
      quantityDeltaText: '-1.0000',
      adjustmentReasonId: reasonId,
    }).then(() => null, (error: unknown) => error);
    console.log('[AUTH-BR-02] branch B actual=', `${(adjustB as Error).name}: ${(adjustB as Error).message}`);
    expect(adjustB).toBeInstanceOf(ForbiddenError);
    expect((adjustB as ForbiddenError).message).toContain('inventory:adjust');
  });
});
