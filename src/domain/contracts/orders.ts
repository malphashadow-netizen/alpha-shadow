/**
 * Phase 7 domain contracts — orders, KDS preparation stations, the transactional
 * outbox and the void/modification audit.
 *
 * Pure types + ports only (zero dependencies, same rules as every other file in
 * domain/contracts). The application engines depend on these ports; the
 * PostgreSQL adapter (src/infrastructure/db/repositories/postgres-orders-store.ts)
 * implements them through withTenantContext().
 *
 * Core fail-closed principles encoded here:
 *   * A workflow transition is only valid inside the tenant's ENABLED workflow
 *     sequence — there is no free-form state machine.
 *   * Behavior (kitchen ticket / payment collection / customer notification /
 *     terminality / financial close) is bound to the PLATFORM kind
 *     (order_status_kinds.behavior_flags), never to the tenant's free label.
 *   * An order item without an explicitly routed station cannot exist.
 *   * Every state change appends an outbox row in the SAME transaction, with a
 *     gapless per-branch sequence_id for lossless reconnect replay.
 *   * A void on a non-open order is PaymentReversalRequiredError — never an
 *     implicit allow (payments engine is a future phase).
 *   * A manager override is a LIVE PIN challenge at void time — never a name.
 */
import type { LocalizedText } from './catalog.ts';
import type {
  ClaimStockOverrideInput,
  InsertStockMovementInput,
  InventoryItemRecord,
  RecipeOwnerRef,
  RecipeRequirementLine,
  RestorationKey,
  SaleDeductionAggregate,
  StockMovementRecord,
} from './inventory.ts';
import type { TaxResolution } from './tax.ts';

export type OrderType = 'dine_in' | 'takeaway' | 'delivery';
export type OrderPaymentStatus = 'open' | 'paid' | 'refund_pending' | 'refunded' | 'voided';
export type VoidPermissionTier = 'server' | 'shift_supervisor' | 'manager';

/** The graded void permission ladder (atomic keys in permissions_registry). */
export const ORDER_VOID_PERMISSION_KEYS = Object.freeze({
  server: 'order:void',
  shift_supervisor: 'order:void:shift_supervisor',
  manager: 'order:void:manager',
} as const);

export const VOID_PERMISSION_TIER_RANK: Readonly<Record<VoidPermissionTier, number>> = Object.freeze({
  server: 1,
  shift_supervisor: 2,
  manager: 3,
});

/** Fixed platform behavior vocabulary — bound to order_status_kinds rows. */
export interface OrderBehaviorFlags {
  readonly fires_kitchen_ticket: boolean;
  readonly opens_payment_collection: boolean;
  readonly notifies_customer: boolean;
  readonly is_terminal: boolean;
  readonly is_financial_close: boolean;
}

export interface OrderStatusKind {
  readonly code: string;
  readonly name: LocalizedText;
  readonly behaviorFlags: OrderBehaviorFlags;
}

/** Parses the platform kind's fixed behavior vocabulary (fail-closed on shape). */
export function parseOrderBehaviorFlags(value: unknown): OrderBehaviorFlags {
  if (value === null || typeof value !== 'object') {
    throw new Error('order status kind behavior_flags must be a JSON object');
  }
  const flags = value as Record<string, unknown>;
  const flag = (key: keyof OrderBehaviorFlags): boolean => {
    const v = flags[key];
    if (typeof v !== 'boolean') throw new Error(`behavior_flags.${key} must be a boolean`);
    return v;
  };
  return {
    fires_kitchen_ticket: flag('fires_kitchen_ticket'),
    opens_payment_collection: flag('opens_payment_collection'),
    notifies_customer: flag('notifies_customer'),
    is_terminal: flag('is_terminal'),
    is_financial_close: flag('is_financial_close'),
  };
}

export interface TenantWorkflowState {
  readonly id: string;
  readonly tenantId: string;
  readonly workflowId: string;
  readonly kindCode: string;
  readonly parentKindCode: string | null;
  readonly position: number;
  readonly label: LocalizedText;
  readonly isEnabled: boolean;
}

