/**
 * Phase 7 live acceptance — orders + KDS preparation-station engine.
 *
 * Everything below runs against a REAL PostgreSQL (RLS, triggers, FK RESTRICT,
 * transactional outbox). The first eleven tests are the spec's mandated list,
 * numbered and named; the remaining ones prove the four explicit design
 * additions (deterministic routing tie-break, claim-then-execute side-effect
 * idempotency, fail-closed workflow-state modification, live manager PIN
 * challenge) and the resilience contract (polling fallback, derived-status
 * write protection).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { KdsEventService } from '../../src/application/engines/kds/kds-event-service.ts';
import { SideEffectWorker } from '../../src/application/engines/kds/side-effect-worker.ts';
import { OrderCreationEngine } from '../../src/application/engines/orders/order-creation-engine.ts';
import { StationRoutingEngine } from '../../src/application/engines/orders/station-routing-engine.ts';
import { VoidModificationEngine } from '../../src/application/engines/orders/void-modification-engine.ts';
import { WorkflowAdminEngine } from '../../src/application/engines/orders/workflow-admin-engine.ts';
import { WorkflowTransitionEngine } from '../../src/application/engines/orders/workflow-transition-engine.ts';
import { PlatformTaxAdminEngine } from '../../src/application/engines/tax/platform-tax-admin-engine.ts';
import { AuthorizationEngine } from '../../src/application/engines/rbac/authorization-engine.ts';
import { CatalogEngine } from '../../src/application/engines/catalog/catalog-engine.ts';
import { deriveSecV } from '../../src/domain/contracts/sec-v.ts';
import type { TaxCategory } from '../../src/domain/contracts/tax.ts';
import type { OrderOutboxEvent, SideEffectType, TenantWorkflowState, VoidActor } from '../../src/domain/contracts/orders.ts';
import { createWithPlatformTaxContext } from '../../src/infrastructure/db/platform-tax-context.ts';
import { createWithTenantContext, type WithTenantContext } from '../../src/infrastructure/db/tenant-context.ts';
import { PostgresCatalogRepository } from '../../src/infrastructure/db/repositories/postgres-catalog-repository.ts';
import { PostgresManagerOverrideAuthenticator } from '../../src/infrastructure/db/repositories/postgres-manager-override-authenticator.ts';
import { PostgresOrdersStore } from '../../src/infrastructure/db/repositories/postgres-orders-store.ts';
import { PostgresPermissionReadRepository } from '../../src/infrastructure/db/repositories/postgres-permission-repository.ts';
import { PostgresPlatformTaxAdminRepository } from '../../src/infrastructure/db/repositories/postgres-platform-tax-admin-repository.ts';
import { PostgresTenantTaxAdminRepository } from '../../src/infrastructure/db/repositories/postgres-tenant-tax-admin-repository.ts';
import { KdsRealtimeClient, type KdsClientEvent } from '../../src/presentation/kds/kds-realtime-client.ts';
import { KdsRealtimeServer } from '../../src/presentation/kds/kds-realtime-server.ts';
import { hashPin } from '../../src/shared/auth/pin.ts';
import {
  ManagerOverrideAuthenticationError,
  ManagerOverrideRequiredError,
  NoMatchingRoutingRuleError,
  PaymentReversalRequiredError,
  VoidReasonUnavailableError,
  VoidTimeLimitExceededError,
  WorkflowStateInUseError,
  WorkflowTransitionError,
} from '../../src/shared/errors.ts';
import { sha256Hex } from '../../src/shared/crypto.ts';
import { currencyCode, money } from '../../src/shared/money.ts';
import { testDatabaseUrl } from '../support/database.ts';

const A = '11111111-1111-4111-8111-111111111111'; // main flow tenant
const B = '22222222-2222-4222-8222-222222222222'; // cross-tenant boundary
const C = '33333333-3333-4333-8333-333333333333'; // void-configuration mutation tenant
const D = '123e4567-e89b-4123-a456-426614174000'; // workflow-state mutation tenant
const PLATFORM_ACTOR = '71000000-0000-4000-8000-000000000005';
const PIN_PEPPER = Buffer.from(randomBytes(48));

function row<T>(rows: readonly T[]): T {
  const first = rows[0];
  if (first === undefined) throw new Error('Expected database row');
  return first;
}

function must<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) throw new Error(`Expected ${what}`);
  return value;
}

async function waitFor(predicate: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  expect(predicate()).toBe(true);
}

interface BranchFixture {
  readonly branchId: string;
  readonly stationGrill: string;
  readonly stationSalads: string;
  readonly itemGrill: string;
  readonly itemSalad: string;
  readonly itemNoRule: string;
}

interface TieredUser {
  readonly userId: string;
  readonly tokenSecV: string;
  readonly pin: string;
}

describe('Phase 7 live acceptance (orders + KDS)', () => {
  let owner: pg.Pool;
  let app: pg.Pool;
  let platformPool: pg.Pool;
  let withApp: WithTenantContext;
  let platform: PlatformTaxAdminEngine;
  let catalog: CatalogEngine;
  let permissionRead: PostgresPermissionReadRepository;
  let authorization: AuthorizationEngine;
  let store: PostgresOrdersStore;
  let creation: OrderCreationEngine;
  let routing: StationRoutingEngine;
  let transitions: WorkflowTransitionEngine;
  let workflowAdmin: WorkflowAdminEngine;
  let voids: VoidModificationEngine;
  let kdsEvents: KdsEventService;
  let saCategory: TaxCategory;
  const menuCategoryByTenant = new Map<string, string>();
  const workflowStatesByTenant = new Map<string, readonly TenantWorkflowState[]>();
  let fixture: BranchFixture;
  let serverUser: TieredUser;
  let managerUser: TieredUser;
  let reasonServer: string;
  let reasonManager: string;

  beforeAll(async () => {
    owner = new pg.Pool({ connectionString: testDatabaseUrl(), max: 5 });
    for (const file of ['001_app_login.sql', '002_app_login_rbac.sql', '004_app_login_phase4.sql', '005_app_login_catalog.sql', '006_phase6_tax.sql', '007_phase7_orders.sql']) {
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
    platform = new PlatformTaxAdminEngine(new PostgresPlatformTaxAdminRepository(createWithPlatformTaxContext(platformPool)));
    catalog = new CatalogEngine({ catalog: new PostgresCatalogRepository({ withTenantContext: withApp }), taxAssignments: new PostgresTenantTaxAdminRepository(withApp) });
    permissionRead = new PostgresPermissionReadRepository({ withTenantContext: withApp });
    authorization = new AuthorizationEngine({ read: permissionRead, hash: sha256Hex });
    store = new PostgresOrdersStore({ withTenantContext: withApp });
    creation = new OrderCreationEngine({ store });
    routing = new StationRoutingEngine({ store });
    transitions = new WorkflowTransitionEngine({ store });
    workflowAdmin = new WorkflowAdminEngine({ store });
    voids = new VoidModificationEngine({
      store,
      authorization,
      managerAuthenticator: new PostgresManagerOverrideAuthenticator({ withTenantContext: withApp, pepper: PIN_PEPPER }),
    });
    kdsEvents = new KdsEventService({ store });

    // Platform tax fixture: SA, per-line rounding, 15% exclusive VAT.
    await platform.configureJurisdiction(PLATFORM_ACTOR, 'SA', 'per_line', true);
    saCategory = await platform.createCategory(PLATFORM_ACTOR, {
      countryCode: 'SA', code: randomUUID(), kind: 'standard', taxFamily: 'vat', cascadePriority: 50,
      name: { en: 'Phase 7 fixture VAT' }, isActive: true,
    });
    await platform.createTaxRate(PLATFORM_ACTOR, { taxCategoryId: saCategory.id, rateBps: 1500, isPriceInclusiveDefault: false, effectiveFrom: '2020-01-01', effectiveTo: null });
    await owner.query("UPDATE tenants SET vat_registration_status = 'registered', vat_registration_number = 'phase7-vat' WHERE id = ANY($1::uuid[])", [[A, C, D]]);

    // Workflows: A full sequence + the "preparing – waiting for ingredient"
    // sub-state; B/C/D minimal sequences.
    await workflowAdmin.ensureWorkflow(A, [
      { kindCode: 'received', position: 10, label: { ar: 'مستلم' } },
      { kindCode: 'confirmed', position: 20, label: { ar: 'مؤكد' } },
      { kindCode: 'preparing', position: 30, label: { ar: 'قيد التحضير' } },
      { kindCode: 'ready', position: 40, label: { ar: 'جاهز' } },
      { kindCode: 'delivered', position: 50, label: { ar: 'تم التسليم' } },
      { kindCode: 'cancelled', position: 60, label: { ar: 'ملغي' } },
    ]);
    await workflowAdmin.addState(A, { kindCode: 'preparing', parentKindCode: 'preparing', position: 35, label: { ar: 'قيد التحضير - في انتظار مكوّن' } });
    for (const tenant of [B, C, D]) {
      await workflowAdmin.ensureWorkflow(tenant, [
        { kindCode: 'received', position: 10, label: { ar: 'مستلم' } },
        { kindCode: 'preparing', position: 20, label: { ar: 'قيد التحضير' } },
        { kindCode: 'ready', position: 30, label: { ar: 'جاهز' } },
        { kindCode: 'cancelled', position: 40, label: { ar: 'ملغي' } },
      ]);
    }
    for (const tenant of [A, B, C, D]) {
      workflowStatesByTenant.set(tenant, await workflowAdmin.listStates(tenant, false));
      const category = await catalog.createCategory(tenant, { name: { ar: `قائمة ${tenant}` } });
      menuCategoryByTenant.set(tenant, category.id);
    }
  });

  beforeEach(async () => {
    fixture = await setupBranch(A);
    serverUser = await createTieredUser(A, 'server');
    managerUser = await createTieredUser(A, 'manager');
    reasonServer = await createVoidReason(A, 'customer_request', 'server');
    reasonManager = await createVoidReason(A, 'fraud_suspected', 'manager');
  });

  afterAll(async () => {
    await app?.end();
    await platformPool?.end();
    await owner?.end();
  });

  // ── Fixtures ─────────────────────────────────────────────────────────────

  async function setupBranch(tenantId: string): Promise<BranchFixture> {
    const branchId = randomUUID();
    const stationGrill = randomUUID();
    const stationSalads = randomUUID();
    const menuCategoryId = menuCategoryByTenant.get(tenantId);
    if (menuCategoryId === undefined) throw new Error(`Missing menu category for tenant ${tenantId}`);
    const itemGrill = (await catalog.createItem(tenantId, {
      categoryId: menuCategoryId, name: { ar: 'شيش طاووق' }, basePrice: money(2500n, currencyCode('SAR')), taxRuleId: saCategory.id,
    })).id;
    const itemSalad = (await catalog.createItem(tenantId, {
      categoryId: menuCategoryId, name: { ar: 'سلطة' }, basePrice: money(1500n, currencyCode('SAR')), taxRuleId: saCategory.id,
    })).id;
    const itemNoRule = (await catalog.createItem(tenantId, {
      categoryId: menuCategoryId, name: { ar: 'عنصر بلا قاعدة' }, basePrice: money(900n, currencyCode('SAR')), taxRuleId: saCategory.id,
    })).id;
    await withApp(tenantId, async (q) => {
      await q.query("INSERT INTO branches (id, tenant_id, name, base_currency, timezone, country_code) VALUES ($1, $2, 'phase7-branch', 'SAR', 'Asia/Riyadh', 'SA')", [branchId, tenantId]);
      await q.query("INSERT INTO stations (id, tenant_id, branch_id, name) VALUES ($1, $2, $3, 'grill'), ($4, $2, $3, 'salads')", [stationGrill, tenantId, branchId, stationSalads]);
      await q.query('INSERT INTO station_routing_rules (id, tenant_id, branch_id, station_id, menu_item_id) VALUES ($1, $2, $3, $4, $5), ($6, $7, $8, $9, $10)', [
        randomUUID(), tenantId, branchId, stationGrill, itemGrill,
        randomUUID(), tenantId, branchId, stationSalads, itemSalad,
      ]);
    });
    return { branchId, stationGrill, stationSalads, itemGrill, itemSalad, itemNoRule };
  }

    async function createTieredUser(tenantId: string, tier: 'server' | 'supervisor' | 'manager', pin = String(1000 + Math.trunc(Math.random() * 9000))): Promise<TieredUser> {
    const userId = randomUUID();
    const roleId = randomUUID();
    const keys = tier === 'server'
      ? ['order:void']
      : tier === 'supervisor'
        ? ['order:void', 'order:void:shift_supervisor']
        : ['order:void', 'order:void:shift_supervisor', 'order:void:manager'];
    await withApp(tenantId, async (q) => {
      await q.query('INSERT INTO users (id, tenant_id, email, pin_hash) VALUES ($1, $2, $3, $4)', [userId, tenantId, `${userId}@example.test`, hashPin(PIN_PEPPER, tenantId, userId, pin)]);
      await q.query('INSERT INTO roles (id, tenant_id, name) VALUES ($1, $2, $3)', [roleId, tenantId, `void-${tier}-${roleId}`]);
      for (const key of keys) {
        await q.query('INSERT INTO role_permissions (tenant_id, role_id, permission_key) VALUES ($1, $2, $3)', [tenantId, roleId, key]);
      }
      await q.query("INSERT INTO user_roles (tenant_id, user_id, role_id, scope_type, scope_id) VALUES ($1, $2, $3, 'tenant', NULL)", [tenantId, userId, roleId]);
    });
    const tokenSecV = deriveSecV(await permissionRead.listActiveUserRoles(tenantId, userId), await permissionRead.getSecurityVersion(tenantId, userId), sha256Hex);
    return { userId, tokenSecV, pin };
  }

  async function createVoidReason(tenantId: string, kindCode: string, tier: 'server' | 'shift_supervisor' | 'manager'): Promise<string> {
    const id = randomUUID();
    await withApp(tenantId, (q) => q.query(
      'INSERT INTO tenant_void_reasons (id, tenant_id, void_reason_kind_code, label, required_permission_tier) VALUES ($1, $2, $3, $4, $5)',
      [id, tenantId, kindCode, `سبب ${id}`, tier],
    ));
    return id;
  }

  function state(tenantId: string, kindCode: string, opts: { sub?: boolean } = {}): TenantWorkflowState {
    const states = workflowStatesByTenant.get(tenantId);
    if (states === undefined) throw new Error(`No workflow states cached for ${tenantId}`);
    const match = states.find((s) => s.kindCode === kindCode && (opts.sub ? s.parentKindCode !== null : s.parentKindCode === null));
    if (match === undefined) throw new Error(`State ${kindCode}${opts.sub ? ' (sub)' : ''} not found for ${tenantId}`);
    return match;
  }

  async function newOrder(
    tenantId: string,
    f: BranchFixture,
    lines: readonly { menuItemId: string; quantity?: number }[],
    occurredAt = new Date(),
  ) {
    return creation.create(tenantId, {
      branchId: f.branchId,
      orderType: 'dine_in',
      salesChannelCode: 'dine_in',
      deliveryPlatformId: null,
      tableId: null,
      items: lines.map((l) => ({ menuItemId: l.menuItemId, quantity: l.quantity ?? 1 })),
      occurredAt,
    });
  }

  function actor(user: TieredUser): VoidActor {
    return { userId: user.userId, tokenSecV: user.tokenSecV };
  }

  // ── The spec's eleven mandated tests ─────────────────────────────────────

  it('#1 rejects a status transition outside the tenant enabled workflow sequence (fail-closed)', async () => {
    const created = await newOrder(A, fixture, [{ menuItemId: fixture.itemGrill }]);
    const item = created.items[0];
    if (item === undefined) throw new Error('Expected one order item');

    // (a) A state of ANOTHER tenant's workflow is invisible (RLS) → rejected.
    const foreignPreparing = state(B, 'preparing');
    await expect(transitions.transitionItem(A, { orderItemId: item.item.id, toWorkflowStateId: foreignPreparing.id }))
      .rejects.toBeInstanceOf(WorkflowTransitionError);

    // (b) A DISABLED state of the tenant's own workflow is not part of the
    //     effective sequence → rejected (engine + DB trigger).
    const confirmed = state(A, 'confirmed');
    await workflowAdmin.disableState(A, confirmed.id);
    try {
      await expect(transitions.transitionItem(A, { orderItemId: item.item.id, toWorkflowStateId: confirmed.id }))
        .rejects.toBeInstanceOf(WorkflowTransitionError);
      await expect(withApp(A, (q) => q.query(
        'INSERT INTO order_item_status_events (tenant_id, order_item_id, order_id, to_status_kind_id) VALUES ($1, $2, $3, $4)',
        [A, item.item.id, created.order.id, confirmed.id],
      ))).rejects.toMatchObject({ code: '23514' });
    } finally {
      await workflowAdmin.enableState(A, confirmed.id);
    }

    // (c) A BACKWARD move inside the tenant's sequence is rejected too.
    const preparing = state(A, 'preparing');
    await transitions.transitionItem(A, { orderItemId: item.item.id, toWorkflowStateId: preparing.id });
    await expect(transitions.transitionItem(A, { orderItemId: item.item.id, toWorkflowStateId: state(A, 'received').id }))
      .rejects.toBeInstanceOf(WorkflowTransitionError);
  });

  it('#2 derives the parent order status from the mix of item statuses (one waiting sub-state keeps the order preparing)', async () => {
    const created = await newOrder(A, fixture, [{ menuItemId: fixture.itemGrill }, { menuItemId: fixture.itemSalad }]);
    const [first, second] = created.items;
    if (first === undefined || second === undefined) throw new Error('Expected two order items');
    const received = state(A, 'received');
    const preparing = state(A, 'preparing');
    const waiting = state(A, 'preparing', { sub: true });
    const ready = state(A, 'ready');

    expect(created.order.currentStatusKindId).toBe(received.id);

    await transitions.transitionItem(A, { orderItemId: first.item.id, toWorkflowStateId: preparing.id });
    await transitions.transitionItem(A, { orderItemId: second.item.id, toWorkflowStateId: waiting.id });
    // One item preparing + one in the "waiting for ingredient" sub-state → the
    // parent order is STILL "preparing".
    expect((await store.run(A, (s) => s.loadOrder(A, created.order.id)))?.currentStatusKindId).toBe(preparing.id);

    await transitions.transitionItem(A, { orderItemId: first.item.id, toWorkflowStateId: ready.id });
    // One item ready + one still waiting → the order stays "preparing".
    expect((await store.run(A, (s) => s.loadOrder(A, created.order.id)))?.currentStatusKindId).toBe(preparing.id);

    // Ingredient arrived: sub-state → plain preparing → then ready.
    await transitions.transitionItem(A, { orderItemId: second.item.id, toWorkflowStateId: preparing.id });
    await transitions.transitionItem(A, { orderItemId: second.item.id, toWorkflowStateId: ready.id });
    const finalOrder = await store.run(A, (s) => s.loadOrder(A, created.order.id));
    expect(finalOrder?.currentStatusKindId).toBe(ready.id);
    expect(finalOrder?.closedAt).toBeNull();
  });

  it('#3 refuses order creation when any item has no matching station routing rule (fail-closed, atomic rollback)', async () => {
    await expect(newOrder(A, fixture, [{ menuItemId: fixture.itemGrill }, { menuItemId: fixture.itemNoRule }]))
      .rejects.toBeInstanceOf(NoMatchingRoutingRuleError);
    // NOTHING was written — no order, no item, no outbox row, no sequence row
    // (the whole creation transaction rolled back).
    const counts = await owner.query<{ orders: string; items: string; outbox: string; sequences: string }>(
      `SELECT (SELECT count(*) FROM orders WHERE branch_id = $1)::text AS orders,
              (SELECT count(*) FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE branch_id = $1))::text AS items,
              (SELECT count(*) FROM order_events_outbox WHERE branch_id = $1)::text AS outbox,
              (SELECT count(*) FROM order_event_sequences WHERE branch_id = $1)::text AS sequences`,
      [fixture.branchId],
    );
    expect(row(counts.rows)).toEqual({ orders: '0', items: '0', outbox: '0', sequences: '0' });
  });

  it('#4 recovers every missed event after a WebSocket drop via sequence_id replay (no loss, no gaps)', async () => {
    const created = await newOrder(A, fixture, [{ menuItemId: fixture.itemGrill }, { menuItemId: fixture.itemSalad }]);
    const [first, second] = created.items;
    if (first === undefined || second === undefined) throw new Error('Expected two order items');
    const preparing = state(A, 'preparing');
    const ready = state(A, 'ready');

    const server = new KdsRealtimeServer({
      readEvents: (tenantId, branchId, after, limit) => kdsEvents.readEvents(tenantId, branchId, after, limit),
      pollIntervalMs: 40,
    });
    const port = await server.start();
    const received: KdsClientEvent[] = [];
    const client = new KdsRealtimeClient({
      baseUrl: `http://127.0.0.1:${port}`,
      tenantId: A,
      branchId: fixture.branchId,
      onEvent: (event) => received.push(event),
      reconnectBaseDelayMs: 350,
      reconnectMaxDelayMs: 2_000,
      maxWebSocketRetries: 5,
    });
    try {
      client.start();
      await waitFor(() => received.length >= 2);
      expect(received.map((e) => e.sequenceId)).toEqual([1, 2]);

      // Simulate the network drop; the client auto-reconnects after backoff.
      client.forceDrop();
      // While disconnected, four transitions + two parent-order changes land.
      await transitions.transitionItem(A, { orderItemId: first.item.id, toWorkflowStateId: preparing.id });          // seq 3 + order→preparing seq 4
      await transitions.transitionItem(A, { orderItemId: second.item.id, toWorkflowStateId: preparing.id });         // seq 5
      await transitions.transitionItem(A, { orderItemId: first.item.id, toWorkflowStateId: ready.id });              // seq 6 (order still preparing)
      await transitions.transitionItem(A, { orderItemId: second.item.id, toWorkflowStateId: ready.id });             // seq 7 + order→ready seq 8

      await waitFor(() => received.length >= 8);
      expect(received.map((e) => e.sequenceId)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      expect(client.lastReceivedSequenceId).toBe(8);
      expect(client.currentState).toBe('streaming');

      // The outbox itself is a gapless 1..8 for this branch (invariant 14).
      const sequences = await owner.query<{ sequence_id: string }>(
        'SELECT sequence_id FROM order_events_outbox WHERE branch_id = $1 ORDER BY sequence_id',
        [fixture.branchId],
      );
      expect(sequences.rows.map((r) => Number(r.sequence_id))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    } finally {
      await client.stop();
      await server.stop();
    }
  });

  it('#5 refuses a void on a paid order with the explicit PaymentReversalRequiredError (fail-closed on every path)', async () => {
    const created = await newOrder(A, fixture, [{ menuItemId: fixture.itemGrill }]);
    const item = created.items[0];
    if (item === undefined) throw new Error('Expected one order item');
    await withApp(A, (q) => q.query("UPDATE orders SET payment_status = 'paid' WHERE id = $1", [created.order.id]));

    // (a) The ENGINE path raises the typed error.
    const rejection = await voids.voidOrderItem(A, actor(serverUser), { orderItemId: item.item.id, voidReasonId: reasonServer }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(rejection).toBeInstanceOf(PaymentReversalRequiredError);
    expect((rejection as PaymentReversalRequiredError).code).toBe('order.payment_reversal_required');
    expect((rejection as PaymentReversalRequiredError).message).toContain("payment_status='paid'");

    // (b) The DATABASE path rejects a direct order_voids INSERT whatever the
    //     caller claims — structural fail-closed, not just engine discipline.
    await expect(withApp(A, (q) => q.query(
      `INSERT INTO order_voids (tenant_id, order_id, order_item_id, actor_user_id, actor_permission_tier, void_reason_id,
                                required_manager_override, order_payment_status_at_void_time)
       VALUES ($1, $2, $3, $4, 'server', $5, false, 'open')`,
      [A, created.order.id, item.item.id, serverUser.userId, reasonServer],
    ))).rejects.toMatchObject({ code: '23514' }); // snapshot must equal the LIVE paid status
    await expect(withApp(A, (q) => q.query(
      `INSERT INTO order_voids (tenant_id, order_id, order_item_id, actor_user_id, actor_permission_tier, void_reason_id,
                                required_manager_override, order_payment_status_at_void_time)
       VALUES ($1, $2, $3, $4, 'server', $5, false, 'paid')`,
      [A, created.order.id, item.item.id, serverUser.userId, reasonServer],
    ))).rejects.toMatchObject({ code: '23514' }); // and a truthful 'paid' snapshot is refused outright

    // Nothing was written: no audit row, item still active.
    const after = await owner.query<{ voids: string; item_voided: boolean }>(
      'SELECT (SELECT count(*) FROM order_voids WHERE order_id = $1)::text AS voids, is_voided AS item_voided FROM order_items WHERE id = $2',
      [created.order.id, item.item.id],
    );
    expect(row(after.rows)).toEqual({ voids: '0', item_voided: false });
  });

  it('#6 accepts a void on an open order with server tier + a valid reason, and records the immutable audit row', async () => {
    const created = await newOrder(A, fixture, [{ menuItemId: fixture.itemGrill }, { menuItemId: fixture.itemSalad }]);
    const [first, second] = created.items;
    if (first === undefined || second === undefined) throw new Error('Expected two order items');

    const record = await voids.voidOrderItem(A, actor(serverUser), { orderItemId: first.item.id, voidReasonId: reasonServer });
    expect(record.actorPermissionTier).toBe('server');
    expect(record.requiredManagerOverride).toBe(false);
    expect(record.managerUserId).toBeNull();
    expect(record.overrideAuthenticatedAt).toBeNull();
    expect(record.orderPaymentStatusAtVoidTime).toBe('open');

    const stored = await owner.query<{ actor_tier: string; payment: string; item_voided: boolean; other_voided: boolean }>(
      `SELECT v.actor_permission_tier AS actor_tier, v.order_payment_status_at_void_time AS payment,
              (SELECT is_voided FROM order_items WHERE id = $2) AS item_voided,
              (SELECT is_voided FROM order_items WHERE id = $3) AS other_voided
         FROM order_voids v WHERE v.id = $1`,
      [record.id, first.item.id, second.item.id],
    );
    expect(row(stored.rows)).toEqual({ actor_tier: 'server', payment: 'open', item_voided: true, other_voided: false });
    // The remaining active item keeps the order at its current status.
    expect((await store.run(A, (s) => s.loadOrder(A, created.order.id)))?.currentStatusKindId).toBe(state(A, 'received').id);
  });

  it('#7 refuses a server-tier void without a manager override when the reason requires a higher tier (no silent bypass)', async () => {
    const created = await newOrder(A, fixture, [{ menuItemId: fixture.itemGrill }]);
    const item = created.items[0];
    if (item === undefined) throw new Error('Expected one order item');

    await expect(voids.voidOrderItem(A, actor(serverUser), { orderItemId: item.item.id, voidReasonId: reasonManager }))
      .rejects.toBeInstanceOf(ManagerOverrideRequiredError);
    const after = await owner.query<{ voids: string; item_voided: boolean }>(
      'SELECT (SELECT count(*) FROM order_voids WHERE order_id = $1)::text AS voids, is_voided AS item_voided FROM order_items WHERE id = $2',
      [created.order.id, item.item.id],
    );
    expect(row(after.rows)).toEqual({ voids: '0', item_voided: false });
  });

  it('#8 refuses a void after void_time_limit_minutes (counted from order_items.created_at) even with full permission', async () => {
    const fixtureC = await setupBranch(C);
    const manager = await createTieredUser(C, 'manager');
    const reason = await createVoidReason(C, 'customer_request', 'server');
    await withApp(C, (q) => q.query('INSERT INTO tenant_void_settings (tenant_id, void_time_limit_minutes) VALUES ($1, 5)', [C]));

    try {
      // Item created 10 minutes ago (created_at snapshot) → refused.
      const old = await newOrder(C, fixtureC, [{ menuItemId: fixtureC.itemGrill }], new Date(Date.now() - 10 * 60_000));
      const oldItem = old.items[0];
      if (oldItem === undefined) throw new Error('Expected one order item');
      await expect(voids.voidOrderItem(C, actor(manager), { orderItemId: oldItem.item.id, voidReasonId: reason }))
        .rejects.toBeInstanceOf(VoidTimeLimitExceededError);

      // A fresh order (item created now) is well inside the limit.
      const fresh = await newOrder(C, fixtureC, [{ menuItemId: fixtureC.itemGrill }]);
      const freshItem = fresh.items[0];
      if (freshItem === undefined) throw new Error('Expected one order item');
      await expect(voids.voidOrderItem(C, actor(manager), { orderItemId: freshItem.item.id, voidReasonId: reason })).resolves.toMatchObject({
        actorPermissionTier: 'manager',
        orderPaymentStatusAtVoidTime: 'open',
      });
    } finally {
      // Cleanup as the owner: the app role deliberately has no DELETE grant on
      // the settings table (a tenant clears the limit by UPDATE, not DELETE).
      await owner.query('DELETE FROM tenant_void_settings WHERE tenant_id = $1', [C]);
    }
  });

  it('#9 disabling a void reason kind keeps every historical record (disable instead of delete)', async () => {
    const fixtureC = await setupBranch(C);
    const server = await createTieredUser(C, 'server');
    const reasonUsed = await createVoidReason(C, 'delay', 'server');
    const reasonNew = await createVoidReason(C, 'delay', 'server');

    const created = await newOrder(C, fixtureC, [{ menuItemId: fixtureC.itemGrill }]);
    const item = created.items[0];
    if (item === undefined) throw new Error('Expected one order item');
    const record = await voids.voidOrderItem(C, actor(server), { orderItemId: item.item.id, voidReasonId: reasonUsed });
    expect(record.orderPaymentStatusAtVoidTime).toBe('open');

    // Disable the PLATFORM kind for this tenant (soft disable, never delete).
    await withApp(C, (q) => q.query(
      `INSERT INTO tenant_void_reason_kind_settings (tenant_id, void_reason_kind_code, is_enabled)
       VALUES ($1, 'delay', false) ON CONFLICT (tenant_id, void_reason_kind_code) DO UPDATE SET is_enabled = false`,
      [C],
    ));

    // History is fully intact and still joins to its reason.
    const history = await withApp(C, (q) => q.query<{ count: string; kind: string }>(
      `SELECT count(*)::text AS count, r.void_reason_kind_code AS kind
         FROM order_voids v JOIN tenant_void_reasons r ON r.id = v.void_reason_id
        WHERE v.tenant_id = $1 AND r.void_reason_kind_code = 'delay' GROUP BY r.void_reason_kind_code`,
      [C],
    ));
    expect(row(history.rows)).toEqual({ count: '1', kind: 'delay' });

    // NEW voids with a reason of the disabled kind are refused.
    const fresh = await newOrder(C, fixtureC, [{ menuItemId: fixtureC.itemGrill }]);
    const freshItem = fresh.items[0];
    if (freshItem === undefined) throw new Error('Expected one order item');
    await expect(voids.voidOrderItem(C, actor(server), { orderItemId: freshItem.item.id, voidReasonId: reasonNew }))
      .rejects.toBeInstanceOf(VoidReasonUnavailableError);

    // The platform kind itself cannot be deleted while tenant reasons reference it
    // (ON DELETE RESTRICT raises SQLSTATE 23001 restrict_violation).
    await expect(owner.query("DELETE FROM void_reason_kinds WHERE code = 'delay'")).rejects.toMatchObject({ code: '23001' });
  });

  it('#10 rejects tenant attempts to delete or modify platform order_status_kinds (permissions + guard trigger)', async () => {
    // (a) The application role has SELECT only: UPDATE/DELETE are permission
    //     errors on the GRANT level.
    await expect(withApp(A, (q) => q.query("UPDATE order_status_kinds SET name = '{\"ar\":\"اختراق\"}'::jsonb WHERE code = 'received'")))
      .rejects.toMatchObject({ code: '42501' });
    await expect(withApp(A, (q) => q.query("DELETE FROM order_status_kinds WHERE code = 'received'")))
      .rejects.toMatchObject({ code: '42501' });

    // (b) Even a privileged connection IN A TENANT CONTEXT is stopped by the
    //     platform guard trigger (dedicated connection; no GUC leakage). Each
    //     statement runs in its OWN transaction: the first rejection aborts
    //     the transaction, so sharing one would only ever test the abort.
    const tenantContextClient = new pg.Client({ connectionString: testDatabaseUrl() });
    await tenantContextClient.connect();
    try {
      for (const statement of [
        "UPDATE order_status_kinds SET behavior_flags = behavior_flags WHERE code = 'received'",
        "DELETE FROM order_status_kinds WHERE code = 'received'",
      ] as const) {
        await tenantContextClient.query('BEGIN');
        await tenantContextClient.query('SELECT set_config($1, $2, true)', ['app.current_tenant_id', A]);
        await expect(tenantContextClient.query(statement)).rejects.toMatchObject({ code: '42501' });
        await tenantContextClient.query('ROLLBACK');
      }
    } finally {
      await tenantContextClient.end();
    }

    // Reference data intact for every tenant.
    const kinds = await owner.query<{ code: string }>('SELECT code FROM order_status_kinds ORDER BY code');
    expect(kinds.rows.map((r) => r.code)).toEqual(
      ['cancelled', 'confirmed', 'delivered', 'out_for_delivery', 'preparing', 'ready', 'received', 'refunded'],
    );
  });

  it('#11 rejects direct UPDATE/DELETE on order_voids and order_item_status_events at the database level (immutable)', async () => {
    const created = await newOrder(A, fixture, [{ menuItemId: fixture.itemGrill }]);
    const item = created.items[0];
    if (item === undefined) throw new Error('Expected one order item');
    await transitions.transitionItem(A, { orderItemId: item.item.id, toWorkflowStateId: state(A, 'preparing').id });
    const record = await voids.voidOrderItem(A, actor(serverUser), { orderItemId: item.item.id, voidReasonId: reasonServer });
    const eventId = row((await owner.query<{ id: string }>('SELECT id FROM order_item_status_events WHERE order_item_id = $1 LIMIT 1', [item.item.id])).rows).id;

    // Application role: no UPDATE/DELETE grants at all.
    await expect(withApp(A, (q) => q.query('UPDATE order_voids SET notes = $1 WHERE id = $2', ['tamper', record.id])))
      .rejects.toMatchObject({ code: '42501' });
    await expect(withApp(A, (q) => q.query('DELETE FROM order_voids WHERE id = $1', [record.id])))
      .rejects.toMatchObject({ code: '42501' });
    await expect(withApp(A, (q) => q.query('UPDATE order_item_status_events SET to_status_kind_id = to_status_kind_id WHERE id = $1', [eventId])))
      .rejects.toMatchObject({ code: '42501' });
    await expect(withApp(A, (q) => q.query('DELETE FROM order_item_status_events WHERE id = $1', [eventId])))
      .rejects.toMatchObject({ code: '42501' });

    // Owner (superuser, RLS bypassed): the immutability TRIGGERS still fire.
    await expect(owner.query('UPDATE order_voids SET notes = $1 WHERE id = $2', ['tamper', record.id]))
      .rejects.toMatchObject({ code: '55006' });
    await expect(owner.query('DELETE FROM order_voids WHERE id = $1', [record.id]))
      .rejects.toMatchObject({ code: '55006' });
    await expect(owner.query('UPDATE order_item_status_events SET to_status_kind_id = to_status_kind_id WHERE id = $1', [eventId]))
      .rejects.toMatchObject({ code: '55006' });
    await expect(owner.query('DELETE FROM order_item_status_events WHERE id = $1', [eventId]))
      .rejects.toMatchObject({ code: '55006' });
  });

  // ── The four explicit design additions + resilience contract ────────────

  it('#12 side effects are exactly-once per external effect: a partial failure retries ONLY the failed half (claim-then-execute)', async () => {
    const created = await newOrder(A, fixture, [{ menuItemId: fixture.itemGrill }]);
    const item = created.items[0];
    if (item === undefined) throw new Error('Expected one order item');
    await transitions.transitionItem(A, { orderItemId: item.item.id, toWorkflowStateId: state(A, 'preparing').id });
    // Event seq 1: item → received (notifies_customer). Event seq 2: item →
    // preparing (fires_kitchen_ticket). Seq 3 is the order event (no flags).

    const calls: { type: string; sequenceId: number }[] = [];
    let notificationGatewayUp = false;
    const executor = {
      execute: async (event: OrderOutboxEvent, type: SideEffectType): Promise<void> => {
        calls.push({ type, sequenceId: event.sequenceId });
        if (type === 'customer_notification' && !notificationGatewayUp) {
          throw new Error('notification gateway down (simulated partial failure)');
        }
      },
    };
    const worker = new SideEffectWorker({ store, executor, stalePendingAfterMs: 0, batchSize: 100 });

    // Branch-scoped run (the Local Branch Gateway deployment shape): other
    // branches of the same tenant are not this worker's business.
    const firstRun = await worker.processPending(A, fixture.branchId);
    expect(firstRun).toEqual({ examined: 2, executed: 1, skippedAsSucceeded: 0, failed: 1 });

    notificationGatewayUp = true;
    const secondRun = await worker.processPending(A, fixture.branchId);
    expect(secondRun).toEqual({ examined: 2, executed: 1, skippedAsSucceeded: 1, failed: 0 });

    // EXACTLY-ONCE external effect: the ticket was printed ONCE (never
    // re-executed after its first success); the notification was attempted
    // twice but delivered exactly once (at-least-once delivery, exactly-once
    // SUCCESS).
    const ticketCalls = calls.filter((c) => c.type === 'kitchen_ticket_print');
    const notificationCalls = calls.filter((c) => c.type === 'customer_notification');
    expect(ticketCalls).toHaveLength(1);
    expect(notificationCalls).toHaveLength(2);

    const ledger = await owner.query<{ side_effect_type: string; status: string; attempt_count: number }>(
      `SELECT l.side_effect_type, l.status, l.attempt_count
         FROM side_effect_delivery_log l JOIN order_events_outbox e ON e.id = l.outbox_event_id
        WHERE e.branch_id = $1 ORDER BY l.side_effect_type`,
      [fixture.branchId],
    );
    expect(ledger.rows).toEqual([
      { side_effect_type: 'customer_notification', status: 'succeeded', attempt_count: 2 },
      { side_effect_type: 'kitchen_ticket_print', status: 'succeeded', attempt_count: 1 },
    ]);
  });

  it('#13 fail-closed workflow-state modification: delete rejected while referenced, disable and reorder always allowed', async () => {
    const fixtureD = await setupBranch(D);
    const created = await newOrder(D, fixtureD, [{ menuItemId: fixtureD.itemGrill }]);
    const item = created.items[0];
    if (item === undefined) throw new Error('Expected one order item');
    const preparing = state(D, 'preparing');
    const ready = state(D, 'ready');
    await transitions.transitionItem(D, { orderItemId: item.item.id, toWorkflowStateId: preparing.id });

    // HARD DELETE: rejected by the application pre-check…
    await expect(workflowAdmin.deleteState(D, preparing.id)).rejects.toBeInstanceOf(WorkflowStateInUseError);
    // …and structurally by the FK RESTRICT chain (even for the DB owner;
    // ON DELETE RESTRICT raises SQLSTATE 23001 restrict_violation).
    await expect(owner.query('DELETE FROM tenant_order_workflow_states WHERE id = $1', [preparing.id]))
      .rejects.toMatchObject({ code: '23001' });

    // SOFT DISABLE: always allowed — historical rows keep pointing at the
    // state, but no NEW transition may enter or leave it.
    await workflowAdmin.disableState(D, preparing.id);
    expect((await store.run(D, (s) => s.loadOrder(D, created.order.id)))?.currentStatusKindId).toBe(preparing.id);
    await expect(transitions.transitionItem(D, { orderItemId: item.item.id, toWorkflowStateId: ready.id }))
      .rejects.toBeInstanceOf(WorkflowTransitionError);

    // REORDER: always allowed — orders reference the state id, never the
    // position, so historical evidence is immune.
    await workflowAdmin.reorderState(D, ready.id, 15);
    expect((await store.run(D, (s) => s.loadOrder(D, created.order.id)))?.currentStatusKindId).toBe(preparing.id);
    const reordered = await workflowAdmin.listStates(D, false);
    expect(reordered.find((s) => s.id === ready.id)?.position).toBe(15);
  });

  it('#14 outbox sequence_id is gapless per branch and independent across branches (invariant 14)', async () => {
    const fixture2 = await setupBranch(A);
    const first = await newOrder(A, fixture, [{ menuItemId: fixture.itemGrill }, { menuItemId: fixture.itemSalad }]);
    const firstItem = must(first.items[0], 'first order item');
    const secondItem = must(first.items[1], 'second order item');
    await transitions.transitionItem(A, { orderItemId: firstItem.item.id, toWorkflowStateId: state(A, 'preparing').id });
    await transitions.transitionItem(A, { orderItemId: secondItem.item.id, toWorkflowStateId: state(A, 'preparing').id });
    const second = await newOrder(A, fixture, [{ menuItemId: fixture.itemGrill }]);
    await transitions.transitionItem(A, { orderItemId: must(second.items[0], 'order item').item.id, toWorkflowStateId: state(A, 'preparing').id });

    const branchSequences = await owner.query<{ sequence_id: string }>(
      'SELECT sequence_id FROM order_events_outbox WHERE branch_id = $1 ORDER BY sequence_id',
      [fixture.branchId],
    );
    const mainBranch = branchSequences.rows.map((r) => Number(r.sequence_id));
    // 2 items ×2 orders (4 item events) + 3 preparing transitions + 1 order
    // status change = 8 events, strictly 1..8 with no hole.
    expect(mainBranch).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);

    // A DIFFERENT branch restarts from 1 — per-branch counters never interleave.
    const otherBranch = await newOrder(A, fixture2, [{ menuItemId: fixture2.itemGrill }]);
    expect(otherBranch.items).toHaveLength(1);
    const otherSequences = await owner.query<{ sequence_id: string }>(
      'SELECT sequence_id FROM order_events_outbox WHERE branch_id = $1 ORDER BY sequence_id',
      [fixture2.branchId],
    );
    expect(otherSequences.rows.map((r) => Number(r.sequence_id))).toEqual([1]);
  });

  it('#15 manager override requires a LIVE PIN challenge: wrong PIN, empty PIN and a non-manager approver are all rejected; the valid challenge is recorded with its timestamp', async () => {
    const created = await newOrder(A, fixture, [{ menuItemId: fixture.itemGrill }, { menuItemId: fixture.itemSalad }]);
    const [first, second] = created.items;
    if (first === undefined || second === undefined) throw new Error('Expected two order items');
    const supervisor = await createTieredUser(A, 'supervisor');

    // Wrong PIN → rejected.
    await expect(voids.voidOrderItem(A, actor(serverUser), {
      orderItemId: first.item.id, voidReasonId: reasonManager,
      managerOverride: { managerUserId: managerUser.userId, managerOverridePin: '0000' },
    })).rejects.toBeInstanceOf(ManagerOverrideAuthenticationError);

    // A name without the PIN challenge → rejected (never a list pick).
    await expect(voids.voidOrderItem(A, actor(serverUser), {
      orderItemId: first.item.id, voidReasonId: reasonManager,
      managerOverride: { managerUserId: managerUser.userId, managerOverridePin: '' },
    })).rejects.toBeInstanceOf(ManagerOverrideAuthenticationError);

    // An approver who does NOT hold order:void:manager → rejected.
    await expect(voids.voidOrderItem(A, actor(serverUser), {
      orderItemId: first.item.id, voidReasonId: reasonManager,
      managerOverride: { managerUserId: supervisor.userId, managerOverridePin: supervisor.pin },
    })).rejects.toBeInstanceOf(ManagerOverrideAuthenticationError);

    // The valid live challenge → voided, with the authentication proof.
    const before = Date.now();
    const record = await voids.voidOrderItem(A, actor(serverUser), {
      orderItemId: first.item.id, voidReasonId: reasonManager,
      managerOverride: { managerUserId: managerUser.userId, managerOverridePin: managerUser.pin },
    });
    expect(record.requiredManagerOverride).toBe(true);
    expect(record.managerUserId).toBe(managerUser.userId);
    expect(record.overrideAuthenticatedAt).not.toBeNull();
    const authenticatedAt = record.overrideAuthenticatedAt;
    if (authenticatedAt === null) throw new Error('Expected authentication timestamp');
    expect(authenticatedAt.getTime()).toBeGreaterThanOrEqual(before - 1_000);
    expect(authenticatedAt.getTime()).toBeLessThanOrEqual(Date.now() + 1_000);

    // The audit row keeps both the identity and the proof; the PIN is nowhere.
    const stored = await owner.query<{ manager_user_id: string | null; override_authenticated_at: Date | null }>(
      'SELECT manager_user_id, override_authenticated_at FROM order_voids WHERE id = $1',
      [record.id],
    );
    expect(row(stored.rows)).toEqual({ manager_user_id: managerUser.userId, override_authenticated_at: authenticatedAt });
  });

  it('#16 falls back to short polling when WebSocket is completely unavailable (no event loss)', async () => {
    const created = await newOrder(A, fixture, [{ menuItemId: fixture.itemGrill }]);
    const item = created.items[0];
    if (item === undefined) throw new Error('Expected one order item');

    const server = new KdsRealtimeServer({
      readEvents: (tenantId, branchId, after, limit) => kdsEvents.readEvents(tenantId, branchId, after, limit),
      disableWebSocket: true,
    });
    const port = await server.start();
    const received: KdsClientEvent[] = [];
    const client = new KdsRealtimeClient({
      baseUrl: `http://127.0.0.1:${port}`,
      tenantId: A,
      branchId: fixture.branchId,
      onEvent: (event) => received.push(event),
      maxWebSocketRetries: 1,
      reconnectBaseDelayMs: 20,
      pollIntervalMs: 50,
    });
    try {
      client.start();
      await waitFor(() => received.length >= 1 && client.currentState === 'polling');
      expect(received.map((e) => e.sequenceId)).toEqual([1]);

      // New events still arrive through the polling fallback.
      await transitions.transitionItem(A, { orderItemId: item.item.id, toWorkflowStateId: state(A, 'preparing').id });
      await waitFor(() => received.length >= 3);
      expect(received.map((e) => e.sequenceId)).toEqual([1, 2, 3]);
      expect(client.lastReceivedSequenceId).toBe(3);
    } finally {
      await client.stop();
      await server.stop();
    }
  });

  it('#17 rejects direct writes to the derived order status and to the resolved station (invariants 3 and 4)', async () => {
    const created = await newOrder(A, fixture, [{ menuItemId: fixture.itemGrill }]);
    const item = created.items[0];
    if (item === undefined) throw new Error('Expected one order item');
    const preparing = state(A, 'preparing');

    await expect(withApp(A, (q) => q.query('UPDATE orders SET current_status_kind_id = $1 WHERE id = $2', [preparing.id, created.order.id])))
      .rejects.toMatchObject({ code: '42501' });
    await expect(withApp(A, (q) => q.query('UPDATE order_items SET current_status_kind_id = $1 WHERE id = $2', [preparing.id, item.item.id])))
      .rejects.toMatchObject({ code: '42501' });
    // A real re-routing attempt (a different station) — the guard only needs
    // to catch actual changes; a no-op write of the same value is harmless.
    await expect(withApp(A, (q) => q.query('UPDATE order_items SET station_id = $1 WHERE id = $2', [fixture.stationSalads, item.item.id])))
      .rejects.toMatchObject({ code: '42501' });
    // Even the schema owner cannot write the derived status outside the
    // guarded recompute path (the trigger has no role bypass).
    await expect(owner.query('UPDATE orders SET current_status_kind_id = $1 WHERE id = $2', [preparing.id, created.order.id]))
      .rejects.toMatchObject({ code: '42501' });
  });

  it('#18 deterministic routing tie-break: specificity → priority_weight → rule_id (always exactly one reproducible winner)', async () => {
    const stationA = randomUUID();
    const stationB = randomUUID();
    const stationDom = randomUUID();
    const menuCategoryId = menuCategoryByTenant.get(A);
    if (menuCategoryId === undefined) throw new Error('Missing menu category');
    const itemTie = (await catalog.createItem(A, {
      categoryId: menuCategoryId, name: { ar: 'عنصر التعادل' }, basePrice: money(1200n, currencyCode('SAR')), taxRuleId: saCategory.id,
    })).id;

    await withApp(A, async (q) => {
      await q.query('INSERT INTO stations (id, tenant_id, branch_id, name) VALUES ($1, $2, $3, $4), ($5, $2, $3, $6), ($7, $2, $3, $8)', [
        stationA, A, fixture.branchId, 'tie-a',
        stationB, 'tie-b',
        stationDom, 'tie-dom',
      ]);
      // Two rules with IDENTICAL criteria (a true specificity tie, 120 each).
      await q.query(`INSERT INTO station_routing_rules (id, tenant_id, branch_id, station_id, menu_item_id, sales_channel_code, priority_weight)
                     VALUES ($1, $2, $3, $4, $5, 'dine_in', 5), ($6, $2, $3, $7, $5, 'dine_in', 0)`, [
        randomUUID(), A, fixture.branchId, stationA, itemTie,
        randomUUID(), stationB,
      ]);
      // A LOWER-specificity rule (item + order_type = 110) that must never win.
      await q.query(`INSERT INTO station_routing_rules (id, tenant_id, branch_id, station_id, menu_item_id, order_type)
                     VALUES ($1, $2, $3, $4, $5, 'dine_in')`, [randomUUID(), A, fixture.branchId, stationDom, itemTie]);
    });

    const context = { menuItemId: itemTie, salesChannelCode: 'dine_in', orderType: 'dine_in' as const };
    // (a) priority_weight breaks the specificity tie (explicit tenant control).
    const first = await routing.route(A, fixture.branchId, context);
    expect(first.stationId).toBe(stationA);
    expect(first.specificityScore).toBe(120);
    expect(first.priorityWeight).toBe(5);

    // (b) Equal weights → rule_id ASC is the final deterministic tie-break.
    await withApp(A, (q) => q.query(
      'UPDATE station_routing_rules SET priority_weight = 0 WHERE branch_id = $1 AND menu_item_id = $2',
      [fixture.branchId, itemTie],
    ));
    const tieRules = await owner.query<{ id: string; station_id: string }>(
      'SELECT id, station_id FROM station_routing_rules WHERE branch_id = $1 AND menu_item_id = $2 AND sales_channel_code = $3 ORDER BY id ASC',
      [fixture.branchId, itemTie, 'dine_in'],
    );
    const expectedWinner = tieRules.rows[0];
    if (expectedWinner === undefined) throw new Error('Expected tie rules');
    const second = await routing.route(A, fixture.branchId, context);
    expect(second.stationId).toBe(expectedWinner.station_id);
    expect(second.ruleId).toBe(expectedWinner.id);
  });
});
