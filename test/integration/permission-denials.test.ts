/**
 * B7 live acceptance: every new permission key denies without the grant and
 * succeeds with it — on the SAME fixture, so each test proves the denial was
 * the missing key and nothing else (grant → success leg).
 *
 * Keys covered: payments:collect, shift:open, shift:close,
 * payments:methods_admin (create + update), catalog:write, catalog:archive
 * (including write-without-archive and open-without-close separation).
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
import { currencyCode, money } from '../../src/shared/money.ts';
import { testDatabaseUrl } from '../support/database.ts';
import { grantKeys } from '../support/grant-keys.ts';

interface TillUser {
  readonly userId: string;
}

const PLATFORM_ACTOR = '71000000-0000-4000-8000-000000000005';
const PIN_PEPPER = Buffer.from(randomBytes(48));

async function grantBranchKeys(
  write: PostgresPermissionWriteRepository,
  tenantId: string,
  userId: string,
  branchId: string,
  keys: readonly string[],
): Promise<void> {
  const roleId = await write.createRole(tenantId, `b7-branch-grant-${randomUUID()}`);
  for (const key of keys) {
    await write.assignRolePermission(tenantId, roleId, key, null);
  }
  await write.assignUserRole(tenantId, userId, roleId, 'branch', branchId);
}

describe('B7 permission denials (live)', () => {
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
  let branchId: string;
  let itemId: string; // 40.00 SAR; 15% VAT ⇒ total 46.00
  let methodCashId: string;
  let opener: TillUser;
  let verifier: TillUser;

  beforeAll(async () => {
    owner = new pg.Pool({ connectionString: testDatabaseUrl(), max: 5 });
    T = randomUUID();
    await owner.query('INSERT INTO tenants (id, name) VALUES ($1, $2)', [T, 'b7-denials']);
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
      name: { en: 'B7 fixture VAT' }, isActive: true,
    });
    await platform.createTaxRate(PLATFORM_ACTOR, { taxCategoryId: saCategory.id, rateBps: 1500, isPriceInclusiveDefault: false, effectiveFrom: '2020-01-01', effectiveTo: null });
    await owner.query("UPDATE tenants SET vat_registration_status = 'registered', vat_registration_number = 'b7-vat' WHERE id = $1", [T]);

    await workflowAdmin.ensureWorkflow(T, [
      { kindCode: 'received', position: 10, label: { ar: 'مستلم' } },
      { kindCode: 'preparing', position: 20, label: { ar: 'قيد التحضير' } },
      { kindCode: 'ready', position: 30, label: { ar: 'جاهز' } },
      { kindCode: 'delivered', position: 40, label: { ar: 'تم التسليم' } },
    ]);

    opener = await createUser();
    verifier = await createUser();
    await grantKeys(permWrite, T, opener.userId, ['shift:open', 'shift:close', 'catalog:write', 'payments:methods_admin']);

    const menuCategoryId = (await catalog.createCategory(T, opener.userId, { name: { ar: 'قائمة B7' } })).id;
    itemId = (await catalog.createItem(T, opener.userId, {
      categoryId: menuCategoryId, name: { ar: 'طبق B7' }, basePrice: money(4000n, currencyCode('SAR')), taxRuleId: saCategory.id,
    })).id;
    methodCashId = (await methods.create(T, opener.userId, { name: 'نقدي B7', type: 'cash', branchId: null, currencyCode: null, fixedExchangeRate: null, isActive: true })).id;

    branchId = randomUUID();
    const stationId = randomUUID();
    await withApp(T, async (q) => {
      await q.query('INSERT INTO branches (id, tenant_id, name, base_currency, timezone, country_code) VALUES ($1, $2, $3, $4, $5, $6)', [branchId, T, 'B7 branch', 'SAR', 'Asia/Riyadh', 'SA']);
      await q.query('INSERT INTO stations (id, tenant_id, branch_id, name) VALUES ($1, $2, $3, $4)', [stationId, T, branchId, 'main']);
      await q.query('INSERT INTO station_routing_rules (id, tenant_id, branch_id, station_id, menu_item_id) VALUES ($1, $2, $3, $4, $5)', [randomUUID(), T, branchId, stationId, itemId]);
    });
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

  /** Opens a shift for a FRESH cashier (one open shift per cashier, ever). */
  async function openShiftForFreshCashier(openedBy: string, verifiedBy: string) {
    const cashier = await createUser();
    const shift = await shifts.openShift(T, {
      branchId, cashierUserId: cashier.userId, openedByUserId: openedBy, openVerifiedByUserId: verifiedBy,
      openedAt: new Date(), openCounts: [{ denominationValue: '100.00', quantity: 2 }],
    });
    return { cashier, shiftId: shift.id };
  }

  async function newOrder(cashierId: string): Promise<string> {
    const created = await creation.create(T, {
      branchId, cashierUserId: cashierId, orderType: 'dine_in', salesChannelCode: 'dine_in',
      deliveryPlatformId: null, tableId: null,
      items: [{ menuItemId: itemId, quantity: 1 }], occurredAt: new Date(),
    });
    return created.order.id;
  }

  it('D1 payments:collect: denied without the grant, succeeds once granted (same order)', async () => {
    const { cashier } = await openShiftForFreshCashier(opener.userId, verifier.userId);
    const orderId = await newOrder(cashier.userId);
    await expect(payments.recordPayment(T, {
      orderId, paymentMethodId: methodCashId, cashierUserId: cashier.userId, amountText: '46.00',
    })).rejects.toMatchObject({ code: 'forbidden', message: 'missing permission payments:collect' });
    await grantKeys(permWrite, T, cashier.userId, ['payments:collect']);
    const paid = await payments.recordPayment(T, {
      orderId, paymentMethodId: methodCashId, cashierUserId: cashier.userId, amountText: '46.00',
    });
    expect(paid.remainingBalanceMinor).toBe(0n);
  });

  it('D2 shift:open: denied without the grant, succeeds once granted', async () => {
    const unprivileged = await createUser();
    const cashier = await createUser();
    await expect(shifts.openShift(T, {
      branchId, cashierUserId: cashier.userId, openedByUserId: unprivileged.userId, openVerifiedByUserId: verifier.userId,
      openedAt: new Date(), openCounts: [],
    })).rejects.toMatchObject({ code: 'forbidden', message: 'missing permission shift:open' });
    await grantKeys(permWrite, T, unprivileged.userId, ['shift:open']);
    const shift = await shifts.openShift(T, {
      branchId, cashierUserId: cashier.userId, openedByUserId: unprivileged.userId, openVerifiedByUserId: verifier.userId,
      openedAt: new Date(), openCounts: [],
    });
    expect(shift.status).toBe('open');
  });

  it('D3 shift:close is a SEPARATE key: an opener without it is denied, succeeds once granted', async () => {
    const openerOnly = await createUser();
    await grantKeys(permWrite, T, openerOnly.userId, ['shift:open']);
    const { shiftId } = await openShiftForFreshCashier(openerOnly.userId, verifier.userId);
    await expect(shifts.closeShift(T, {
      shiftId, closedByUserId: openerOnly.userId, closeVerifiedByUserId: verifier.userId,
      closedAt: new Date(), closeCounts: [{ denominationValue: '100.00', quantity: 2 }], notes: null,
    })).rejects.toMatchObject({ code: 'forbidden', message: 'missing permission shift:close' });
    await grantKeys(permWrite, T, openerOnly.userId, ['shift:close']);
    const closed = await shifts.closeShift(T, {
      shiftId, closedByUserId: openerOnly.userId, closeVerifiedByUserId: verifier.userId,
      closedAt: new Date(), closeCounts: [{ denominationValue: '100.00', quantity: 2 }], notes: null,
    });
    expect(closed.status).toBe('closed');
  });

  it('D4a payments:methods_admin: create denied without the grant, succeeds once granted', async () => {
    const admin = await createUser();
    const input = { name: 'بطاقة B7', type: 'card', branchId: null, currencyCode: null, fixedExchangeRate: null, isActive: true } as const;
    await expect(methods.create(T, admin.userId, input))
      .rejects.toMatchObject({ code: 'forbidden', message: 'missing permission payments:methods_admin' });
    await grantKeys(permWrite, T, admin.userId, ['payments:methods_admin']);
    const created = await methods.create(T, admin.userId, input);
    expect(created.name).toBe('بطاقة B7');
  });

  it('D4b payments:methods_admin: update denied without the grant, succeeds once granted', async () => {
    const admin = await createUser();
    await expect(methods.update(T, admin.userId, methodCashId, { name: 'نقدي B7 معدل' }))
      .rejects.toMatchObject({ code: 'forbidden', message: 'missing permission payments:methods_admin' });
    await grantKeys(permWrite, T, admin.userId, ['payments:methods_admin']);
    const updated = await methods.update(T, admin.userId, methodCashId, { name: 'نقدي B7 معدل' });
    expect(updated.name).toBe('نقدي B7 معدل');
  });

  it('D5a catalog:write: create denied without the grant, succeeds once granted', async () => {
    const editor = await createUser();
    await expect(catalog.createCategory(T, editor.userId, { name: { ar: 'مرفوض' } }))
      .rejects.toMatchObject({ code: 'forbidden', message: 'missing permission catalog:write' });
    await grantKeys(permWrite, T, editor.userId, ['catalog:write']);
    const created = await catalog.createCategory(T, editor.userId, { name: { ar: 'مقبول' } });
    expect(created.name).toEqual({ ar: 'مقبول' });
  });

  it('D5b catalog:archive is a SEPARATE key: a writer without it is denied, succeeds once granted', async () => {
    const editor = await createUser();
    await grantKeys(permWrite, T, editor.userId, ['catalog:write']);
    const created = await catalog.createCategory(T, editor.userId, { name: { ar: 'للأرشفة' } });
    await expect(catalog.archiveCategory(T, editor.userId, created.id))
      .rejects.toMatchObject({ code: 'forbidden', message: 'missing permission catalog:archive' });
    await grantKeys(permWrite, T, editor.userId, ['catalog:archive']);
    const archived = await catalog.archiveCategory(T, editor.userId, created.id);
    expect(archived.isActive).toBe(false);
  });

  it('AUTH-BR-19 payments:methods_admin create: a branch-A-only grant is scoped to branch A', async () => {
    const branchOnly = await createUser();
    await grantBranchKeys(permWrite, T, branchOnly.userId, branchId, ['payments:methods_admin']);

    const branchB = randomUUID();
    await withApp(T, (q) => q.query(
      'INSERT INTO branches (id, tenant_id, name, base_currency, timezone, country_code) VALUES ($1, $2, $3, $4, $5, $6)',
      [branchB, T, 'B7 branch B', 'SAR', 'Asia/Riyadh', 'SA'],
    ));

    const allowedInA = await methods.create(T, branchOnly.userId, {
      name: 'فرع A', type: 'card', branchId, currencyCode: null, fixedExchangeRate: null, isActive: true,
    });
    expect(allowedInA.branchId).toBe(branchId);

    await expect(methods.create(T, branchOnly.userId, {
      name: 'فرع B مرفوض', type: 'card', branchId: branchB, currencyCode: null, fixedExchangeRate: null, isActive: true,
    })).rejects.toMatchObject({ code: 'forbidden', message: 'missing permission payments:methods_admin' });

    await expect(methods.create(T, branchOnly.userId, {
      name: 'كل الفروع مرفوض', type: 'card', branchId: null, currencyCode: null, fixedExchangeRate: null, isActive: true,
    })).rejects.toMatchObject({ code: 'forbidden', message: 'missing permission payments:methods_admin' });

    const tenantAdmin = await createUser();
    await grantKeys(permWrite, T, tenantAdmin.userId, ['payments:methods_admin']);
    for (const scopedBranchId of [branchId, branchB, null]) {
      const created = await methods.create(T, tenantAdmin.userId, {
        name: 'منحة tenant', type: 'card', branchId: scopedBranchId, currencyCode: null, fixedExchangeRate: null, isActive: true,
      });
      expect(created.branchId).toBe(scopedBranchId);
    }
  });

  it('AUTH-BR-20 payments:methods_admin update: a branch-A-only grant cannot administer branch-B or tenant-wide methods, and does not disclose their existence', async () => {
    const tenantAdmin = await createUser();
    await grantKeys(permWrite, T, tenantAdmin.userId, ['payments:methods_admin']);

    const branchB = randomUUID();
    await withApp(T, (q) => q.query(
      'INSERT INTO branches (id, tenant_id, name, base_currency, timezone, country_code) VALUES ($1, $2, $3, $4, $5, $6)',
      [branchB, T, 'B7 branch B (update)', 'SAR', 'Asia/Riyadh', 'SA'],
    ));

    const methodInA = await methods.create(T, tenantAdmin.userId, {
      name: 'وسيلة فرع A', type: 'card', branchId, currencyCode: null, fixedExchangeRate: null, isActive: true,
    });
    const methodInB = await methods.create(T, tenantAdmin.userId, {
      name: 'وسيلة فرع B', type: 'card', branchId: branchB, currencyCode: null, fixedExchangeRate: null, isActive: true,
    });

    const branchOnly = await createUser();
    await grantBranchKeys(permWrite, T, branchOnly.userId, branchId, ['payments:methods_admin']);

    const updatedInA = await methods.update(T, branchOnly.userId, methodInA.id, { name: 'محدّث فرع A' });
    expect(updatedInA.name).toBe('محدّث فرع A');

    await expect(methods.update(T, branchOnly.userId, methodInB.id, { name: 'مرفوض' }))
      .rejects.toMatchObject({ code: 'forbidden', message: 'missing permission payments:methods_admin' });

    await expect(methods.update(T, branchOnly.userId, methodCashId, { name: 'مرفوض tenant-wide' }))
      .rejects.toMatchObject({ code: 'forbidden', message: 'missing permission payments:methods_admin' });

    // عدم الإفشاء: معرّف غير موجود تحت نفس المنحة المقيّدة بفرع يجب أن يفشل
    // بنفس شكل الرفض الخاص بفرع B، وليس بـ NotFoundError.
    await expect(methods.update(T, branchOnly.userId, randomUUID(), { name: 'غير موجود' }))
      .rejects.toMatchObject({ code: 'forbidden', message: 'missing permission payments:methods_admin' });

    for (const target of [methodInA.id, methodInB.id, methodCashId]) {
      const updated = await methods.update(T, tenantAdmin.userId, target, { name: 'منحة tenant محدثة' });
      expect(updated.name).toBe('منحة tenant محدثة');
    }
  });
});
