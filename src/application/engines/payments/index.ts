/**
 * Payments engine — Phase 8.
 *
 * Phase 7 left ONLY the explicit fail-closed hook
 * (assertVoidAllowedUnderPaymentStatus): a void on a non-open order was
 * ALWAYS PaymentReversalRequiredError because the payments engine did not
 * exist. Phase 8 builds it — payments, payment methods, discounts, coupons
 * and the shift gateway — and that hook now has a real engine behind it:
 * the Void Payment → Reopen → Void Item → re-collection sequence is
 * voidPayment (order returns to 'open') followed by the Phase-7 void engine.
 * The hook itself is kept byte-for-byte: the void engine still refuses any
 * void on a non-open order, whatever this module grows into.
 */
import type { OrderPaymentStatus } from '../../../domain/contracts/orders.ts';
import { PaymentReversalRequiredError } from '../../../shared/errors.ts';

/**
 * The Phase-7 payments boundary. Called by the void engine BEFORE any audit
 * row is written, and enforced again structurally by the order_voids
 * validation trigger at the database level (whatever the code path).
 */
export function assertVoidAllowedUnderPaymentStatus(paymentStatus: OrderPaymentStatus): void {
  if (paymentStatus !== 'open') {
    throw new PaymentReversalRequiredError(paymentStatus);
  }
}

export { PaymentReversalRequiredError };

export { PaymentsEngine } from './payments-engine.ts';
export type { RecordPaymentInput, RecordedPayment, PaymentsEngineDependencies } from './payments-engine.ts';
export { nextOrderPaymentStatus } from './payments-engine.ts';
export { DiscountEngine } from './discount-engine.ts';
export type { ApplyDiscountInput, DiscountEngineDependencies } from './discount-engine.ts';
export { PaymentMethodsEngine } from './payment-methods-engine.ts';
export {
  applyDiscountStages,
  computeDiscountStage,
  discountOverrideRequirement,
  parseDiscountCaps,
  parseDiscountRequest,
} from './discount-math.ts';
export type {
  DiscountStageComputation,
  DiscountOverrideReason,
  ParsedDiscountCaps,
  ParsedDiscountRequest,
  StackedDiscountStage,
  StackedDiscountStageResult,
} from './discount-math.ts';
export { computeOrderTotals, allocateProportionally } from './order-totals.ts';
export type { OrderTotalsComputation } from './order-totals.ts';
