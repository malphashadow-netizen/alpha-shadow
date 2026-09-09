/**
 * B8 unit tests: the idempotency catch-path branches with a fake store.
 *
 * The live suite proves outcomes (same-key-twice, conflicts, the race); this
 * file pins the branches a live test cannot reach deterministically:
 *   - 23505 + probe hit → replay, 23505 + probe miss → rethrow (identity),
 *   - non-23505 / key-less failures never probe,
 *   - blank/over-long keys rejected before any store work,
 *   - the pre-check replay path writes nothing (no bump, no status, no insert).
 */
import { describe, expect, it, vi } from 'vitest';

import { PaymentsEngine, type RecordPaymentInput } from '../../../../src/application/engines/payments/payments-engine.ts';
import type { AuthorizationEngine } from '../../../../src/application/engines/rbac/authorization-engine.ts';
import type {
  OrderFinancialSnapshot,
  PaymentMethodRecord,
  PaymentRecord,
  PaymentsStore,
  PaymentsTxScope,
} from '../../../../src/domain/contracts/payments.ts';
import { ConflictError, ValidationError } from '../../../../src/shared/errors.ts';

const T = 'tenant-b8-unit';
const ORDER = 'order-b8-unit';
const METHOD = 'method-b8-unit';
const CASHIER = 'cashier-b8-unit';
const KEY = 'idem-key-unit-1';

const allowAll: Pick<AuthorizationEngine, 'check'> = {
  check: async () => ({ allowed: true, effectiveMaxAmountMinorUnits: null }),
};

/** A 46.00 order whose tax plans are empty (totals stay in the pure path). */
function snapshot(): OrderFinancialSnapshot {
  return {
    orderId: ORDER,
    branchId: 'branch-b8-unit',
    baseCurrencyCode: 'SAR',
    paymentStatus: 'open',
    roundingStrategy: null,
    lines: [{ orderItemId: 'line-b8-unit', lineAmountMinor: 4600n, taxPlan: [] }],
    discounts: [],
    completedPaymentsMinor: 4600n,
    paymentStatuses: ['completed'],
  };
}

function method(): PaymentMethodRecord {
  return {
    id: METHOD, tenantId: T, branchId: null, name: 'cash', type: 'cash',
    currencyCode: null, fixedExchangeRate: null, isActive: true,
  };
}

function recorded(overrides: Partial<PaymentRecord> = {}): PaymentRecord {
  return {
    id: 'pay-b8-unit', tenantId: T, orderId: ORDER, paymentMethodId: METHOD,
    amount: '46.00', amountInBaseCurrency: '46.00', exchangeRateSnapshot: null, changeGivenAmount: null,
    status: 'completed', shiftId: 'shift-b8-unit', createdBy: CASHIER, idempotencyKey: KEY,
    voidedById: null, voidedAt: null, voidReason: null, createdAt: new Date(0),
    ...overrides,
  };
}

function input(overrides: Partial<RecordPaymentInput> = {}): RecordPaymentInput {
  return {
    orderId: ORDER, paymentMethodId: METHOD, cashierUserId: CASHIER,
    amountText: '46.00', idempotencyKey: KEY, ...overrides,
  };
}

function unused(name: string): never {
  throw new Error(`unused scope method called: ${name}`);
}

function pgUniqueViolation(): Error & { code: string } {
  return Object.assign(new Error('duplicate key value violates unique constraint "idx_payments_idempotency_key"'), {
    code: '23505',
  });
}

interface FakeScopeOptions {
  readonly byKey: PaymentRecord | null;
  readonly calls: { bumped: boolean; statusSet: boolean };
  readonly probe: (tenantId: string, idempotencyKey: string) => Promise<PaymentRecord | null>;
}

function fakeScope(options: FakeScopeOptions): PaymentsTxScope {
  return {
    loadOrderFinancialSnapshot: async () => snapshot(),
    lockOrder: async () => ({ id: ORDER }),
    bumpOrderRevision: async () => {
      options.calls.bumped = true;
    },
    lockShift: async () => unused('lockShift'),
    bumpShiftRevision: async () => unused('bumpShiftRevision'),
    loadPaymentMethod: async () => method(),
    findOpenShiftForCashier: async () => unused('findOpenShiftForCashier'),
    loadPayment: async () => unused('loadPayment'),
    loadPaymentByIdempotencyKey: options.probe,
    loadUserDiscountCaps: async () => unused('loadUserDiscountCaps'),
    loadCouponByCode: async () => unused('loadCouponByCode'),
    insertPayment: async () => unused('insertPayment'),
    voidPayment: async () => unused('voidPayment'),
    refundPayment: async () => unused('refundPayment'),
    setOrderPaymentStatus: async () => {
      options.calls.statusSet = true;
    },
    appendAuditEvidence: async () => unused('appendAuditEvidence'),
    insertOrderDiscount: async () => unused('insertOrderDiscount'),
    incrementCouponUses: async () => unused('incrementCouponUses'),
    findSuccessfulOverrideAttemptId: async () => unused('findSuccessfulOverrideAttemptId'),
    insertPaymentMethod: async () => unused('insertPaymentMethod'),
    updatePaymentMethod: async () => unused('updatePaymentMethod'),
    insertStockMovement: async () => unused('insertStockMovement'),
    loadNonVoidedOrderItemIds: async () => unused('loadNonVoidedOrderItemIds'),
    loadSaleDeductionsForOrderItems: async () => unused('loadSaleDeductionsForOrderItems'),
    loadWasteRefundKeys: async () => unused('loadWasteRefundKeys'),
  };
}

