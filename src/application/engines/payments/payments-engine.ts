/**
 * Payments engine (Phase 8).
 *
 * recordPayment — ONE transaction: resolve the cashier's OPEN shift at the
 * order's branch (the shift gateway — no standing open shift, no payment),
 * compute the order totals with the binding pseudocode (discounts, then the
 * Phase-6 engine on the discounted base), take the tendered amount, convert
 * foreign-currency cash through the method's MANUAL fixed rate (the snapshot
 * is frozen forever by the DB guard), give change ALWAYS in the branch base
 * currency, insert the completed payment and — when the balance reaches
 * zero — move orders.payment_status to 'paid'.
 *
 * amount_in_base_currency is NET of change: it is the figure that counts
 * toward the remaining balance and toward the shift's recorded_cash_sales.
 * Card/wallet/other collect exactly their amount (no change, no rate); cash
 * may over-tender and receive change; a payment can never collect more than
 * the remaining balance (PaymentExceedsBalanceError, fail-closed).
 *
 * voidPayment / refundPayment — the lifecycle legs: completed → voided
 * (payments:void, full void evidence triple) and completed → refunded
 * (payments:refund, the spec-mandated sensitive key; the spec's column list
 * has no refunded_by columns, so refund evidence goes to the Phase-4
 * audit_log). Both are only possible while the shift is still OPEN (a closed
 * shift's Z-Report numbers are final), and the order's payment_status is
 * recomputed afterwards (back to 'open' for re-collection, or 'refunded'
 * when every payment of the order has been refunded).
 */

import { randomUUID } from 'node:crypto';
import type {
  OrderFinancialSnapshot,
  PaymentActor,
  PaymentRecord,
  PaymentsStore,
} from '../../../domain/contracts/payments.ts';
import type { OrderPaymentStatus } from '../../../domain/contracts/orders.ts';
import type { AuthorizationEngine } from '../rbac/authorization-engine.ts';
import { minorToDecimalText, nonNegativeDecimalTextToMinor } from '../../../shared/decimal-text.ts';
import {
  CashierShiftRequiredError,
  NotFoundError,
  PaymentExceedsBalanceError,
  PaymentMethodUnavailableError,
  PaymentStatusTransitionError,
  ValidationError,
} from '../../../shared/errors.ts';
import { convertMoneyAtRate, currencyCode, minorUnitScale, money } from '../../../shared/money.ts';
import { computeOrderTotals } from './order-totals.ts';

const PAYMENTS_VOID_PERMISSION_KEY = 'payments:void';
const PAYMENTS_REFUND_PERMISSION_KEY = 'payments:refund';

export interface PaymentsEngineDependencies {
  readonly store: PaymentsStore;
  readonly authorization: Pick<AuthorizationEngine, 'check'>;
}

export interface RecordPaymentInput {
  readonly orderId: string;
  readonly paymentMethodId: string;
  /** The cashier collecting the payment — must hold the standing OPEN shift at the order's branch. */
  readonly cashierUserId: string;
  /**
   * The tendered amount as canonical decimal text, in the payment currency:
   * the method's foreign currency for foreign_currency_cash, else the branch
   * base currency. Scale ≤ 2 fraction digits (the NUMERIC(18,2) column).
   */
  readonly amountText: string;
  /** Optional explicit change (base-currency minor units); default: auto-computed from the balance. */
  readonly explicitChangeMinor?: bigint;
}

export interface RecordedPayment {
  readonly payment: PaymentRecord;
  readonly orderTotalMinor: bigint;
  readonly remainingBalanceMinor: bigint;
  /** Change handed back, in branch base currency minor units (0n for non-cash). */
  readonly changeGivenMinor: bigint;
}

export class PaymentsEngine {
  private readonly dependencies: PaymentsEngineDependencies;

  constructor(dependencies: PaymentsEngineDependencies) {
    this.dependencies = dependencies;
  }

  /** Read-only totals for one order (the binding pseudocode, steps 1–8). */
  async orderTotals(tenantId: string, orderId: string): Promise<ReturnType<typeof computeOrderTotals>> {
    return this.dependencies.store.run(tenantId, async (scope) => {
      const snapshot = await scope.loadOrderFinancialSnapshot(tenantId, orderId);
      if (snapshot === null) throw new NotFoundError(`Order ${orderId} not found`);
      return computeOrderTotals(snapshot);
    });
  }

