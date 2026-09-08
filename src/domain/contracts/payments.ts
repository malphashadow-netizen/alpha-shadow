/**
 * Phase 8 domain contracts — payments, discounts, coupons, payment methods
 * and shift reconciliations.
 *
 * Pure types + ports only (zero dependencies outside domain/shared, same
 * rules as every other file in domain/contracts). The application engines
 * depend on these ports; the PostgreSQL adapters implement them through
 * withTenantContext().
 *
 * Core fail-closed principles encoded here:
 *   * Every payment is bound to a standing OPEN shift of its collecting
 *     cashier at the order's branch (the shift gateway) — structurally
 *     enforced by the payments validation trigger, whatever the code path.
 *   * payments.exchange_rate_snapshot is frozen at tender time and is
 *     immutable forever afterwards.
 *   * Change is ALWAYS given in the branch base currency; foreign currency is
 *     cash-only with a manual fixed rate (no live FX API — deferred).
 *   * The discount order of calculation is BINDING (see the application
 *     engine's discount-math): requested → MIN(requested, subtotal) →
 *     zero-out/cap escalation → tax on the discounted base → total →
 *     remaining balance.
 *   * A shift is born 'open' atomically with its open cash count and dual
 *     verification; the Z Report is the only close; after close the row is
 *     immutable; the X Report is read-only by contract.
 *
 * NUMERIC columns cross this boundary as canonical decimal STRINGS (the
 * exact PostgreSQL text form, e.g. '123.45') — never JavaScript numbers.
 * Conversion to/from BigInt minor units happens once, inside the application
 * engines, with the currency scale stated explicitly at each call site.
 */

import type { ManagerOverrideContextType } from './orders.ts';
import type {
  InsertStockMovementInput,
  SaleDeductionAggregate,
  StockMovementRecord,
  WasteRefundKey,
} from './inventory.ts';

// ── Vocabularies (fixed by the Phase-8 spec) ───────────────────────────────

export type PaymentMethodType = 'cash' | 'card' | 'wallet' | 'foreign_currency_cash' | 'other';
export type PaymentStatus = 'completed' | 'voided' | 'refunded';
export type DiscountMechanism = 'coupon' | 'manual' | 'points';
export type DiscountKind = 'percentage' | 'fixed_amount';
export type ShiftStatus = 'open' | 'closed';
export type VarianceType = 'overage' | 'shortage' | 'exact';
export type CashCountType = 'open' | 'close';

// ── Records (NUMERIC columns as canonical decimal text) ────────────────────

export interface PaymentMethodRecord {
  readonly id: string;
  readonly tenantId: string;
  /** NULL = available in every branch of the tenant. */
  readonly branchId: string | null;
  readonly name: string;
  readonly type: PaymentMethodType;
  readonly currencyCode: string | null;
  readonly fixedExchangeRate: string | null;
  readonly isActive: boolean;
}

export interface PaymentRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly orderId: string;
  readonly paymentMethodId: string;
  /** Tendered amount, in the payment currency (the method's currency for foreign cash, else the branch base). */
  readonly amount: string;
  /** NET applied amount in the branch base currency (tendered − change), what counts toward the order balance. */
  readonly amountInBaseCurrency: string;
  readonly exchangeRateSnapshot: string | null;
  readonly changeGivenAmount: string | null;
  readonly status: PaymentStatus;
  readonly shiftId: string;
  readonly createdBy: string;
  readonly voidedById: string | null;
  readonly voidedAt: Date | null;
  readonly voidReason: string | null;
  readonly createdAt: Date;
}

export interface CouponRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly code: string;
  readonly discountKind: DiscountKind;
  readonly discountValue: string;
  readonly minOrderAmount: string | null;
  readonly maxUses: number | null;
  readonly usesCount: number;
  readonly expiresAt: Date | null;
  readonly isActive: boolean;
}