describe('payments idempotency branches (fake store)', () => {
  function setup(firstRunError: Error | undefined, byKey: PaymentRecord | null) {
    const calls = { bumped: false, statusSet: false };
    const probe = vi.fn(async (_tenantId: string, _key: string): Promise<PaymentRecord | null> => byKey);
    const scope = fakeScope({ byKey, calls, probe });
    let runs = 0;
    const store: PaymentsStore = {
      run: async (_tenantId, fn) => {
        runs += 1;
        if (runs === 1 && firstRunError !== undefined) throw firstRunError;
        return fn(scope);
      },
    };
    const engine = new PaymentsEngine({ store, authorization: allowAll });
    return { engine, calls, probe, runs: () => runs };
  }

  it('U1 23505 + probe hit → replays the recorded payment (same id, stored change, live totals)', async () => {
    const { engine } = setup(pgUniqueViolation(), recorded());
    const replay = await engine.recordPayment(T, input());
    expect(replay.payment.id).toBe('pay-b8-unit');
    expect(replay.orderTotalMinor).toBe(4600n);
    expect(replay.remainingBalanceMinor).toBe(0n);
    expect(replay.changeGivenMinor).toBe(0n);
  });

  it('U2 23505 + probe miss → rethrows the ORIGINAL error untouched (foreign failure, never a replay)', async () => {
    const failure = pgUniqueViolation();
    const { engine } = setup(failure, null);
    await expect(engine.recordPayment(T, input())).rejects.toBe(failure);
  });

  it('U3 23505 + probe hit on a DIFFERENT order → 409 (key identifies one operation)', async () => {
    const { engine } = setup(pgUniqueViolation(), recorded({ orderId: 'other-order' }));
    await expect(engine.recordPayment(T, input())).rejects.toMatchObject({
      code: 'conflict',
      message: expect.stringContaining('different order or payment method') as unknown as string,
    });
  });

  it('U4 a non-23505 failure never probes (the probe is 23505-only)', async () => {
    const failure = new ValidationError('boom', 'amountText');
    const { engine, probe } = setup(failure, recorded());
    await expect(engine.recordPayment(T, input())).rejects.toBe(failure);
    expect(probe).not.toHaveBeenCalled();
  });

  it('U5 a key-less 23505 never probes (legacy path fails exactly as before)', async () => {
    const failure = pgUniqueViolation();
    const { engine, probe } = setup(failure, recorded());
    await expect(engine.recordPayment(T, input({ idempotencyKey: null }))).rejects.toBe(failure);
    expect(probe).not.toHaveBeenCalled();
  });

  it('U6 blank / over-long keys are rejected before any store work', async () => {
    const { engine, runs } = setup(undefined, null);
    await expect(engine.recordPayment(T, input({ idempotencyKey: '   ' }))).rejects.toBeInstanceOf(ValidationError);
    await expect(engine.recordPayment(T, input({ idempotencyKey: 'k'.repeat(129) }))).rejects.toBeInstanceOf(ValidationError);
    expect(runs()).toBe(0);
  });

  it('U7 the pre-check hit replays without writing (no bump, no status, no insert)', async () => {
    const insert = vi.fn(async () => unused('insertPayment'));
    const calls = { bumped: false, statusSet: false };
    const probe = vi.fn(async (_tenantId: string, _key: string): Promise<PaymentRecord | null> => recorded());
    const scope: PaymentsTxScope = { ...fakeScope({ byKey: recorded(), calls, probe }), insertPayment: insert };
    const engine = new PaymentsEngine({ store: { run: async (_tid, fn) => fn(scope) }, authorization: allowAll });
    const replay = await engine.recordPayment(T, input());
    expect(replay.payment.id).toBe('pay-b8-unit');
    expect(insert).not.toHaveBeenCalled();
    expect(calls).toEqual({ bumped: false, statusSet: false });
  });

  it('U8 an explicit change that differs from the recorded one → 409', async () => {
    const { engine } = setup(undefined, recorded());
    await expect(engine.recordPayment(T, input({ explicitChangeMinor: 500n }))).rejects.toMatchObject({
      code: 'conflict',
      message: expect.stringContaining('different amount or change') as unknown as string,
    });
  });
});
