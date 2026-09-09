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
  PaymentsTxScope,
} from '../../../domain/contracts/payments.ts';
import type { OrderPaymentStatus } from '../../../domain/contracts/orders.ts';
import { STOCK_QUANTITY_SCALE } from '../../../domain/contracts/inventory.ts';
import type { AuthorizationEngine } from '../rbac/authorization-engine.ts';
import { minorToDecimalText, nonNegativeDecimalTextToMinor, storageMinorUnitDigits } from '../../../shared/decimal-text.ts';
import {
  CashierShiftRequiredError,
  ConflictError,
  NotFoundError,
  PaymentExceedsBalanceError,
  PaymentMethodUnavailableError,
  PaymentStatusTransitionError,
  ValidationError,
} from '../../../shared/errors.ts';
import { convertMoneyAtRate, currencyCode, money } from '../../../shared/money.ts';
import { computeOrderTotals } from './order-totals.ts';

const PAYMENTS_COLLECT_PERMISSION_KEY = 'payments:collect';
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
   * base currency. Scale ≤ the payment currency's ISO 4217 minor-unit digits
   * (B1: the NUMERIC(18,4) columns hold every ISO scale natively).
   */
  readonly amountText: string;
  /** Optional explicit change (base-currency minor units); default: auto-computed from the balance. */
  readonly explicitChangeMinor?: bigint;
  /**
   * B8: optional client-generated idempotency key (opaque, ≤ 128 chars,
   * must not be blank). The FIRST collect with a key inserts; any repeat
   * with the same key replays the recorded payment (no second row). The
   * same key with a different order/amount/method is a 409 Conflict — a key
   * identifies exactly one operation. Absent (null/undefined) = legacy
   * behavior: every call is a new attempt.
   */
  readonly idempotencyKey?: string | null;
}

export interface RecordedPayment {
  readonly payment: PaymentRecord;
  readonly orderTotalMinor: bigint;
  readonly remainingBalanceMinor: bigint;
  /** Change handed back, in branch base currency minor units (0n for non-cash). */
  readonly changeGivenMinor: bigint;
}

const IDEMPOTENCY_KEY_MAX_LENGTH = 128;

/**
 * B8: normalizes the client key. Absent (null/undefined) = legacy path (no
 * idempotency). A blank or over-long key is a client bug → ValidationError
 * (fail-closed: never silently coerce a key).
 */
function normalizeIdempotencyKey(key: string | null | undefined): string | null {
  if (key === null || key === undefined) return null;
  if (key.trim() === '') throw new ValidationError('idempotencyKey must not be blank', 'idempotencyKey');
  if (key.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    throw new ValidationError(`idempotencyKey must be ≤ ${String(IDEMPOTENCY_KEY_MAX_LENGTH)} chars`, 'idempotencyKey');
  }
  return key;
}