export interface OrderRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly branchId: string;
  readonly orderType: OrderType;
  readonly salesChannelCode: string;
  readonly deliveryPlatformId: string | null;
  readonly tableId: string | null;
  readonly currentStatusKindId: string;
  readonly paymentStatus: OrderPaymentStatus;
  /** Display-only Phase-8 split metadata. */
  readonly splitPeopleCount: number | null;
  readonly placedAt: Date;
  readonly closedAt: Date | null;
}

export interface OrderItemRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly orderId: string;
  readonly menuItemId: string;
  readonly itemNameSnapshot: LocalizedText;
  readonly unitPriceMinor: bigint;
  readonly quantity: number;
  readonly currentStatusKindId: string;
  readonly stationId: string;
  readonly isVoided: boolean;
  readonly voidedAt: Date | null;
  /** Light Phase-8 check-split tag (immutable with the rest of the evidence). */
  readonly splitGroupId: string | null;
  readonly createdAt: Date;
}

export interface OrderVoidAuditRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly orderId: string;
  readonly orderItemId: string | null;
  readonly actorUserId: string;
  readonly actorPermissionTier: VoidPermissionTier;
  readonly voidReasonId: string;
  readonly requiredManagerOverride: boolean;
  readonly managerUserId: string | null;
  readonly overrideAuthenticatedAt: Date | null;
  readonly orderPaymentStatusAtVoidTime: OrderPaymentStatus;
  readonly notes: string | null;
  readonly occurredAt: Date;
}

// ── Station routing ─────────────────────────────────────────────────────────

export interface StationRoutingContext {
  readonly menuItemId: string;
  readonly salesChannelCode: string;
  readonly orderType: OrderType;
}

export interface StationRoutingDecision {
  readonly ruleId: string;
  readonly stationId: string;
  readonly specificityScore: number;
  readonly priorityWeight: number;
}

/**
 * The DETERMINISTIC TIE-BREAK, named and single-sourced:
 *   specificity_score DESC → priority_weight DESC → rule_id ASC.
 * Any higher dimension outranks any combination of lower ones (100 > 20+10).
 */
export const STATION_ROUTING_SPECIFICITY_WEIGHTS = Object.freeze({
  menuItem: 100,
  salesChannel: 20,
  orderType: 10,
} as const);

// ── Outbox / KDS realtime ───────────────────────────────────────────────────

export type OrderEventType =
  | 'order_item.status_changed'
  | 'order.status_changed'
  | 'order_item.voided'
  | 'order.voided';

export interface OrderOutboxEvent {
  readonly id: string;
  readonly tenantId: string;
  readonly branchId: string;
  readonly sequenceId: number;
  readonly eventType: OrderEventType | (string & {});
  readonly payload: Readonly<Record<string, unknown>>;
  readonly createdAt: Date;
}

// ── Order creation ──────────────────────────────────────────────────────────

export interface OrderItemModifierSnapshot {
  readonly modifierId: string;
  readonly name: LocalizedText;
  readonly priceDeltaMinor: bigint;
}

export interface NewOrderItemLine {
  readonly menuItemId: string;
  readonly quantity: number;
  /**
   * Explicit branch-currency price (B10): denominated in the ORDER BRANCH's
   * base currency, never the menu item's. Defaults to the menu item's
   * current base price when omitted (which must then match the branch
   * currency — cross-currency lines are rejected, never converted).
   */
  readonly unitPriceMinor?: bigint;
  readonly modifiers?: readonly OrderItemModifierSnapshot[];
  /** Optional light check-split tag (frozen with the rest of the evidence). */
  readonly splitGroupId?: string | null;
}

