/**
 * Payments engine — Phase 7 leaves ONLY the explicit fail-closed hook.
 *
 * The real payment/reversal machinery (Void Payment → Reopen → Void Item →
 * re-collection, refunds, gateways) is a deliberately deferred future phase —
 * the same placeholder discipline as ZATCA. Until it exists, this module
 * exposes exactly one behavior: refusing, loudly and explicitly, any void on
 * an order whose payment_status is not 'open'. It is NEVER an implicit zero,
 * an unconditional allow, or a silent skip.
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
