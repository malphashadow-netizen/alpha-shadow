import { describe, expect, it } from 'vitest';

import { PaymentMethodsEngine } from '../../../../src/application/engines/payments/payment-methods-engine.ts';
import type { AuthorizationEngine } from '../../../../src/application/engines/rbac/authorization-engine.ts';
import type {
  NewPaymentMethodInput,
  PaymentMethodRecord,
  PaymentsStore,
  PaymentsTxScope,
} from '../../../../src/domain/contracts/payments.ts';
import { ForbiddenError } from '../../../../src/shared/errors.ts';

const TENANT = 'tenant-1';
const ACTOR = 'actor-1';
const BRANCH = 'branch-1';

function unexpectedCall(name: string): never {
  throw new Error(`unexpected call: ${name} should not be reached in this test`);
}

function makeFullScope(overrides: Partial<PaymentsTxScope>): PaymentsTxScope {
  const base: PaymentsTxScope = {
    loadOrderFinancialSnapshot: async () => unexpectedCall('loadOrderFinancialSnapshot'),
    lockOrder: async () => unexpectedCall('lockOrder'),
    bumpOrderRevision: async () => unexpectedCall('bumpOrderRevision'),
    lockShift: async () => unexpectedCall('lockShift'),
    bumpShiftRevision: async () => unexpectedCall('bumpShiftRevision'),
    loadPaymentMethod: async () => unexpectedCall('loadPaymentMethod'),
    findOpenShiftForCashier: async () => unexpectedCall('findOpenShiftForCashier'),
    loadPayment: async () => unexpectedCall('loadPayment'),
    loadPaymentByIdempotencyKey: async () => unexpectedCall('loadPaymentByIdempotencyKey'),
    loadUserDiscountCaps: async () => unexpectedCall('loadUserDiscountCaps'),
    loadCouponByCode: async () => unexpectedCall('loadCouponByCode'),
    insertPayment: async () => unexpectedCall('insertPayment'),
    voidPayment: async () => unexpectedCall('voidPayment'),
    refundPayment: async () => unexpectedCall('refundPayment'),
    setOrderPaymentStatus: async () => unexpectedCall('setOrderPaymentStatus'),
    hasActiveOrderItems: async () => unexpectedCall('hasActiveOrderItems'),
    appendAuditEvidence: async () => unexpectedCall('appendAuditEvidence'),
    insertOrderDiscount: async () => unexpectedCall('insertOrderDiscount'),
    incrementCouponUses: async () => unexpectedCall('incrementCouponUses'),
    findSuccessfulOverrideAttemptId: async () => unexpectedCall('findSuccessfulOverrideAttemptId'),
    insertPaymentMethod: async () => unexpectedCall('insertPaymentMethod'),
    updatePaymentMethod: async () => unexpectedCall('updatePaymentMethod'),
    loadNonVoidedOrderItemIds: async () => unexpectedCall('loadNonVoidedOrderItemIds'),
    loadSaleDeductionsForOrderItems: async () => unexpectedCall('loadSaleDeductionsForOrderItems'),
    loadWasteRefundKeys: async () => unexpectedCall('loadWasteRefundKeys'),
    loadItemsWithKitchenTicketFired: async () => unexpectedCall('loadItemsWithKitchenTicketFired'),
    insertStockMovement: async () => unexpectedCall('insertStockMovement'),
  };
  return { ...base, ...overrides };
}