export interface NewOrderInput {
  readonly branchId: string;
  /**
   * The cashier creating the order (Phase 8 shift gateway): they must be an
   * active member holding a standing status='open' shift AT THIS BRANCH —
   * no open shift, no new order, fail-closed.
   */
  readonly cashierUserId: string;
  readonly orderType: OrderType;
  readonly salesChannelCode: string;
  readonly deliveryPlatformId?: string | null;
  readonly tableId?: string | null;
  /** Display only: how many people the check is split across (no sub-invoices). */
  readonly splitPeopleCount?: number | null;
  readonly items: readonly NewOrderItemLine[];
  /**
   * @deprecated Audit F-B: IGNORED. The server clock (`new Date()` in the
   * creation engine) is the sole source of event time — any caller-supplied
   * value, past or future, has no effect on placed_at, item created_at,
   * status events, tax pricing, or stock movements. Kept only so existing
   * callers compile.
   */
  readonly occurredAt?: Date;
  /**
   * Optional creation-time stock override (Phase 9): when the order would
   * drive any component below zero, the approving manager's live PIN
   * challenge authorizes this single order (context 'stock_override'). The
   * challenge commits its own transaction BEFORE the write transaction
   * starts, and is bound to the order via a single-use claim.
   */
  readonly managerOverride?: ManagerOverrideChallenge;
}

export interface CreatedOrderItem {
  readonly item: OrderItemRecord;
  readonly taxes: TaxResolution;
}

export interface CreatedOrder {
  readonly order: OrderRecord;
  readonly items: readonly CreatedOrderItem[];
}

// ── Workflow transitions ────────────────────────────────────────────────────

export interface ItemStatusTransitionInput {
  readonly orderItemId: string;
  readonly toWorkflowStateId: string;
  /**
   * Audit F-D: REQUIRED. The human actor is the authorization subject of
   * every transition — `order:item:transition` is checked FIRST, before any
   * store call. Optional-before was the hole (audit-only, never gated).
   */
  readonly actorUserId: string;
  /**
   * Audit F-D: REQUIRED. Freshness proof for the actor's role assignment
   * (stage 1 of the check). A stale token fails closed — the transition is
   * rejected even when the actor holds the key.
   */
  readonly tokenSecV: string;
  /**
   * @deprecated Audit F-B: IGNORED. The server clock stamps every status
   * transition — any caller-supplied value, past or future, has no effect.
   * Kept only so existing callers compile.
   */
  readonly occurredAt?: Date;
}

export interface ItemStatusTransitionResult {
  readonly orderItemId: string;
  readonly fromWorkflowStateId: string | null;
  readonly toWorkflowStateId: string;
  readonly behaviorFlags: OrderBehaviorFlags;
  readonly outboxSequenceId: number;
}

// ── Void / modification ─────────────────────────────────────────────────────

export interface ManagerOverrideChallenge {
  readonly managerUserId: string;
  /** The manager's SEPARATE PIN, verified live at the moment of the void. */
  readonly managerOverridePin: string;
}

export interface VoidOrderItemInput {
  readonly orderItemId: string;
  readonly voidReasonId: string;
  readonly managerOverride?: ManagerOverrideChallenge;
  readonly notes?: string;
}

export interface VoidOrderInput {
  readonly orderId: string;
  readonly voidReasonId: string;
  readonly managerOverride?: ManagerOverrideChallenge;
  readonly notes?: string;
}

export interface VoidActor {
  readonly userId: string;
  readonly tokenSecV: string;
}

/**
 * The live manager-override challenge port. An implementation MUST verify the
 * approving manager's own separate PIN against the existing credential store
 * at the moment of the void and return the authentication timestamp; picking
 * a name from a list is never an implementation of this port.
 *
 * Security patch (rate limiting): the challenge is bound to the INITIATING
 * ACTOR (the employee requesting the override — the identity whose guessing
 * budget must run out), and every attempt is counted + audited:
 *   * per (tenant, target manager): 5 consecutive failures in a renewing
 *     15-minute window → 15-minute hard lock;
 *   * per (tenant, initiating actor) ACROSS ALL MANAGERS: 10 failures in the
 *     window → 30-minute hard lock + a high-severity security audit event;
 *   * attempts during an active lock are audited as rejected_locked but are
 *     neither re-counted nor lock-extending;
 *   * a success resets ONLY the target manager's counter, never the actor's.
 * A locked challenge (either shape) fails with ManagerOverrideRateLimitedError
 * carrying a client-safe retryAfterSeconds.
 *
 * Context (Phase 8, extended in Phase 9): every attempt records its business
 * context ('void' | 'discount' | 'stock_override') so EVIDENCE is
 * context-scoped — but the RATE LIMITING above is deliberately NOT: the
 * counters stay shared across all contexts per manager and per initiating
 * actor, otherwise an active lock could be bypassed by simply alternating
 * between challenge contexts.
 */