export interface OrderDiscountRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly orderId: string;
  readonly mechanism: DiscountMechanism;
  readonly couponId: string | null;
  readonly discountKind: DiscountKind;
  readonly discountValue: string;
  readonly discountAmountApplied: string;
  readonly requiredManagerOverride: boolean;
  readonly managerOverrideAttemptId: string | null;
  readonly appliedBy: string;
  readonly createdAt: Date;
}

export interface ShiftRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly branchId: string;
  readonly cashierId: string;
  readonly openedById: string;
  readonly openVerifiedById: string;
  readonly openedAt: Date;
  readonly startingFloat: string;
  readonly status: ShiftStatus;
  readonly closedById: string | null;
  readonly closeVerifiedById: string | null;
  readonly closedAt: Date | null;
  readonly countedCash: string | null;
  readonly recordedCashSales: string | null;
  readonly variance: string | null;
  readonly varianceType: VarianceType | null;
  readonly notes: string | null;
  readonly createdAt: Date;
}

export interface CashCountDetailRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly shiftReconciliationId: string;
  readonly countType: CashCountType;
  readonly denominationValue: string;
  readonly quantity: number;
  readonly subtotal: string;
  readonly createdAt: Date;
}

/** One denomination line of a cash count (denomination value as decimal text × quantity). */
export interface CashCountLineInput {
  readonly denominationValue: string;
  readonly quantity: number;
}

/** The actor taking/voiding/refunding a payment (same shape as the void engine's VoidActor). */
export interface PaymentActor {
  readonly userId: string;
  readonly tokenSecV: string;
}

/** The live manager-override challenge (Phase-7b authenticator, unmodified). */
export interface ManagerOverrideChallengeInput {
  readonly managerUserId: string;
  readonly managerOverridePin: string;
}

// ── Order financial snapshot (the totals engine's read model) ───────────────

export type OrderRoundingStrategy = 'per_line' | 'invoice_total';

/**
 * One line of a stored Phase-6 tax plan, reconstructed from the immutable
 * order_line_tax_snapshots (+ the rate's category cascade priority) so the
 * Phase-6 cascading engine can be re-run on the DISCOUNTED line bases.
 */
export interface OrderLineTaxPlanLine {
  readonly taxRateId: string;
  readonly taxFamily: 'vat' | 'excise';
  readonly cascadePriority: number;
  readonly rateBps: number;
  readonly isPriceInclusive: boolean;
}

export interface OrderLineForTotals {
  readonly orderItemId: string;
  /** unit_price_minor × quantity of the ACTIVE (non-voided) line. */
  readonly lineAmountMinor: bigint;
  /** Empty = the line carries no restaurant tax lines (marketplace-external liability). */
  readonly taxPlan: readonly OrderLineTaxPlanLine[];
}

export interface OrderFinancialSnapshot {
  readonly orderId: string;
  readonly branchId: string;
  readonly baseCurrencyCode: string;
  readonly paymentStatus: 'open' | 'paid' | 'refund_pending' | 'refunded';
  readonly roundingStrategy: OrderRoundingStrategy | null;
  readonly lines: readonly OrderLineForTotals[];
  readonly discounts: readonly OrderDiscountRecord[];
  /** SUM(amount_in_base_currency) of completed payments, in base minor units. */
  readonly completedPaymentsMinor: bigint;
  /** The live status of every payment row on the order (for lifecycle recomputes). */
  readonly paymentStatuses: readonly PaymentStatus[];
}

/** The per-user dynamic discount caps (user_discount_limits). NULL = dimension not granted. */
export interface UserDiscountCaps {
  readonly maxDiscountPercentage: string | null;
  readonly maxDiscountFixedAmount: string | null;
}

// ── The payments store port (one transaction per use case) ─────────────────

export interface NewPaymentMethodInput {
  readonly name: string;
  readonly type: PaymentMethodType;
  readonly branchId: string | null;
  readonly currencyCode: string | null;
  readonly fixedExchangeRate: string | null;
  readonly isActive: boolean;
}

export interface UpdatePaymentMethodInput {
  readonly name?: string;
  readonly isActive?: boolean;
  readonly fixedExchangeRate?: string;
}