  async recordPayment(tenantId: string, input: RecordPaymentInput): Promise<RecordedPayment> {
    return this.dependencies.store.run(tenantId, async (scope) => {
      const snapshot = await scope.loadOrderFinancialSnapshot(tenantId, input.orderId);
      if (snapshot === null) throw new NotFoundError(`Order ${input.orderId} not found`);
      if (snapshot.paymentStatus === 'refunded' || snapshot.paymentStatus === 'refund_pending') {
        throw new ValidationError(`A ${snapshot.paymentStatus} order cannot take a new payment`, 'orderId');
      }

      const method = await scope.loadPaymentMethod(tenantId, input.paymentMethodId);
      if (!method?.isActive) {
        throw new PaymentMethodUnavailableError(input.paymentMethodId, 'unknown or inactive');
      }
      if (method.branchId !== null && method.branchId !== snapshot.branchId) {
        throw new PaymentMethodUnavailableError(input.paymentMethodId, 'not available at the order branch');
      }

      // The shift GATEWAY: the collecting cashier must hold the standing OPEN
      // shift at the order's branch (the DB trigger re-verifies structurally).
      const shift = await scope.findOpenShiftForCashier(tenantId, input.cashierUserId, snapshot.branchId);
      if (shift === null) {
        throw new CashierShiftRequiredError(input.cashierUserId, snapshot.branchId);
      }

      const totals = computeOrderTotals(snapshot);
      if (totals.remainingBalanceMinor <= 0n) {
        throw new PaymentExceedsBalanceError(0n, totals.remainingBalanceMinor);
      }

      const baseCurrency = currencyCode(snapshot.baseCurrencyCode);
      const baseDigits = minorUnitScale(baseCurrency);
      const isForeignCash = method.type === 'foreign_currency_cash';
      const isCashLike = method.type === 'cash' || isForeignCash;

      // Gross tendered value in base-currency minor units.
      let grossBaseMinor: bigint;
      let exchangeRateSnapshot: string | null = null;
      if (isForeignCash) {
        if (method.fixedExchangeRate === null || method.currencyCode === null) {
          throw new PaymentMethodUnavailableError(method.id, 'foreign cash method without a fixed rate/currency');
        }
        // Payment amounts are stored at NUMERIC(18,2) — the source scale of
        // the conversion is the COLUMN scale (2), whatever the currency's ISO
        // minor-unit digits.
        const tenderedAtColumnScale = nonNegativeDecimalTextToMinor(input.amountText, 2, 'amount');
        exchangeRateSnapshot = method.fixedExchangeRate;
        grossBaseMinor = convertMoneyAtRate(
          money(tenderedAtColumnScale, currencyCode(method.currencyCode)),
          method.fixedExchangeRate,
          baseCurrency,
          baseDigits,
          2,
        ).amountMinor;
      } else {
        grossBaseMinor = nonNegativeDecimalTextToMinor(input.amountText, baseDigits, 'amount');
      }

      // Change: always in the branch base currency, only on cash methods.
      let changeMinor = 0n;
      if (isCashLike) {
        const excess = grossBaseMinor - totals.remainingBalanceMinor;
        changeMinor = excess > 0n ? excess : 0n;
        if (input.explicitChangeMinor !== undefined) {
          if (input.explicitChangeMinor < 0n) throw new ValidationError('Change cannot be negative', 'explicitChangeMinor');
          if (input.explicitChangeMinor > grossBaseMinor) throw new ValidationError('Change cannot exceed the tendered amount', 'explicitChangeMinor');
          changeMinor = input.explicitChangeMinor;
        }
      } else if (input.explicitChangeMinor !== undefined && input.explicitChangeMinor !== 0n) {
        throw new ValidationError('Change is only given on cash methods', 'explicitChangeMinor');
      }

      const netBaseMinor = grossBaseMinor - changeMinor;
      if (netBaseMinor <= 0n) {
        throw new ValidationError('The net collected amount must be greater than zero', 'amountText');
      }
      if (netBaseMinor > totals.remainingBalanceMinor) {
        throw new PaymentExceedsBalanceError(netBaseMinor, totals.remainingBalanceMinor);
      }

      const payment = await scope.insertPayment(tenantId, {
        id: randomUUID(),
        orderId: input.orderId,
        paymentMethodId: method.id,
        amount: minorToDecimalText(nonNegativeDecimalTextToMinor(input.amountText, 2, 'amount'), 2),
        amountInBaseCurrency: minorToDecimalText(netBaseMinor, 2),
        exchangeRateSnapshot,
        changeGivenAmount: isCashLike && changeMinor > 0n ? minorToDecimalText(changeMinor, 2) : null,
        shiftId: shift.id,
        createdBy: input.cashierUserId,
      });

      const remainingAfter = totals.remainingBalanceMinor - netBaseMinor;
      if (remainingAfter === 0n) {
        await scope.setOrderPaymentStatus(tenantId, input.orderId, 'paid');
      }
      return {
        payment,
        orderTotalMinor: totals.totalMinor,
        remainingBalanceMinor: remainingAfter,
        changeGivenMinor: changeMinor,
      };
    });
  }