/**
 * The business context a manager-override challenge is issued for. Every
 * attempt row on the Phase-7b ledger records its context, so override
 * evidence can never cross contexts: a successful 'void' challenge does not
 * authorize a discount, a successful 'discount' challenge does not authorize
 * a void, and only a 'stock_override' challenge authorizes a sale into
 * shortage (bound to exactly one order via a single-use claim).
 */
export type ManagerOverrideContextType = 'void' | 'discount' | 'stock_override';

/** A verified challenge PLUS the attempt row id (for single-use claim binding). */
export interface VerifiedManagerOverride {
  readonly authenticatedAt: Date;
  readonly attemptId: string;
}

export interface ManagerOverrideAuthenticator {
  verifyLiveChallenge(
    tenantId: string,
    managerUserId: string,
    managerOverridePin: string,
    initiatingActorUserId: string,
    /** The business context of the override — stamped on the attempt ledger. */
    contextType: ManagerOverrideContextType,
    /** Optional order link, recorded on the attempt ledger when provided. */
    orderId?: string,
  ): Promise<Date>;
  /**
   * Phase 9: the IDENTICAL challenge transaction (same rate limiting, same
   * errors) that additionally returns the attempt id, so the caller binds
   * its evidence to the exact attempt it just verified — never a lookup.
   */
  verifyLiveChallengeWithId(
    tenantId: string,
    managerUserId: string,
    managerOverridePin: string,
    initiatingActorUserId: string,
    contextType: ManagerOverrideContextType,
    orderId?: string,
  ): Promise<VerifiedManagerOverride>;
}

// ── Side effects (claim-then-execute) ───────────────────────────────────────

export type SideEffectType = 'kitchen_ticket_print' | 'customer_notification';

export interface SideEffectClaimOutcome {
  readonly outcome: 'claimed' | 'succeeded' | 'retry';
  readonly attemptCount: number;
}

export interface SideEffectExecutor {
  execute(event: OrderOutboxEvent, sideEffectType: SideEffectType): Promise<void>;
}

export interface SideEffectRunReport {
  readonly examined: number;
  readonly executed: number;
  readonly skippedAsSucceeded: number;
  readonly failed: number;
}

// ── The store port (one transaction per use case) ───────────────────────────

export interface OrdersTxScope {
  // Workflow configuration + reads.
  loadWorkflowStates(tenantId: string, enabledOnly: boolean): Promise<readonly TenantWorkflowState[]>;
  loadOrder(tenantId: string, orderId: string): Promise<OrderRecord | null>;
  /**
   * B2: SELECT … FOR UPDATE on the orders row — the FIRST statement of every
   * order-mutating transaction (uniform lock order: orders →
   * shift_reconciliations). Under REPEATABLE READ the lock alone is not
   * enough (the waiter's snapshot stays stale), so every locker also calls
   * bumpOrderRevision: exactly one concurrent mutation wins, the loser gets a
   * 40001 serialization failure (retryable: ConcurrencyRetryableError → 503).
   */
  lockOrder(tenantId: string, orderId: string): Promise<OrderRecord | null>;
  /**
   * B2: UPDATE orders SET revision = revision + 1 — the conflict generator
   * that makes the order lock decisive under REPEATABLE READ. Called
   * immediately after lockOrder, before any decision read.
   */
  bumpOrderRevision(tenantId: string, orderId: string): Promise<void>;
  loadOrderItem(tenantId: string, orderItemId: string): Promise<OrderItemRecord | null>;
  loadActiveOrderItems(tenantId: string, orderId: string): Promise<readonly OrderItemRecord[]>;
  loadMenuItem(tenantId: string, menuItemId: string): Promise<{ id: string; name: LocalizedText; basePriceMinor: bigint; basePriceCurrencyCode: string; isActive: boolean } | null>;
  loadOrderStatusKindFlags(kindCode: string): Promise<OrderBehaviorFlags>;
  loadBranch(tenantId: string, branchId: string): Promise<{ id: string; baseCurrencyCode: string; isActive: boolean } | null>;