export interface InsertPaymentInput {
  readonly id: string;
  readonly orderId: string;
  readonly paymentMethodId: string;
  readonly amount: string;
  readonly amountInBaseCurrency: string;
  readonly exchangeRateSnapshot: string | null;
  readonly changeGivenAmount: string | null;
  readonly shiftId: string;
  readonly createdBy: string;
}

export interface InsertOrderDiscountInput {
  readonly id: string;
  readonly orderId: string;
  readonly mechanism: DiscountMechanism;
  readonly couponId: string | null;
  readonly discountKind: DiscountKind;
  readonly discountValue: string;
  readonly discountAmountApplied: string;
  readonly requiredManagerOverride: boolean;
  readonly managerOverrideAttemptId: string | null;
  readonly appliedBy: string;
}

export interface AuditEvidenceInput {
  readonly userId: string;
  readonly action: string;
  readonly resource: string;
  readonly before: Readonly<Record<string, unknown>>;
  readonly after: Readonly<Record<string, unknown>>;
}

export interface PaymentsTxScope {
  // Reads for the totals/gateway engine.
  loadOrderFinancialSnapshot(tenantId: string, orderId: string): Promise<OrderFinancialSnapshot | null>;
  /**
   * B2: SELECT … FOR UPDATE on the orders row — the FIRST statement of every
   * order-mutating payments transaction (uniform lock order: orders →
   * shift_reconciliations; see OrdersTxScope.lockOrder). Returns the locked
   * id, or null when the order does not exist. Always followed by
   * bumpOrderRevision before any decision read.
   */
  lockOrder(tenantId: string, orderId: string): Promise<{ id: string } | null>;
  /** B2: UPDATE orders SET revision = revision + 1 (see OrdersTxScope.bumpOrderRevision). */
  bumpOrderRevision(tenantId: string, orderId: string): Promise<void>;
  /**
   * B2: SELECT … FOR UPDATE on a shift_reconciliations row — taken (after
   * the order lock) by collect, and FIRST by close. Always followed by
   * bumpShiftRevision; serializes close-vs-collect so the Z-Report SUM can
   * never miss a concurrent payment (the loser gets ConcurrencyRetryableError → 503).
   */
  lockShift(tenantId: string, shiftId: string): Promise<ShiftRecord | null>;
  /** B2: UPDATE shift_reconciliations SET revision = revision + 1. */
  bumpShiftRevision(tenantId: string, shiftId: string): Promise<void>;
  loadPaymentMethod(tenantId: string, paymentMethodId: string): Promise<PaymentMethodRecord | null>;
  findOpenShiftForCashier(tenantId: string, cashierUserId: string, branchId: string): Promise<ShiftRecord | null>;
  loadPayment(tenantId: string, paymentId: string): Promise<PaymentRecord | null>;
  loadUserDiscountCaps(tenantId: string, userId: string): Promise<UserDiscountCaps | null>;
  loadCouponByCode(tenantId: string, code: string): Promise<CouponRecord | null>;

  // Payment lifecycle writes.
  insertPayment(tenantId: string, payment: InsertPaymentInput): Promise<PaymentRecord>;
  voidPayment(tenantId: string, paymentId: string, evidence: { voidedById: string; voidedAt: Date; voidReason: string }): Promise<PaymentRecord>;
  refundPayment(tenantId: string, paymentId: string): Promise<PaymentRecord>;
  setOrderPaymentStatus(tenantId: string, orderId: string, paymentStatus: 'open' | 'paid' | 'refund_pending' | 'refunded'): Promise<void>;
  appendAuditEvidence(tenantId: string, evidence: AuditEvidenceInput): Promise<void>;

  // Discount writes.
  insertOrderDiscount(tenantId: string, discount: InsertOrderDiscountInput): Promise<OrderDiscountRecord>;
  incrementCouponUses(tenantId: string, couponId: string): Promise<void>;
  findSuccessfulOverrideAttemptId(
    tenantId: string,
    evidence: { actorUserId: string; managerUserId: string; orderId: string; contextType: ManagerOverrideContextType },
  ): Promise<string | null>;

