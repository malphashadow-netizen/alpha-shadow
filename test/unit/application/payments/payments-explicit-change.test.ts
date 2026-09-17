import { describe, expect, it, vi } from 'vitest';

import { PaymentsEngine, type RecordPaymentInput } from '../../../../src/application/engines/payments/payments-engine.ts';
import type { AuthorizationEngine } from '../../../../src/application/engines/rbac/authorization-engine.ts';
import type { OrderFinancialSnapshot, PaymentRecord, PaymentsStore, PaymentsTxScope } from '../../../../src/domain/contracts/payments.ts';
import { ValidationError } from '../../../../src/shared/errors.ts';

const TENANT = 'tenant-change';
const ORDER = 'order-change';
const METHOD = 'method-change';
const CASHIER = 'cashier-change';

const snapshot: OrderFinancialSnapshot = {
  orderId: ORDER, branchId: 'branch-change', baseCurrencyCode: 'SAR', paymentStatus: 'open', roundingStrategy: null,
  lines: [{ orderItemId: 'line-change', lineAmountMinor: 4600n, taxPlan: [] }], discounts: [],
  completedPaymentsMinor: 0n, paymentStatuses: [],
};

function input(explicitChangeMinor: bigint): RecordPaymentInput {
  return { orderId: ORDER, paymentMethodId: METHOD, cashierUserId: CASHIER, amountText: '50.00', explicitChangeMinor };
}

function createEngine() {
  const inserted = vi.fn();
  const scope = {
    loadOrderFinancialSnapshot: async () => snapshot,
    lockOrder: async () => ({ id: ORDER }),
    bumpOrderRevision: async () => undefined,
    loadPaymentByIdempotencyKey: async () => null,
    loadPaymentMethod: async () => ({ id: METHOD, tenantId: TENANT, branchId: null, name: 'cash', type: 'cash', currencyCode: null, fixedExchangeRate: null, clearingAccountSystemPurpose: 'cash_on_hand', isActive: true }),
    findOpenShiftForCashier: async () => ({ id: 'shift-change' }),
    lockShift: async () => ({ id: 'shift-change', status: 'open' }),
    bumpShiftRevision: async () => undefined,
    insertPayment: inserted.mockImplementation(async (tenantId: string, payment: PaymentRecord): Promise<PaymentRecord> => ({ ...payment, tenantId, status: 'completed', voidedById: null, voidedAt: null, voidReason: null, createdAt: new Date(0) })),
    postPaymentJournalEntry: async () => undefined,
    setOrderPaymentStatus: async () => undefined,
  } as unknown as PaymentsTxScope;
  const store: PaymentsStore = { run: async <T>(_tenantId: string, fn: (transactionScope: PaymentsTxScope) => Promise<T>): Promise<T> => fn(scope) };
  const authorization: Pick<AuthorizationEngine, 'check'> = { check: async () => ({ allowed: true, effectiveMaxAmountMinorUnits: null }) };
  return { engine: new PaymentsEngine({ store, authorization }), inserted };
}

describe('PaymentsEngine explicit change', () => {
  it('rejects smaller and larger change than the calculated excess without inserting a payment', async () => {
    const { engine, inserted } = createEngine();
    for (const explicitChangeMinor of [300n, 500n]) {
      await expect(engine.recordPayment(TENANT, input(explicitChangeMinor))).rejects.toMatchObject({
        code: 'validation.failed', field: 'explicitChangeMinor', message: expect.stringContaining('calculated change of 400') as unknown as string,
      });
    }
    expect(inserted).not.toHaveBeenCalled();
  });

  it('accepts explicit change exactly equal to the calculated excess', async () => {
    const { engine, inserted } = createEngine();
    const recorded = await engine.recordPayment(TENANT, input(400n));
    expect(recorded.changeGivenMinor).toBe(400n);
    expect(recorded.remainingBalanceMinor).toBe(0n);
    expect(inserted).toHaveBeenCalledOnce();
  });
});