  // Workflow administration (fail-closed delete, always-allowed disable/reorder).
  createWorkflow(tenantId: string, topLevelKinds: readonly { kindCode: string; position: number; label: LocalizedText }[]): Promise<string>;
  addWorkflowState(tenantId: string, input: { kindCode: string; parentKindCode: string | null; position: number; label: LocalizedText }): Promise<string>;
  setWorkflowStateEnabled(tenantId: string, stateId: string, isEnabled: boolean): Promise<void>;
  setWorkflowStatePosition(tenantId: string, stateId: string, position: number): Promise<void>;
  countWorkflowStateReferences(tenantId: string, stateId: string): Promise<number>;
  deleteWorkflowState(tenantId: string, stateId: string): Promise<void>;

  // Station routing.
  resolveStationRoute(tenantId: string, branchId: string, context: StationRoutingContext): Promise<StationRoutingDecision | null>;

  // Order creation (all inside one transaction).
  insertOrder(tenantId: string, order: { id: string; branchId: string; orderType: OrderType; salesChannelCode: string; deliveryPlatformId: string | null; tableId: string | null; initialStatusKindId: string; placedAt: Date; splitPeopleCount: number | null }): Promise<void>;
  insertOrderItem(tenantId: string, item: { id: string; orderId: string; menuItemId: string; itemNameSnapshot: LocalizedText; unitPriceMinor: bigint; quantity: number; modifiersSnapshot: readonly OrderItemModifierSnapshot[]; initialStatusKindId: string; stationId: string; createdAt: Date; splitGroupId: string | null }): Promise<void>;
  /** The Phase-8 shift gateway probe: the cashier's standing OPEN shift at the branch, or null. */
  findOpenShiftForCashier(tenantId: string, cashierUserId: string, branchId: string): Promise<{ id: string } | null>;
  insertInitialStatusEvent(tenantId: string, orderItemId: string, orderId: string, toWorkflowStateId: string, occurredAt: Date): Promise<void>;
  /**
   * B4: the complete-invoice tax call — ONE call per order carrying EVERY
   * line, resolved via resolveInvoiceAndSnapshot in this same transaction.
   * Per-line resolution cannot serve invoice_total jurisdictions (the rounded
   * unit is the invoice sum, not the line), so creation never resolves lines
   * in isolation. Returns the per-line resolutions keyed by orderLineId.
   */
  resolveInvoiceTax(tenantId: string, inputs: readonly { orderLineId: string; branchId: string; menuItemId: string; customerAmountMinor: bigint; currencyCode: string; at: Date; salesChannel: string; deliveryPlatformId: string | null }[]): Promise<ReadonlyMap<string, TaxResolution>>;

  // Transitions.
  insertStatusEvent(tenantId: string, input: { orderItemId: string; orderId: string; fromWorkflowStateId: string | null; toWorkflowStateId: string; actorUserId: string | null; occurredAt: Date }): Promise<void>;

  // Outbox + side effects.
  readOutboxEvents(tenantId: string, branchId: string, afterSequenceId: number, limit: number): Promise<readonly OrderOutboxEvent[]>;
  loadEventsWithBehaviorFlags(tenantId: string, limit: number, branchId?: string  ): Promise<readonly OrderOutboxEvent[]>;
  lastOutboxSequence(tenantId: string, branchId: string): Promise<number>;
  claimSideEffect(tenantId: string, outboxEventId: string, sideEffectType: SideEffectType, stalePendingAfterMs: number): Promise<SideEffectClaimOutcome>;
  markSideEffect(tenantId: string, outboxEventId: string, sideEffectType: SideEffectType, status: 'succeeded' | 'failed', errorMessage?: string): Promise<void>;