  // Payment-method administration.
  insertPaymentMethod(tenantId: string, input: NewPaymentMethodInput): Promise<PaymentMethodRecord>;
  updatePaymentMethod(tenantId: string, paymentMethodId: string, input: UpdatePaymentMethodInput): Promise<PaymentMethodRecord>;

  // Stock ledger (Phase 9: refund waste lines mirror recorded deductions).
  loadNonVoidedOrderItemIds(tenantId: string, orderId: string): Promise<readonly string[]>;
  loadSaleDeductionsForOrderItems(tenantId: string, orderItemIds: readonly string[]): Promise<readonly SaleDeductionAggregate[]>;
  loadWasteRefundKeys(tenantId: string, orderId: string): Promise<readonly WasteRefundKey[]>;
  insertStockMovement(tenantId: string, movement: InsertStockMovementInput): Promise<StockMovementRecord>;
}

export interface PaymentsStore {
  /** Runs fn in ONE transaction scoped to the tenant (repeatable read). */
  run<T>(tenantId: string, fn: (scope: PaymentsTxScope) => Promise<T>): Promise<T>;
}

// ── The shifts store port ───────────────────────────────────────────────────

export interface OpenShiftInput {
  readonly branchId: string;
  readonly cashierUserId: string;
  readonly openedByUserId: string;
  readonly openVerifiedByUserId: string;
  readonly openedAt: Date;
  readonly openCounts: readonly CashCountLineInput[];
}

export interface CloseShiftInput {
  readonly shiftId: string;
  readonly closedByUserId: string;
  readonly closeVerifiedByUserId: string;
  readonly closedAt: Date;
  readonly closeCounts: readonly CashCountLineInput[];
  readonly notes: string | null;
}

export interface ShiftsTxScope {
  loadBranchForShift(tenantId: string, branchId: string): Promise<{ id: string; baseCurrencyCode: string; isActive: boolean } | null>;
  userIsActiveMember(tenantId: string, userId: string): Promise<boolean>;
  findOpenShiftForCashier(tenantId: string, cashierUserId: string, branchId: string): Promise<ShiftRecord | null>;
  /** Tenant-wide probe (any branch) — backs the no-parallel-shifts rule. */
  findAnyOpenShiftForCashier(tenantId: string, cashierUserId: string): Promise<ShiftRecord | null>;
  loadShift(tenantId: string, shiftId: string): Promise<ShiftRecord | null>;
  /**
   * B2: SELECT … FOR UPDATE on a shift_reconciliations row — the FIRST
   * statement of closeShift (see PaymentsTxScope.lockShift for the
   * close-vs-collect race). Always followed by bumpShiftRevision.
   */
  lockShift(tenantId: string, shiftId: string): Promise<ShiftRecord | null>;
  /** B2: UPDATE shift_reconciliations SET revision = revision + 1. */
  bumpShiftRevision(tenantId: string, shiftId: string): Promise<void>;
  loadCashCounts(tenantId: string, shiftId: string): Promise<readonly CashCountDetailRecord[]>;
  insertShift(tenantId: string, input: { id: string; branchId: string; cashierId: string; openedById: string; openVerifiedById: string; openedAt: Date; startingFloat: string }): Promise<ShiftRecord>;
  insertCashCountDetails(tenantId: string, shiftId: string, countType: CashCountType, lines: readonly CashCountLineInput[]): Promise<void>;
  /** SUM of completed cash payments (cash + foreign_currency_cash) on the shift, as exact decimal text (numeric SUM). */
  sumCompletedCashPaymentsText(tenantId: string, shiftId: string): Promise<string>;
  closeShiftRow(tenantId: string, shiftId: string, close: { closedById: string; closeVerifiedById: string; closedAt: Date; countedCash: string; recordedCashSales: string; varianceType: VarianceType; notes: string | null }): Promise<ShiftRecord>;
}

export interface ShiftsStore {
  /** Runs fn in ONE transaction scoped to the tenant (repeatable read). */
  run<T>(tenantId: string, fn: (scope: ShiftsTxScope) => Promise<T>): Promise<T>;
}
