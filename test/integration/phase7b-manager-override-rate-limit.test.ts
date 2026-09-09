/**
 * Phase 7 SECURITY PATCH — manager-override challenge rate limiting.
 *
 * The eight mandated invariants, run against a REAL PostgreSQL (RLS, FOR
 * UPDATE row locks, triggers, the permanent attempt ledger, the Phase 4
 * audit_log), plus one end-to-end wiring proof that the void engine binds the
 * challenge to the INITIATING ACTOR's identity.
 *
 *   #1  4 failures on one manager → the 5th attempt may still succeed.
 *   #2  5 consecutive failures → the 6th is refused with 429 EVEN WITH the
 *       correct PIN, audited as rejected_locked, not re-counted, not extended.
 *   #3  T success resets ONLY the target manager's counter.
 *   #4  One employee guessing across 10 DIFFERENT managers (no manager reaches
 *       its own threshold) locks the EMPLOYEE for 30 minutes and writes the
 *       mandatory high-severity security event to audit_log.
 *   #5  T success on manager T does NOT reset the actor cross-manager counter.
 *   #6  An expired 15-minute window restarts the count (renewing window).
 *   #7  Two concurrent challenges at the threshold moment: FOR UPDATE
 *       serializes them — exactly one activates the lock, no overrun.
 *   #8  The client error is byte-identical between a manager lock and an
 *       actor lock (same text, same code, same HTTP status — anti-oracle).
 *   #9  ENGINE WIRING: a failed override through voidOrderItem records the
 *       SERVER (the initiating actor) and the order link on the ledger.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OrderCreationEngine } from '../../src/application/engines/orders/order-creation-engine.ts';
import { VoidModificationEngine } from '../../src/application/engines/orders/void-modification-engine.ts';
import { WorkflowAdminEngine } from '../../src/application/engines/orders/workflow-admin-engine.ts';
import { PlatformTaxAdminEngine } from '../../src/application/engines/tax/platform-tax-admin-engine.ts';
import { AuthorizationEngine } from '../../src/application/engines/rbac/authorization-engine.ts';
import { CatalogEngine } from '../../src/application/engines/catalog/catalog-engine.ts';
import { deriveSecV } from '../../src/domain/contracts/sec-v.ts';
import type { TaxCategory } from '../../src/domain/contracts/tax.ts';
import type { VoidActor } from '../../src/domain/contracts/orders.ts';
import { createWithPlatformTaxContext } from '../../src/infrastructure/db/platform-tax-context.ts';
import { createWithTenantContext, type WithTenantContext } from '../../src/infrastructure/db/tenant-context.ts';
import { PostgresCatalogRepository } from '../../src/infrastructure/db/repositories/postgres-catalog-repository.ts';
import { PostgresManagerOverrideAuthenticator } from '../../src/infrastructure/db/repositories/postgres-manager-override-authenticator.ts';
import { PostgresOrdersStore } from '../../src/infrastructure/db/repositories/postgres-orders-store.ts';
import { PostgresShiftsStore } from '../../src/infrastructure/db/repositories/postgres-shifts-store.ts';
import { ShiftEngine } from '../../src/application/engines/shifts/shift-engine.ts';
import { PostgresPermissionReadRepository, PostgresPermissionWriteRepository } from '../../src/infrastructure/db/repositories/postgres-permission-repository.ts';
import { PostgresPlatformTaxAdminRepository } from '../../src/infrastructure/db/repositories/postgres-platform-tax-admin-repository.ts';
import { PostgresTenantTaxAdminRepository } from '../../src/infrastructure/db/repositories/postgres-tenant-tax-admin-repository.ts';
import { hashPin } from '../../src/shared/auth/pin.ts';
import {
  ManagerOverrideAuthenticationError,
  ManagerOverrideRateLimitedError,
  toErrorResponse,
} from '../../src/shared/errors.ts';
import { sha256Hex } from '../../src/shared/crypto.ts';
import { currencyCode, money } from '../../src/shared/money.ts';
import { testDatabaseUrl } from '../support/database.ts';
import { grantKeys } from '../support/grant-keys.ts';

// T: a DEDICATED tenant created in beforeAll. The integration project shares
// one database between test files and vitest's file order is not guaranteed,
// so this file must never touch tenant A's workflow/catalog state that
// phase7-orders.test.ts depends on.
const PLATFORM_ACTOR = '71000000-0000-4000-8000-000000000005';
let T: string; // dedicated rate-limiting tenant (fresh per run)
const PIN_PEPPER = Buffer.from(randomBytes(48));
const RATE_LIMITED_MESSAGE = 'لقد تجاوزت الحد المسموح من المحاولات. حاول لاحقًا.';

function row<T>(rows: readonly T[]): T {
  const first = rows[0];
  if (first === undefined) throw new Error('Expected database row');
  return first;
}

function must<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) throw new Error(`Expected ${what}`);
  return value;
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the challenge to be rejected');
}

interface LockoutRow {
  readonly consecutive_failures: number;
  readonly window_started_at: Date | null;
  readonly locked_until: Date | null;
}

interface SecurityEventAfter {
  readonly severity?: unknown;
  readonly actor_id?: unknown;
  readonly attempt_count?: unknown;
  readonly distinct_managers_tried?: unknown;
  readonly lock_duration_minutes?: unknown;
}

interface TieredUser {
  readonly userId: string;
  readonly tokenSecV: string;
  readonly pin: string;
}

describe('Phase 7 security patch: manager-override challenge rate limiting', () => {
  let owner: pg.Pool;
  let app: pg.Pool;
  let platformPool: pg.Pool;
  let withApp: WithTenantContext;
  let catalog: CatalogEngine;
  let permissionRead: PostgresPermissionReadRepository;
  let store: PostgresOrdersStore;
  let creation: OrderCreationEngine;
  let shifts: ShiftEngine;
  let shiftCashierId: string;
  let shiftOpenerId: string;
  let shiftVerifierId: string;
  let voids: VoidModificationEngine;
  let authenticator: PostgresManagerOverrideAuthenticator;
  let saCategory: TaxCategory;
  let menuCategoryId: string;
  let branchId: string;
  let itemId: string;
  let serverUser: TieredUser;

  beforeAll(async () => {
    owner = new pg.Pool({ connectionString: testDatabaseUrl(), max: 5 });
    T = randomUUID();
    await owner.query('INSERT INTO tenants (id, name) VALUES ($1, $2)', [T, 'phase7b-rate-limit']);
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
    catalog = new CatalogEngine({ catalog: new PostgresCatalogRepository({ withTenantContext: withApp }), taxAssignments: new PostgresTenantTaxAdminRepository(withApp), authorization: new AuthorizationEngine({ read: permissionRead, hash: sha256Hex }) });
    store = new PostgresOrdersStore({ withTenantContext: withApp });
    creation = new OrderCreationEngine({
      store,
      authorization: new AuthorizationEngine({ read: permissionRead, hash: sha256Hex }),
      managerAuthenticator: new PostgresManagerOverrideAuthenticator({ withTenantContext: withApp, pepper: PIN_PEPPER }),
    });
    shifts = new ShiftEngine({ store: new PostgresShiftsStore({ withTenantContext: withApp }), authorization: new AuthorizationEngine({ read: permissionRead, hash: sha256Hex }) });
    authenticator = new PostgresManagerOverrideAuthenticator({ withTenantContext: withApp, pepper: PIN_PEPPER });
    voids = new VoidModificationEngine({
      store,
      authorization: new AuthorizationEngine({ read: permissionRead, hash: sha256Hex }),
      managerAuthenticator: authenticator,
    });

    // Platform tax fixture (needed only so order creation can price a line).
    const platform = new PlatformTaxAdminEngine(new PostgresPlatformTaxAdminRepository(createWithPlatformTaxContext(platformPool)));
    await platform.configureJurisdiction(PLATFORM_ACTOR, 'SA', 'per_line', true);
    saCategory = await platform.createCategory(PLATFORM_ACTOR, {
      countryCode: 'SA', code: randomUUID(), kind: 'standard', taxFamily: 'vat', cascadePriority: 50,
      name: { en: 'Rate-limit fixture VAT' }, isActive: true,
    });
    await platform.createTaxRate(PLATFORM_ACTOR, { taxCategoryId: saCategory.id, rateBps: 1500, isPriceInclusiveDefault: false, effectiveFrom: '2020-01-01', effectiveTo: null });
    await owner.query("UPDATE tenants SET vat_registration_status = 'registered', vat_registration_number = 'rate-limit-vat' WHERE id = $1", [T]);

    // T minimal workflow is all order creation needs (initial state). The
    // integration project shares one database between files, so tenant T may
    // already have its workflow from phase7-orders.test.ts — reuse it.
    const workflowAdmin = new WorkflowAdminEngine({ store, authorization: new AuthorizationEngine({ read: permissionRead, hash: sha256Hex }) });
    if ((await workflowAdmin.listStates(T, false)).length === 0) {
      await workflowAdmin.ensureWorkflow(T, [
        { kindCode: 'received', position: 10, label: { ar: 'مستلم' } },
        { kindCode: 'confirmed', position: 20, label: { ar: 'مؤكد' } },
        { kindCode: 'preparing', position: 30, label: { ar: 'قيد التحضير' } },
        { kindCode: 'ready', position: 40, label: { ar: 'جاهز' } },
        { kindCode: 'delivered', position: 50, label: { ar: 'تم التسليم' } },
        { kindCode: 'cancelled', position: 60, label: { ar: 'ملغي' } },
      ]);
    }
    // Phase-8 gateway identities: two DISTINCT people for the dual verification.
    // (B7: the opener carries shift:open + catalog:write.)
    shiftOpenerId = await createUserWithPin('1111');
    shiftVerifierId = await createUserWithPin('2222');
    const permWrite = new PostgresPermissionWriteRepository({ withTenantContext: withApp });
    await grantKeys(permWrite, T, shiftOpenerId, ['shift:open', 'catalog:write']);
    menuCategoryId = (await catalog.createCategory(T, shiftOpenerId, { name: { ar: 'قائمة الرقعة الأمنية' } })).id;
  });

  beforeEach(async () => {
    // Fresh branch + item + SERVER per test: every lockout row is keyed by
    // fresh user ids, so counters always start at zero.
    branchId = randomUUID();
    const stationId = randomUUID();
    itemId = (await catalog.createItem(T, shiftOpenerId, {
      categoryId: menuCategoryId, name: { ar: 'طبق فحص القفل' }, basePrice: money(1800n, currencyCode('SAR')), taxRuleId: saCategory.id,
    })).id;
    await withApp(T, async (q) => {
      await q.query("INSERT INTO branches (id, tenant_id, name, base_currency, timezone, country_code) VALUES ($1, $2, 'rate-limit-branch', 'SAR', 'Asia/Riyadh', 'SA')", [branchId, T]);
      await q.query('INSERT INTO stations (id, tenant_id, branch_id, name) VALUES ($1, $2, $3, $4)', [stationId, T, branchId, 'main']);
      await q.query('INSERT INTO station_routing_rules (id, tenant_id, branch_id, station_id, menu_item_id) VALUES ($1, $2, $3, $4, $5)', [randomUUID(), T, branchId, stationId, itemId]);
    });
    // Phase-8 shift gateway: the creating cashier holds the standing OPEN
    // shift at this fresh branch (zero float, dual-verified).
    const cashierId = await createUserWithPin('3333');
    await shifts.openShift(T, {
      branchId,
      cashierUserId: cashierId,
      openedByUserId: shiftOpenerId,
      openVerifiedByUserId: shiftVerifierId,
      openedAt: new Date(),
      openCounts: [],
    });
    shiftCashierId = cashierId;
    serverUser = await createTieredUser('server');
  });

  afterAll(async () => {
    await app?.end();
    await platformPool?.end();
    await owner?.end();
  });

  // ── Fixtures ─────────────────────────────────────────────────────────────

  async function createUserWithPin(pin: string): Promise<string> {
    const userId = randomUUID();
    await withApp(T, (q) => q.query(
      'INSERT INTO users (id, tenant_id, email, pin_hash) VALUES ($1, $2, $3, $4)',
      [userId, T, `${userId}@example.test`, hashPin(PIN_PEPPER, T, userId, pin)],
    ));
    return userId;
  }

  async function createTieredUser(tier: 'server' | 'manager', pin = String(1000 + Math.trunc(Math.random() * 9000))): Promise<TieredUser> {
    const userId = randomUUID();
    const roleId = randomUUID();
    const keys = tier === 'server' ? ['order:void'] : ['order:void', 'order:void:shift_supervisor', 'order:void:manager'];
    await withApp(T, async (q) => {
      await q.query('INSERT INTO users (id, tenant_id, email, pin_hash) VALUES ($1, $2, $3, $4)', [userId, T, `${userId}@example.test`, hashPin(PIN_PEPPER, T, userId, pin)]);
      await q.query('INSERT INTO roles (id, tenant_id, name) VALUES ($1, $2, $3)', [roleId, T, `rl-${tier}-${roleId}`]);
      for (const key of keys) {
        await q.query('INSERT INTO role_permissions (tenant_id, role_id, permission_key) VALUES ($1, $2, $3)', [T, roleId, key]);
      }
      await q.query("INSERT INTO user_roles (tenant_id, user_id, role_id, scope_type, scope_id) VALUES ($1, $2, $3, 'tenant', NULL)", [T, userId, roleId]);
    });
    const tokenSecV = deriveSecV(await permissionRead.listActiveUserRoles(T, userId), await permissionRead.getSecurityVersion(T, userId), sha256Hex);
    return { userId, tokenSecV, pin };
  }

  async function createManagerTierReason(): Promise<string> {
    const id = randomUUID();
    await withApp(T, (q) => q.query(
      'INSERT INTO tenant_void_reasons (id, tenant_id, void_reason_kind_code, label, required_permission_tier) VALUES ($1, $2, $3, $4, $5)',
      [id, T, 'fraud_suspected', `سبب قفل ${id}`, 'manager'],
    ));
    return id;
  }

  async function newOrder() {
    return creation.create(T, {
      branchId, cashierUserId: shiftCashierId, orderType: 'dine_in', salesChannelCode: 'dine_in',
      deliveryPlatformId: null, tableId: null,
      items: [{ menuItemId: itemId, quantity: 1 }], occurredAt: new Date(),
    });
  }

  function actor(user: TieredUser): VoidActor {
    return { userId: user.userId, tokenSecV: user.tokenSecV };
  }

  function challenge(managerUserId: string, pin: string, initiatingActorUserId: string, orderId?: string): Promise<Date> {
    return authenticator.verifyLiveChallenge(T, managerUserId, pin, initiatingActorUserId, 'void', orderId);
  }

  async function managerState(managerUserId: string): Promise<LockoutRow | null> {
    const result = await owner.query<LockoutRow>(
      'SELECT consecutive_failures, window_started_at, locked_until FROM manager_override_lockout_state WHERE tenant_id = $1 AND manager_user_id = $2',
      [T, managerUserId],
    );
    return result.rows[0] ?? null;
  }

  async function actorState(actorUserId: string): Promise<LockoutRow | null> {
    const result = await owner.query<LockoutRow>(
      'SELECT consecutive_failures, window_started_at, locked_until FROM manager_override_actor_lockout_state WHERE tenant_id = $1 AND initiating_actor_user_id = $2',
      [T, actorUserId],
    );
    return result.rows[0] ?? null;
  }

  async function attempts(filter: { manager?: string; actor?: string; outcome?: string } = {}): Promise<{ outcome: string; order_id: string | null }[]> {
    const conditions = ['tenant_id = $1'];
    const params: unknown[] = [T];
    if (filter.manager !== undefined) {
      params.push(filter.manager);
      conditions.push(`target_manager_user_id = $${params.length}`);
    }
    if (filter.actor !== undefined) {
      params.push(filter.actor);
      conditions.push(`initiating_actor_user_id = $${params.length}`);
    }
    if (filter.outcome !== undefined) {
      params.push(filter.outcome);
      conditions.push(`outcome = $${params.length}`);
    }
    const result = await owner.query<{ outcome: string; order_id: string | null }>(
      `SELECT outcome, order_id FROM manager_override_attempts WHERE ${conditions.join(' AND ')} ORDER BY created_at ASC, id ASC`,
      params,
    );
    return result.rows;
  }

  // ── The eight mandated invariants ────────────────────────────────────────

  it('#1 four failed challenges on the same manager still allow a fifth successful one', async () => {
    const manager = await createUserWithPin('9999');
    for (let i = 0; i < 4; i += 1) {
      await expect(challenge(manager, '0000', serverUser.userId)).rejects.toBeInstanceOf(ManagerOverrideAuthenticationError);
    }
    // The 5th attempt with the CORRECT PIN succeeds — a hurried manager who
    // mistyped four times is not punished; only the 5th FAILURE locks.
    const authenticatedAt = await challenge(manager, '9999', serverUser.userId);
    expect(authenticatedAt).toBeInstanceOf(Date);
    expect(must(await managerState(manager), 'manager state').consecutive_failures).toBe(0);
    expect((await attempts({ manager })).map((a) => a.outcome)).toEqual([
      'failed_wrong_pin', 'failed_wrong_pin', 'failed_wrong_pin', 'failed_wrong_pin', 'succeeded',
    ]);
  });

  it('#2 five consecutive failures lock the manager: the 6th is refused with 429 even with the correct PIN, audited as rejected_locked, not re-counted, not extended', async () => {
    const manager = await createUserWithPin('9999');
    for (let i = 0; i < 5; i += 1) {
      await expect(challenge(manager, '0000', serverUser.userId)).rejects.toBeInstanceOf(ManagerOverrideAuthenticationError);
    }
    const locked = must(await managerState(manager), 'manager state');
    expect(locked.consecutive_failures).toBe(5);
    expect(locked.locked_until).not.toBeNull();
    expect(locked.locked_until?.getTime()).toBeGreaterThan(Date.now());

    // The 6th attempt — with the CORRECT PIN this time — is still refused.
    const error = must(await captureError(challenge(manager, '9999', serverUser.userId)), 'rejection') as ManagerOverrideRateLimitedError;
    expect(error).toBeInstanceOf(ManagerOverrideRateLimitedError);
    expect(error.retryAfterSeconds).toBeGreaterThan(0);
    expect(error.retryAfterSeconds).toBeLessThanOrEqual(15 * 60);

    // Audited as rejected_locked ONLY: not counted again, not extended.
    const outcomes = (await attempts({ manager })).map((a) => a.outcome);
    expect(outcomes).toEqual([
      'failed_wrong_pin', 'failed_wrong_pin', 'failed_wrong_pin', 'failed_wrong_pin', 'failed_wrong_pin', 'rejected_locked',
    ]);
    const after = must(await managerState(manager), 'manager state');
    expect(after.consecutive_failures).toBe(5);
    const lockedUntil = locked.locked_until;
    const afterUntil = after.locked_until;
    if (lockedUntil === null || afterUntil === null) throw new Error('Expected both locked_until values');
    expect(afterUntil.getTime()).toBe(lockedUntil.getTime());
  });

  it('#3 a success resets the target manager counter only (a later failure counts as 1, not 3)', async () => {
    const manager = await createUserWithPin('9999');
    await expect(challenge(manager, '0000', serverUser.userId)).rejects.toBeInstanceOf(ManagerOverrideAuthenticationError);
    await expect(challenge(manager, '0000', serverUser.userId)).rejects.toBeInstanceOf(ManagerOverrideAuthenticationError);
    await challenge(manager, '9999', serverUser.userId);
    expect(must(await managerState(manager), 'manager state').consecutive_failures).toBe(0);
    await expect(challenge(manager, '0000', serverUser.userId)).rejects.toBeInstanceOf(ManagerOverrideAuthenticationError);
    expect(must(await managerState(manager), 'manager state').consecutive_failures).toBe(1);
    // The ACTOR counter, on the other hand, accumulated all three failures.
    expect(must(await actorState(serverUser.userId), 'actor state').consecutive_failures).toBe(3);
  });

  it('#4 one employee guessing across 10 DIFFERENT managers locks the EMPLOYEE (30 min) and writes a high-severity security event', async () => {
    const managers: string[] = [];
    for (let i = 0; i < 10; i += 1) managers.push(await createUserWithPin('9999'));
    for (const manager of managers) {
      await expect(challenge(manager, '0000', serverUser.userId)).rejects.toBeInstanceOf(ManagerOverrideAuthenticationError);
    }
    // No single manager reached its own threshold (1 failure each)…
    for (const manager of managers) {
      expect(must(await managerState(manager), 'manager state').consecutive_failures).toBe(1);
      expect(must(await managerState(manager), 'manager state').locked_until).toBeNull();
    }
    // …but the EMPLOYEE is hard-locked across all managers, for 30 minutes.
    const actor = must(await actorState(serverUser.userId), 'actor state');
    expect(actor.consecutive_failures).toBe(10);
    expect(actor.locked_until).not.toBeNull();
    expect(actor.locked_until?.getTime()).toBeGreaterThan(Date.now() + 29 * 60_000);

    // The mandatory high-severity security event in the Phase 4 audit_log.
    const events = await owner.query<{ user_id: string; after: SecurityEventAfter }>(
      `SELECT user_id, "after" FROM audit_log WHERE tenant_id = $1 AND action = 'security.manager_override_actor_locked' AND user_id = $2`,
      [T, serverUser.userId],
    );
    const event = row(events.rows);
    expect(event.user_id).toBe(serverUser.userId);
    expect(event.after.severity).toBe('high');
    expect(event.after.actor_id).toBe(serverUser.userId);
    expect(event.after.attempt_count).toBe(10);
    const tried = event.after.distinct_managers_tried as string[];
    expect(tried).toHaveLength(10);
    expect(new Set(tried)).toEqual(new Set(managers));

    // An 11th attempt — even on an 11th manager with the CORRECT PIN — is
    // refused immediately and audited as rejected_locked (users is not even read).
    const eleventh = await createUserWithPin('8888');
    const error = must(await captureError(challenge(eleventh, '8888', serverUser.userId)), 'rejection');
    expect(error).toBeInstanceOf(ManagerOverrideRateLimitedError);
    expect((await attempts({ actor: serverUser.userId, outcome: 'rejected_locked' })).length).toBe(1);
  });

  it('#5 a success on manager T does NOT reset the actor cross-manager counter', async () => {
    const managerA = await createUserWithPin('1111');
    const managerB = await createUserWithPin('2222');
    await expect(challenge(managerB, '0000', serverUser.userId)).rejects.toBeInstanceOf(ManagerOverrideAuthenticationError);
    await challenge(managerA, '1111', serverUser.userId); // success on T
    expect(must(await actorState(serverUser.userId), 'actor state').consecutive_failures).toBe(1);
    // Manager T's own counter was reset; the actor's was not.
    expect(must(await managerState(managerA), 'manager T state').consecutive_failures).toBe(0);
    await expect(challenge(managerB, '0000', serverUser.userId)).rejects.toBeInstanceOf(ManagerOverrideAuthenticationError);
    expect(must(await actorState(serverUser.userId), 'actor state').consecutive_failures).toBe(2);
    expect(must(await managerState(managerB), 'manager B state').consecutive_failures).toBe(2);
  });

  it('#6 an expired 15-minute window restarts the count (renewing window, no eternal accumulation)', async () => {
    const manager = await createUserWithPin('9999');
    for (let i = 0; i < 2; i += 1) {
      await expect(challenge(manager, '0000', serverUser.userId)).rejects.toBeInstanceOf(ManagerOverrideAuthenticationError);
    }
    expect(must(await managerState(manager), 'manager state').consecutive_failures).toBe(2);
    // Simulate the window having expired 16 minutes ago (test-only backdate
    // as the owner; the counter logic compares against the DB clock).
    await owner.query(
      "UPDATE manager_override_lockout_state SET window_started_at = now() - interval '16 minutes' WHERE tenant_id = $1 AND manager_user_id = $2",
      [T, manager],
    );
    await expect(challenge(manager, '0000', serverUser.userId)).rejects.toBeInstanceOf(ManagerOverrideAuthenticationError);
    const state = must(await managerState(manager), 'manager state');
    expect(state.consecutive_failures).toBe(1);
    expect(state.window_started_at).not.toBeNull();
    expect(state.window_started_at?.getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(state.locked_until).toBeNull();
  });

  it('#7 two concurrent challenges at the threshold moment: FOR UPDATE serializes them — exactly one activates the lock, no overrun', async () => {
    const manager = await createUserWithPin('9999');
    const actorX = await createTieredUser('server');
    const actorY = await createTieredUser('server');
    // 4 failures preloaded — the next failure (whoever it is) hits 5.
    for (let i = 0; i < 4; i += 1) {
      await expect(challenge(manager, '0000', actorX.userId)).rejects.toBeInstanceOf(ManagerOverrideAuthenticationError);
    }
    const [first, second] = await Promise.allSettled([
      challenge(manager, '0000', actorX.userId),
      challenge(manager, '0000', actorY.userId),
    ]);
    expect(first.status).toBe('rejected');
    expect(second.status).toBe('rejected');
    const reasons: unknown[] = [first, second].map((r) => (r.status === 'rejected' ? (r.reason as unknown) : null));
    // Exactly ONE of the two concurrent attempts hit the lock; the other was
    // the failure that ACTIVATED it.
    expect(reasons.filter((r) => r instanceof ManagerOverrideRateLimitedError)).toHaveLength(1);
    expect(reasons.filter((r) => r instanceof ManagerOverrideAuthenticationError)).toHaveLength(1);

    // EXACTLY 5 counted failures — the threshold was not overrun.
    const state = must(await managerState(manager), 'manager state');
    expect(state.consecutive_failures).toBe(5);
    expect(state.locked_until).not.toBeNull();
    // 4 preloaded + 2 concurrent = 6 attempts: 5 counted + 1 rejected_locked.
    const outcomes = (await attempts({ manager })).map((a) => a.outcome);
    expect(outcomes.filter((o) => o === 'failed_wrong_pin')).toHaveLength(5);
    expect(outcomes.filter((o) => o === 'rejected_locked')).toHaveLength(1);
    // The rejected_locked attempt was not counted on its actor either.
    const xState = must(await actorState(actorX.userId), 'actor X state');
    const yState = must(await actorState(actorY.userId), 'actor Y state');
    expect(xState.consecutive_failures + yState.consecutive_failures).toBe(5);
  });

  it('#8 the client error is byte-identical between a manager lock and an actor lock (anti-oracle)', async () => {
    // Manager lock: 5 failures from actorX on one manager.
    const manager = await createUserWithPin('9999');
    const actorX = await createTieredUser('server');
    for (let i = 0; i < 5; i += 1) {
      await expect(challenge(manager, '0000', actorX.userId)).rejects.toBeInstanceOf(ManagerOverrideAuthenticationError);
    }
    const managerLockError = must(await captureError(challenge(manager, '9999', actorX.userId)), 'manager-lock rejection');

    // Actor lock: actorY fails once against each of 10 managers.
    const actorY = await createTieredUser('server');
    for (let i = 0; i < 10; i += 1) {
      const target = await createUserWithPin('9999');
      await expect(challenge(target, '0000', actorY.userId)).rejects.toBeInstanceOf(ManagerOverrideAuthenticationError);
    }
    const actorLockError = must(await captureError(challenge(manager, '9999', actorY.userId)), 'actor-lock rejection');

    // Same text, same code, same HTTP status — the client cannot tell which
    // limit tripped. Only retryAfterSeconds may differ (15m vs 30m).
    const fromManagerLock = toErrorResponse(managerLockError, () => undefined);
    const fromActorLock = toErrorResponse(actorLockError, () => undefined);
    expect(fromManagerLock.status).toBe(429);
    expect(fromActorLock.status).toBe(429);
    expect(fromManagerLock.code).toBe('order.override_rate_limited');
    expect(fromActorLock.code).toBe('order.override_rate_limited');
    expect(fromManagerLock.message).toBe(RATE_LIMITED_MESSAGE);
    expect(fromActorLock.message).toBe(RATE_LIMITED_MESSAGE);
    expect(fromManagerLock.message).toBe(fromActorLock.message);
    expect(fromManagerLock.retryAfterSeconds).toBeDefined();
    expect(fromActorLock.retryAfterSeconds).toBeDefined();
  });

  it('#9 ENGINE WIRING: a failed override through voidOrderItem is counted against the INITIATING SERVER and linked to the order', async () => {
    const manager = await createTieredUser('manager');
    const created = await newOrder();
    const item = must(created.items[0], 'order item');
    const reason = await createManagerTierReason();
    await expect(voids.voidOrderItem(T, actor(serverUser), {
      orderItemId: item.item.id,
      voidReasonId: reason,
      managerOverride: { managerUserId: manager.userId, managerOverridePin: '0000' },
    })).rejects.toBeInstanceOf(ManagerOverrideAuthenticationError);

    const attempt = row(await attempts({ actor: serverUser.userId }));
    expect(attempt).toMatchObject({
      outcome: 'failed_wrong_pin',
    });
    const full = await owner.query<{ initiating_actor_user_id: string; target_manager_user_id: string; order_id: string | null }>(
      'SELECT initiating_actor_user_id, target_manager_user_id, order_id FROM manager_override_attempts WHERE tenant_id = $1 AND initiating_actor_user_id = $2',
      [T, serverUser.userId],
    );
    expect(row(full.rows)).toEqual({
      initiating_actor_user_id: serverUser.userId,
      target_manager_user_id: manager.userId,
      order_id: created.order.id,
    });
    // The failed challenge was counted on both sides of the wiring.
    expect(must(await managerState(manager.userId), 'manager state').consecutive_failures).toBe(1);
    expect(must(await actorState(serverUser.userId), 'actor state').consecutive_failures).toBe(1);
  });
});