  // Void support.
  loadVoidReason(tenantId: string, voidReasonId: string): Promise<{ id: string; requiredPermissionTier: VoidPermissionTier; isEnabled: boolean; kindCode: string; kindSettingEnabled: boolean } | null>;
  loadVoidTimeLimitMinutes(tenantId: string): Promise<number | null>;
  /**
   * Resolves the highest void tier the user holds through grants that COVER
   * `branchId`: tenant-wide grants, or branch-scoped grants for exactly this
   * branch. Branch-scoped grants for any OTHER branch are ignored entirely —
   * they must never inflate the resolved tier (audit F-A). `branchId` is
   * required and must be non-empty (orders always carry a branch).
   */
  resolveVoidPermissionTier(tenantId: string, userId: string, branchId: string): Promise<VoidPermissionTier | null>;
  userIsActiveMember(tenantId: string, userId: string): Promise<boolean>;
  appendEvent(tenantId: string, branchId: string, eventType: OrderEventType, payload: Readonly<Record<string, unknown>>): Promise<number>;
  markOrderItemsVoided(tenantId: string, orderItemIds: readonly string[]): Promise<void>;
  /** B11: direct payment-status write (order void → 'voided'); the lifecycle recompute owns all other transitions. */
  setOrderPaymentStatus(tenantId: string, orderId: string, paymentStatus: OrderPaymentStatus): Promise<void>;
  recomputeOrderStatus(tenantId: string, orderId: string): Promise<string | null>;
  insertOrderVoid(tenantId: string, record: { id: string; orderId: string; orderItemId: string | null; actorUserId: string; actorPermissionTier: VoidPermissionTier; voidReasonId: string; requiredManagerOverride: boolean; managerUserId: string | null; overrideAuthenticatedAt: Date | null; orderPaymentStatusAtVoidTime: OrderPaymentStatus; notes: string | null }): Promise<OrderVoidAuditRecord>;

  // Stock ledger (Phase 9).
  /** Single read over the recipe_ingredients view for the given owners. */
  loadRecipeRequirements(tenantId: string, owners: readonly RecipeOwnerRef[]): Promise<readonly RecipeRequirementLine[]>;
  /** Branch-scoped component rows for availability math. */
  loadInventoryItems(tenantId: string, branchId: string, inventoryItemIds: readonly string[]): Promise<readonly InventoryItemRecord[]>;
  /**
   * Appends ONE movement row. A trigger shortage rejection (23514 + the
   * 'stock: insufficient quantity' prefix) is mapped to InsufficientStockError.
   */
  insertStockMovement(tenantId: string, movement: InsertStockMovementInput): Promise<StockMovementRecord>;
  /** Binds one override attempt to exactly one order (single-use claim). */
  insertStockOverrideClaim(tenantId: string, claim: ClaimStockOverrideInput): Promise<void>;
  /** Recorded sale deductions per (order item, component) — restoration mirrors these exactly. */
  loadSaleDeductionsForOrderItems(tenantId: string, orderItemIds: readonly string[]): Promise<readonly SaleDeductionAggregate[]>;
  /** Subset of the given items that EVER entered a fires_kitchen_ticket state. */
  loadItemsWithKitchenTicketFired(tenantId: string, orderItemIds: readonly string[]): Promise<readonly string[]>;
  /**
   * (order item, component) pairs that already carry a void_restoration row
   * — void-written or written by a prior partial refund. The void path
   * skips these: the stock is already home.
   */
  loadVoidRestorationKeys(tenantId: string, orderItemIds: readonly string[]): Promise<readonly RestorationKey[]>;
}

export interface OrdersStore {
  /** Runs fn in ONE transaction scoped to the tenant (repeatable read). */
  run<T>(tenantId: string, fn: (scope: OrdersTxScope) => Promise<T>): Promise<T>;
}