/**
 * B8: true only for a raw PostgreSQL unique violation (23505 passes through
 * the B3 mapper by identity, so the code survives). Domain errors never
 * carry a '23505' code — no false positives.
 */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
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
    // B7: the collecting cashier must hold payments:collect (sensitive —
    // money-affecting). Checked before any store work: an unauthorized caller
    // never takes the order lock.
    await this.dependencies.authorization.check({
      tenantId,
      userId: input.cashierUserId,
      permissionKey: PAYMENTS_COLLECT_PERMISSION_KEY,
      context: { hasResource: false, actorBranchId: null, isSensitivePermission: true },
    });
    // B8: null = legacy path (every call a new attempt — returned unwrapped
    // below); otherwise the pre-check inside decides replay-vs-collect, and
    // the catch at the bottom converts a lost uniqueness race into a replay.
    const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
    const collected = this.dependencies.store.run(tenantId, async (scope) => {
      // B2: lock FIRST, then decide. The order lock + revision bump serialize
      // every concurrent mutation of this order (exactly one wins; the loser
      // gets a 40001 serialization failure (retryable: ConcurrencyRetryableError → 503).
      const locked = await scope.lockOrder(tenantId, input.orderId);
      if (locked === null) throw new NotFoundError(`Order ${input.orderId} not found`);
      // B8 pre-check (under the lock, before the bump — a replay mutates
      // nothing, so it consumes no revision). Same-order racers serialize
      // here (the loser replays); the cross-order race (separate order locks)
      // falls through to the 23505 catch below.
      if (idempotencyKey !== null) {
        const existing = await scope.loadPaymentByIdempotencyKey(tenantId, idempotencyKey);
        if (existing !== null) {
          return this.buildReplay(scope, tenantId, existing, input);
        }
      }
      await scope.bumpOrderRevision(tenantId, input.orderId);
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
      // B2: resolve, then lock the shift row (uniform order: orders → shifts)
      // and re-verify OPEN on the LOCKED row — this serializes collect-vs-
      // close so the Z-Report SUM can never miss this payment.
      const gateway = await scope.findOpenShiftForCashier(tenantId, input.cashierUserId, snapshot.branchId);
      if (gateway === null) {
        throw new CashierShiftRequiredError(input.cashierUserId, snapshot.branchId);
      }
      const shift = await scope.lockShift(tenantId, gateway.id);
      if (shift?.status !== 'open') {
        throw new CashierShiftRequiredError(input.cashierUserId, snapshot.branchId);
      }
      await scope.bumpShiftRevision(tenantId, shift.id);

      const totals = computeOrderTotals(snapshot);
      if (totals.remainingBalanceMinor <= 0n) {
        throw new PaymentExceedsBalanceError(0n, totals.remainingBalanceMinor);
      }

      const baseCurrency = currencyCode(snapshot.baseCurrencyCode);
      const baseDigits = storageMinorUnitDigits(baseCurrency);
      const isForeignCash = method.type === 'foreign_currency_cash';
      const isCashLike = method.type === 'cash' || isForeignCash;

      // Gross tendered value in base-currency minor units. The tendered
      // amount is denominated in the PAYMENT currency (B1): parsed and stored
      // at that currency's own ISO scale — never a hardcoded column scale.
      let grossBaseMinor: bigint;
      let tenderedMinor: bigint;
      let tenderedDigits: number;
      let exchangeRateSnapshot: string | null = null;
      if (isForeignCash) {
        if (method.fixedExchangeRate === null || method.currencyCode === null) {
          throw new PaymentMethodUnavailableError(method.id, 'foreign cash method without a fixed rate/currency');
        }
        const foreignCurrency = currencyCode(method.currencyCode);
        tenderedDigits = storageMinorUnitDigits(foreignCurrency);
        tenderedMinor = nonNegativeDecimalTextToMinor(input.amountText, tenderedDigits, 'amount');
        exchangeRateSnapshot = method.fixedExchangeRate;
        grossBaseMinor = convertMoneyAtRate(
          money(tenderedMinor, foreignCurrency),
          method.fixedExchangeRate,
          baseCurrency,
          baseDigits,
          tenderedDigits,
        ).amountMinor;
      } else {
        tenderedDigits = baseDigits;
        tenderedMinor = nonNegativeDecimalTextToMinor(input.amountText, baseDigits, 'amount');
        grossBaseMinor = tenderedMinor;
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
        amount: minorToDecimalText(tenderedMinor, tenderedDigits),
        amountInBaseCurrency: minorToDecimalText(netBaseMinor, baseDigits),
        exchangeRateSnapshot,
        changeGivenAmount: isCashLike && changeMinor > 0n ? minorToDecimalText(changeMinor, baseDigits) : null,
        shiftId: shift.id,
        createdBy: input.cashierUserId,
        idempotencyKey,
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
    if (idempotencyKey === null) return collected;
    return collected.catch((error: unknown) => this.replayAfterConflict(tenantId, idempotencyKey, input, error));
  }

  /**
   * B8: the 23505-catch path. The collect transaction died on a unique
   * violation AFTER the pre-check missed — the only way that happens is a
   * concurrent insert of the same key (the cross-order race: separate order
   * locks, so both pre-checks can miss). The transaction already rolled
   * back (a dead tx cannot be reused), so the probe runs in a FRESH
   * read-only transaction: key found + params match → replay the recorded
   * payment; key missing (some other unique violation) → rethrow the
   * ORIGINAL error untouched (never convert a foreign failure into a replay).
   */
  private async replayAfterConflict(
    tenantId: string,
    idempotencyKey: string,
    input: RecordPaymentInput,
    error: unknown,
  ): Promise<RecordedPayment> {
    if (!isUniqueViolation(error)) throw error;
    const replay = await this.dependencies.store.run(tenantId, async (scope) => {
      const existing = await scope.loadPaymentByIdempotencyKey(tenantId, idempotencyKey);
      if (existing === null) return null;
      return this.buildReplay(scope, tenantId, existing, input);
    });
    if (replay === null) throw error;
    return replay;
  }

  /**
   * B8: rebuilds the collect response for an already-recorded payment. The
   * payment ROW is the original (same id, same stored change); the totals
   * are recomputed from the CURRENT snapshot (a replay mutates nothing, so
   * live figures are the honest ones). Read-only: no revision bump, no
   * status write, and no gate re-run (shift/method/status already passed at
   * the original collect — a replay moves no money). A key identifies
   * exactly one operation: order/method/tendered must match (plus the
   * explicit change when the caller names one), else 409.
   */
  private async buildReplay(
    scope: PaymentsTxScope,
    tenantId: string,
    existing: PaymentRecord,
    input: RecordPaymentInput,
  ): Promise<RecordedPayment> {
    // No I/O yet: order + method are compared first so a cross-order key
    // reuse fails without touching the snapshot.
    if (existing.orderId !== input.orderId || existing.paymentMethodId !== input.paymentMethodId) {
      throw new ConflictError(
        `idempotencyKey '${existing.idempotencyKey ?? ''}' was already collected for a different order or payment method`,
      );
    }
    const snapshot = await scope.loadOrderFinancialSnapshot(tenantId, input.orderId);
    if (snapshot === null) throw new NotFoundError(`Order ${input.orderId} not found`);
    const method = await scope.loadPaymentMethod(tenantId, input.paymentMethodId);
    if (method === null) throw new PaymentMethodUnavailableError(input.paymentMethodId, 'unknown or inactive');
    // The tendered minor units must match (parsed, not string-compared —
    // '46' and '46.00' are the same tender). When the caller names an
    // explicit change it must equal the recorded one; an omitted change
    // replays the original as-is.
    const baseDigits = storageMinorUnitDigits(currencyCode(snapshot.baseCurrencyCode));
    const tenderedDigits =
      method.type === 'foreign_currency_cash' && method.currencyCode !== null
        ? storageMinorUnitDigits(currencyCode(method.currencyCode))
        : baseDigits;
    const expectedTenderedMinor = nonNegativeDecimalTextToMinor(input.amountText, tenderedDigits, 'amount');
    const recordedTenderedMinor = nonNegativeDecimalTextToMinor(existing.amount, tenderedDigits, 'amount');
    const recordedChangeMinor =
      existing.changeGivenAmount === null
        ? 0n
        : nonNegativeDecimalTextToMinor(existing.changeGivenAmount, baseDigits, 'changeGivenAmount');
    if (
      expectedTenderedMinor !== recordedTenderedMinor ||
      (input.explicitChangeMinor !== undefined && input.explicitChangeMinor !== recordedChangeMinor)
    ) {
      throw new ConflictError(
        `idempotencyKey '${existing.idempotencyKey ?? ''}' was already collected with a different amount or change`,
      );
    }
    const totals = computeOrderTotals(snapshot);
    return {
      payment: existing,
      orderTotalMinor: totals.totalMinor,
      remainingBalanceMinor: totals.remainingBalanceMinor,
      changeGivenMinor: recordedChangeMinor,
    };
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
      // B2: lock FIRST, then decide — and re-read the payment UNDER the lock.
      // The pre-read above (its own transaction) is a fail-fast only; the
      // order lock + revision bump serialize every concurrent mutation of
      // this order (exactly one wins; the loser gets a 40001 serialization
      // failure (retryable: ConcurrencyRetryableError → 503), so the re-check below closes the
      // double-void/double-refund race the blind store UPDATE cannot see.
      const locked = await scope.lockOrder(tenantId, existing.orderId);
      if (locked === null) throw new NotFoundError(`Order ${existing.orderId} not found`);
      await scope.bumpOrderRevision(tenantId, existing.orderId);
      const fresh = await scope.loadPayment(tenantId, paymentId);
      if (fresh === null) throw new NotFoundError(`Payment ${paymentId} not found`);
      if (fresh.status !== 'completed') {
        throw new PaymentStatusTransitionError(fresh.status, to);
      }
      // The reversal's drawer impact must land on a standing OPEN shift at
      // the ORIGINAL ORDER's branch — never on whatever open shift the
      // acting cashier may hold at ANOTHER branch. Fail closed with the
      // explicit gateway error when no same-branch open shift exists.
      const pre = await scope.loadOrderFinancialSnapshot(tenantId, existing.orderId);
      if (pre === null) throw new NotFoundError(`Order ${existing.orderId} not found`);
      const reversalShift = await scope.findOpenShiftForCashier(tenantId, actorUserId, pre.branchId);
      if (reversalShift === null) {
        throw new CashierShiftRequiredError(actorUserId, pre.branchId);
      }

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

      // FRESH snapshot AFTER the lifecycle write, so the payment-status
      // recompute sees the updated payments.
      const snapshot = await scope.loadOrderFinancialSnapshot(tenantId, existing.orderId);
      if (snapshot === null) throw new NotFoundError(`Order ${existing.orderId} not found`);
      const totals = computeOrderTotals(snapshot);
      await scope.setOrderPaymentStatus(tenantId, existing.orderId, nextOrderPaymentStatus(totals, snapshot));
      if (to === 'refunded') {
        // Phase-9 stock: a refunded order is waste, never restocked — same
        // transaction as the lifecycle change. (Payment VOIDs are cashier
        // corrections on a standing order: no stock effect by design.)
        await this.writeRefundWaste(scope, tenantId, pre.branchId, existing.orderId, actorUserId);
      }
      return updated;
    });
  }

  /**
   * Phase-9 refund stock: one zero-delta waste_refund line per deducted
   * component of every LIVE (non-voided) line — voided lines were already
   * restored-or-wasted by the void path. NOT EXISTS-guarded, so refunding a
   * second payment on the same order adds no duplicate waste lines.
   */
  private async writeRefundWaste(
    scope: PaymentsTxScope,
    tenantId: string,
    branchId: string,
    orderId: string,
    actorUserId: string,
  ): Promise<void> {
    const itemIds = await scope.loadNonVoidedOrderItemIds(tenantId, orderId);
    if (itemIds.length === 0) return;
    const deductions = await scope.loadSaleDeductionsForOrderItems(tenantId, itemIds);
    if (deductions.length === 0) return;
    const recorded = new Set(
      (await scope.loadWasteRefundKeys(tenantId, orderId)).map((key) => `${key.orderItemId}:${key.inventoryItemId}`),
    );
    const occurredAt = new Date();
    for (const deduction of deductions) {
      if (recorded.has(`${deduction.orderItemId}:${deduction.inventoryItemId}`)) continue;
      await scope.insertStockMovement(tenantId, {
        branchId,
        inventoryItemId: deduction.inventoryItemId,
        movementType: 'waste_refund',
        quantityDelta: minorToDecimalText(0n, STOCK_QUANTITY_SCALE),
        orderId,
        orderItemId: deduction.orderItemId,
        actorUserId,
        managerOverrideId: null,
        occurredAt,
      });
    }
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