describe('PaymentMethodsEngine — B7 authorization wiring (payments:methods_admin)', () => {
  it('create() checks payments:methods_admin as sensitive BEFORE touching the store, tenant-wide when branchId is null', async () => {
    const seen: { permissionKey: string; hasResource: unknown; sensitive: unknown; actorBranchId: unknown }[] = [];
    const recording: Pick<AuthorizationEngine, 'check'> = {
      check: async (input) => {
        seen.push({
          permissionKey: input.permissionKey,
          hasResource: input.context.hasResource,
          sensitive: input.context.isSensitivePermission,
          actorBranchId: (input.context as { actorBranchId?: unknown }).actorBranchId,
        });
        return { allowed: true, effectiveMaxAmountMinorUnits: null };
      },
    };
    const store: PaymentsStore = {
      run: async () => unexpectedCall('store.run'),
    };
    const engine = new PaymentMethodsEngine({ store, authorization: recording });
    const input: NewPaymentMethodInput = {
      name: 'Cash',
      type: 'cash',
      branchId: null,
      currencyCode: null,
      fixedExchangeRate: null,
      isActive: true,
    };
    await expect(engine.create(TENANT, ACTOR, input)).rejects.toThrow();
    expect(seen).toEqual([
      { permissionKey: 'payments:methods_admin', hasResource: false, sensitive: true, actorBranchId: null },
    ]);
  });

  it('create() checks payments:methods_admin as sensitive and branch-scoped when branchId is set, before touching the store', async () => {
    const seen: { permissionKey: string; hasResource: unknown; sensitive: unknown; actorBranchId: unknown; resourceBranchId: unknown }[] = [];
    const recording: Pick<AuthorizationEngine, 'check'> = {
      check: async (input) => {
        seen.push({
          permissionKey: input.permissionKey,
          hasResource: input.context.hasResource,
          sensitive: input.context.isSensitivePermission,
          actorBranchId: (input.context as { actorBranchId?: unknown }).actorBranchId,
          resourceBranchId: (input.context as { resourceBranchId?: unknown }).resourceBranchId,
        });
        return { allowed: true, effectiveMaxAmountMinorUnits: null };
      },
    };
    const store: PaymentsStore = {
      run: async () => unexpectedCall('store.run'),
    };
    const engine = new PaymentMethodsEngine({ store, authorization: recording });
    const input: NewPaymentMethodInput = {
      name: 'Branch cash',
      type: 'cash',
      branchId: BRANCH,
      currencyCode: null,
      fixedExchangeRate: null,
      isActive: true,
    };
    await expect(engine.create(TENANT, ACTOR, input)).rejects.toThrow();
    expect(seen).toEqual([
      { permissionKey: 'payments:methods_admin', hasResource: true, sensitive: true, actorBranchId: BRANCH, resourceBranchId: BRANCH },
    ]);
  });

  it('create() rejects the mutation before any store access when authorization denies', async () => {
    const deny: Pick<AuthorizationEngine, 'check'> = {
      check: async () => { throw new ForbiddenError('missing permission payments:methods_admin'); },
    };
    const store: PaymentsStore = {
      run: async () => unexpectedCall('store.run'),
    };
    const engine = new PaymentMethodsEngine({ store, authorization: deny });
    const input: NewPaymentMethodInput = {
      name: 'Cash',
      type: 'cash',
      branchId: null,
      currencyCode: null,
      fixedExchangeRate: null,
      isActive: true,
    };
    await expect(engine.create(TENANT, ACTOR, input)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('update() checks payments:methods_admin as sensitive, scoped to the EXISTING record\'s branch', async () => {
    const seen: { permissionKey: string; hasResource: unknown; sensitive: unknown; resourceBranchId: unknown }[] = [];
    const existingRecord: PaymentMethodRecord = {
      id: 'pm-1',
      tenantId: TENANT,
      branchId: BRANCH,
      name: 'Cash',
      type: 'cash',
      currencyCode: null,
      fixedExchangeRate: null,
      isActive: true,
    } as PaymentMethodRecord;
    const recording: Pick<AuthorizationEngine, 'check'> = {
      check: async (input) => {
        seen.push({
          permissionKey: input.permissionKey,
          hasResource: input.context.hasResource,
          sensitive: input.context.isSensitivePermission,
          resourceBranchId: (input.context as { resourceBranchId?: unknown }).resourceBranchId,
        });
        return { allowed: true, effectiveMaxAmountMinorUnits: null };
      },
    };
    const store: PaymentsStore = {
      run: async (_tenantId, fn) => fn(makeFullScope({
        loadPaymentMethod: async () => existingRecord,
        updatePaymentMethod: async (_t, _id, _input) => existingRecord,
      })),
    };
    const engine = new PaymentMethodsEngine({ store, authorization: recording });
    await engine.update(TENANT, ACTOR, 'pm-1', { isActive: false });
    expect(seen).toEqual([
      { permissionKey: 'payments:methods_admin', hasResource: true, sensitive: true, resourceBranchId: BRANCH },
    ]);
  });

  it('update() on a missing record checks payments:methods_admin tenant-wide (hasResource: false) before throwing NotFoundError', async () => {
    const seen: { permissionKey: string; hasResource: unknown; sensitive: unknown; actorBranchId: unknown }[] = [];
    const recording: Pick<AuthorizationEngine, 'check'> = {
      check: async (input) => {
        seen.push({
          permissionKey: input.permissionKey,
          hasResource: input.context.hasResource,
          sensitive: input.context.isSensitivePermission,
          actorBranchId: (input.context as { actorBranchId?: unknown }).actorBranchId,
        });
        return { allowed: true, effectiveMaxAmountMinorUnits: null };
      },
    };
    const store: PaymentsStore = {
      run: async (_tenantId, fn) => fn(makeFullScope({
        loadPaymentMethod: async () => null,
      })),
    };
    const engine = new PaymentMethodsEngine({ store, authorization: recording });
    await expect(engine.update(TENANT, ACTOR, 'missing-id', { isActive: false })).rejects.toThrow();
    expect(seen).toEqual([
      { permissionKey: 'payments:methods_admin', hasResource: false, sensitive: true, actorBranchId: null },
    ]);
  });
});