  async voidPayment(tenantId: string, actor: PaymentActor, input: { paymentId: string; reason: string }): Promise<PaymentRecord> {
    await this.dependencies.authorization.check({
      tenantId,
      userId: actor.userId,
      permissionKey: PAYMENTS_VOID_PERMISSION_KEY,
      tokenSecV: actor.tokenSecV,
      context: { hasResource: false, actorBranchId: null, isSensitivePermission: true },
    });
    return this.lifecycleChange(tenantId, actor.userId, input.paymentId, 'voided', input.reason);
  }

  async refundPayment(tenantId: string, actor: PaymentActor, input: { paymentId: string }): Promise<PaymentRecord> {
    await this.dependencies.authorization.check({
      tenantId,
      userId: actor.userId,
      permissionKey: PAYMENTS_REFUND_PERMISSION_KEY,
      tokenSecV: actor.tokenSecV,
      context: { hasResource: false, actorBranchId: null, isSensitivePermission: true },
    });
    return this.lifecycleChange(tenantId, actor.userId, input.paymentId, 'refunded', null);
  }

  private async lifecycleChange(
    tenantId: string,
    actorUserId: string,
    paymentId: string,
    to: 'voided' | 'refunded',
    voidReason: string | null,
  ): Promise<PaymentRecord> {
    const existing = await this.dependencies.store.run(tenantId, async (scope) => scope.loadPayment(tenantId, paymentId));
    if (existing === null) throw new NotFoundError(`Payment ${paymentId} not found`);
    if (existing.status !== 'completed') {
      throw new PaymentStatusTransitionError(existing.status, to);
    }

    return this.dependencies.store.run(tenantId, async (scope) => {
      const updated =
        to === 'voided'
          ? await scope.voidPayment(tenantId, paymentId, {
              voidedById: actorUserId,
              voidedAt: new Date(),
              voidReason: voidReason ?? '',
            })
          : await scope.refundPayment(tenantId, paymentId);

      await scope.appendAuditEvidence(tenantId, {
        userId: actorUserId,
        action: to === 'voided' ? 'payments.void' : 'payments.refund',
        resource: `payments/${paymentId}`,
        before: { status: existing.status },
        after: { status: to },
      });

      const snapshot = await scope.loadOrderFinancialSnapshot(tenantId, existing.orderId);
      if (snapshot === null) throw new NotFoundError(`Order ${existing.orderId} not found`);
      const totals = computeOrderTotals(snapshot);
      await scope.setOrderPaymentStatus(tenantId, existing.orderId, nextOrderPaymentStatus(totals, snapshot));
      return updated;
    });
  }
}

/**
 * The order's payment status after a payment lifecycle change:
 *   paid    — the completed payments still cover the total;
 *   refunded — EVERY payment of the order is refunded (full return of funds);
 *   open    — anything else (re-collection required).
 * ('refund_pending' stays reserved for the future partial-refund flow.)
 */
export function nextOrderPaymentStatus(
  totals: ReturnType<typeof computeOrderTotals>,
  snapshot: OrderFinancialSnapshot,
): OrderPaymentStatus {
  if (totals.remainingBalanceMinor <= 0n) return 'paid';
  if (snapshot.paymentStatuses.length > 0 && snapshot.paymentStatuses.every((status) => status === 'refunded')) {
    return 'refunded';
  }
  return 'open';
}
