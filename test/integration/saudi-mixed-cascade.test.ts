/**
 * B6 — Saudi mixed-direction cascade (LIVE, real PostgreSQL).
 *
 * Before the fix, EVERY lower-priority tax cascaded into higher-priority
 * bases — including INCLUSIVE taxes that are already embedded in the line
 * amount (double-count). The fix cascades EXCLUSIVE tax only (spec step 7).
 * Proved end-to-end through real order creation:
 *
 * - T1 (the B6 fix — Saudi tobacco): 100% excise INCLUSIVE + 15% VAT
 *   EXCLUSIVE on 1000. The embedded 500 does NOT inflate the VAT base:
 *   excise 500/500, VAT 1000/150 (pre-fix the VAT read 225 on 1500).
 * - T2 (preserved direction — the spec's 2000-base example): 100% excise
 *   EXCLUSIVE + 15% VAT INCLUSIVE on 1000. The on-top 1000 DOES enter the
 *   VAT base: excise 1000, VAT 2000 → 261/1739.
 *
 * Both directions are pinned on the returned resolutions AND the durable
 * snapshot rows. Pure-math parity lives in the B6 unit test.
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
import { TenantTaxAdminEngine } from '../../src/application/engines/tax/tenant-tax-admin-engine.ts';
import { EXCISE_CONFIRMATION_TEXT, TAX_PERMISSION_KEYS, type TenantTaxActor } from '../../src/domain/contracts/tenant-tax-admin.ts';
import { deriveSecV } from '../../src/domain/contracts/sec-v.ts';
import type { TaxResolution } from '../../src/domain/contracts/tax.ts';
import { createWithTenantContext, type WithTenantContext } from '../../src/infrastructure/db/tenant-context.ts';
import { createWithPlatformTaxContext } from '../../src/infrastructure/db/platform-tax-context.ts';
import { PostgresCatalogRepository } from '../../src/infrastructure/db/repositories/postgres-catalog-repository.ts';
import { PostgresManagerOverrideAuthenticator } from '../../src/infrastructure/db/repositories/postgres-manager-override-authenticator.ts';
import { PostgresOrdersStore } from '../../src/infrastructure/db/repositories/postgres-orders-store.ts';
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
let T: string; // dedicated B6 tenant (fresh per run)
const PIN_PEPPER = Buffer.from(randomBytes(48));

function restaurantLines(taxes: TaxResolution) {
  if (isExternalTaxLiability(taxes)) throw new Error('Expected restaurant tax lines');
  return taxes;
}

interface TillUser {
  readonly userId: string;
}

describe('B6 Saudi mixed-direction cascade (live)', () => {
  let owner: pg.Pool;
  let app: pg.Pool;
  let platformPool: pg.Pool;
  let withApp: WithTenantContext;
  let creation: OrderCreationEngine;
  let shifts: ShiftEngine;
  let admin: TenantTaxAdminEngine;
  let actor: TenantTaxActor;
  let catalog: CatalogEngine;
  let menuCategoryId: string;
  let tobaccoItemId: string; // inclusive excise + exclusive VAT
  let reverseItemId: string; // exclusive excise + inclusive VAT
  let opener: TillUser;
  let verifier: TillUser;

  beforeAll(async () => {
    owner = new pg.Pool({ connectionString: testDatabaseUrl(), max: 5 });
    T = randomUUID();
    await owner.query('INSERT INTO tenants (id, name) VALUES ($1, $2)', [T, 'b6-mixed-cascade']);
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

    const tenantRepo = new PostgresTenantTaxAdminRepository(withApp);
    const authorization = new AuthorizationEngine({ read: new PostgresPermissionReadRepository({ withTenantContext: withApp }), hash: sha256Hex });
    catalog = new CatalogEngine({ catalog: new PostgresCatalogRepository({ withTenantContext: withApp }), taxAssignments: tenantRepo, authorization });
    const ordersStore = new PostgresOrdersStore({ withTenantContext: withApp });
    shifts = new ShiftEngine({ store: new PostgresShiftsStore({ withTenantContext: withApp }), authorization });
    const authenticator = new PostgresManagerOverrideAuthenticator({ withTenantContext: withApp, pepper: PIN_PEPPER });
    creation = new OrderCreationEngine({ store: ordersStore, authorization, managerAuthenticator: authenticator });
    const permissionRead = new PostgresPermissionReadRepository({ withTenantContext: withApp });
    admin = new TenantTaxAdminEngine({ repository: tenantRepo, authorization });

    // Platform tax fixture: SA per_line; two excise/VAT pairs (one per direction).
    const platform = new PlatformTaxAdminEngine(new PostgresPlatformTaxAdminRepository(createWithPlatformTaxContext(platformPool)));
    await platform.configureJurisdiction(PLATFORM_ACTOR, 'SA', 'per_line', true);
    const makeCategory = (family: 'excise' | 'vat') =>
      platform.createCategory(PLATFORM_ACTOR, {
        countryCode: 'SA', code: randomUUID(), kind: 'standard', taxFamily: family,
        cascadePriority: family === 'excise' ? 10 : 50, name: { en: `B6 fixture ${family}` }, isActive: true,
      });
    const exciseIncl = await makeCategory('excise');
    const vatExcl = await makeCategory('vat');
    const exciseExcl = await makeCategory('excise');
    const vatIncl = await makeCategory('vat');
    const makeRate = (taxCategoryId: string, rateBps: number, isPriceInclusiveDefault: boolean) =>
      platform.createTaxRate(PLATFORM_ACTOR, { taxCategoryId, rateBps, isPriceInclusiveDefault, effectiveFrom: '2020-01-01', effectiveTo: null });
    await makeRate(exciseIncl.id, 10000, true);
    await makeRate(vatExcl.id, 1500, false);
    await makeRate(exciseExcl.id, 10000, false);
    await makeRate(vatIncl.id, 1500, true);
    await owner.query("UPDATE tenants SET vat_registration_status = 'registered', vat_registration_number = 'b6-vat' WHERE id = $1", [T]);

    const workflowAdmin = new WorkflowAdminEngine({ store: ordersStore });
    await workflowAdmin.ensureWorkflow(T, [
      { kindCode: 'received', position: 10, label: { ar: 'مستلم' } },
      { kindCode: 'preparing', position: 20, label: { ar: 'قيد التحضير' } },
      { kindCode: 'ready', position: 30, label: { ar: 'جاهز' } },
      { kindCode: 'delivered', position: 40, label: { ar: 'تم التسليم' } },
    ]);

    // Tax-admin actor: a user holding every tenant-tax permission key.
    const adminUserId = randomUUID();
    const adminRoleId = randomUUID();
    await withApp(T, async (q) => {
      await q.query('INSERT INTO users (id, tenant_id, email, password_hash) VALUES ($1, $2, $3, $4)', [adminUserId, T, `${adminUserId}@example.test`, 'test-only-hash']);
      await q.query('INSERT INTO roles (id, tenant_id, name) VALUES ($1, $2, $3)', [adminRoleId, T, 'b6-tax-admin']);
      for (const key of [...TAX_PERMISSION_KEYS, 'catalog:write']) {
        await q.query('INSERT INTO role_permissions (tenant_id, role_id, permission_key) VALUES ($1, $2, $3)', [T, adminRoleId, key]);
      }
      await q.query("INSERT INTO user_roles (tenant_id, user_id, role_id, scope_type, scope_id) VALUES ($1, $2, $3, 'tenant', NULL)", [T, adminUserId, adminRoleId]);
    });
    actor = {
      tenantId: T,
      userId: adminUserId,
      tokenSecV: deriveSecV(await permissionRead.listActiveUserRoles(T, adminUserId), await permissionRead.getSecurityVersion(T, adminUserId), sha256Hex),
    };

    menuCategoryId = (await catalog.createCategory(T, adminUserId, { name: { ar: 'قائمة B6' } })).id;
    // For excise the confirmation IS the primary assignment (explicit consent);
    // the VAT side joins as the additional category afterwards.
    const makeItem = async (exciseId: string, vatId: string, name: string) => {
      const id = (await catalog.createItem(T, adminUserId, {
        categoryId: menuCategoryId, name: { ar: name }, basePrice: money(1000n, currencyCode('SAR')), taxRuleId: vatId,
      })).id;
      await admin.confirmExciseAssignment(actor, { menuItemId: id, taxCategoryId: exciseId, slot: 'primary', confirmation: EXCISE_CONFIRMATION_TEXT });
      await admin.assignAdditionalCategory(actor, id, vatId);
      return id;
    };
    tobaccoItemId = await makeItem(exciseIncl.id, vatExcl.id, 'تبغ B6');
    reverseItemId = await makeItem(exciseExcl.id, vatIncl.id, 'معكوس B6');

    opener = await createUser();
    verifier = await createUser();
    const permWrite = new PostgresPermissionWriteRepository({ withTenantContext: withApp });
    await grantKeys(permWrite, T, opener.userId, ['shift:open']);
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

  /** A fresh till (branch + station + cashier + open shift) routed to BOTH items. */
  async function setupTill() {
    const branchId = randomUUID();
    const stationId = randomUUID();
    const cashier = await createUser();
    await withApp(T, async (q) => {
      await q.query('INSERT INTO branches (id, tenant_id, name, base_currency, timezone, country_code) VALUES ($1, $2, $3, $4, $5, $6)', [branchId, T, `B6 ${randomUUID()}`, 'SAR', 'Asia/Riyadh', 'SA']);
      await q.query('INSERT INTO stations (id, tenant_id, branch_id, name) VALUES ($1, $2, $3, $4)', [stationId, T, branchId, 'main']);
      for (const menuItemId of [tobaccoItemId, reverseItemId]) {
        await q.query('INSERT INTO station_routing_rules (id, tenant_id, branch_id, station_id, menu_item_id) VALUES ($1, $2, $3, $4, $5)', [randomUUID(), T, branchId, stationId, menuItemId]);
      }
    });
    const shift = await shifts.openShift(T, {
      branchId, cashierUserId: cashier.userId, openedByUserId: opener.userId, openVerifiedByUserId: verifier.userId,
      openedAt: new Date(), openCounts: [{ denominationValue: '100.00', quantity: 2 }],
    });
    return { branchId, cashier, shiftId: shift.id };
  }

  async function snapshotsOf(orderLineId: string) {
    const snapshots = await owner.query<{ tax_family: string; taxable: string; tax: string }>(
      'SELECT tax_family, taxable_amount_minor::text AS taxable, tax_amount_minor::text AS tax FROM order_line_tax_snapshots WHERE order_line_id = $1 ORDER BY computation_sequence',
      [orderLineId],
    );
    return snapshots.rows;
  }

  it('T1 Saudi tobacco: inclusive excise does NOT cascade into the exclusive VAT base', async () => {
    const till = await setupTill();
    const created = await creation.create(T, {
      branchId: till.branchId, cashierUserId: till.cashier.userId, orderType: 'dine_in', salesChannelCode: 'dine_in',
      deliveryPlatformId: null, tableId: null,
      items: [{ menuItemId: tobaccoItemId, quantity: 1 }],
      occurredAt: new Date(),
    });
    expect(created.items).toHaveLength(1);

    // Returned resolutions: excise 500/500 embedded; VAT on the bare 1000.
    const first = created.items[0];
    if (first === undefined) throw new Error('Expected one created item');
    expect(restaurantLines(first.taxes)).toMatchObject([
      { taxFamily: 'excise', taxableAmountMinor: 500n, taxAmountMinor: 500n },
      { taxFamily: 'vat', taxableAmountMinor: 1000n, taxAmountMinor: 150n },
    ]);

    // Durable evidence: the SAME split on the snapshot rows.
    expect(await snapshotsOf(first.item.id)).toEqual([
      { tax_family: 'excise', taxable: '500', tax: '500' },
      { tax_family: 'vat', taxable: '1000', tax: '150' },
    ]);
  });

  it('T2 reverse direction: exclusive excise still cascades into the inclusive VAT base', async () => {
    const till = await setupTill();
    const created = await creation.create(T, {
      branchId: till.branchId, cashierUserId: till.cashier.userId, orderType: 'dine_in', salesChannelCode: 'dine_in',
      deliveryPlatformId: null, tableId: null,
      items: [{ menuItemId: reverseItemId, quantity: 1 }],
      occurredAt: new Date(),
    });
    expect(created.items).toHaveLength(1);

    // The on-top 1000 enters the VAT base: 2000 → 261/1739 (spec example).
    const first = created.items[0];
    if (first === undefined) throw new Error('Expected one created item');
    expect(restaurantLines(first.taxes)).toMatchObject([
      { taxFamily: 'excise', taxableAmountMinor: 1000n, taxAmountMinor: 1000n },
      { taxFamily: 'vat', taxableAmountMinor: 1739n, taxAmountMinor: 261n },
    ]);

    expect(await snapshotsOf(first.item.id)).toEqual([
      { tax_family: 'excise', taxable: '1000', tax: '1000' },
      { tax_family: 'vat', taxable: '1739', tax: '261' },
    ]);
  });
});
