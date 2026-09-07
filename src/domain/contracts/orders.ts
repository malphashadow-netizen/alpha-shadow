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
import type { TaxResolution } from './tax.ts';

export type OrderType = 'dine_in' | 'takeaway' | 'delivery';
export type OrderPaymentStatus = 'open' | 'paid' | 'refund_pending' | 'refunded';
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
  /** Defaults to the menu item's current base price when omitted. */
  readonly unitPriceMinor?: bigint;
  readonly modifiers?: readonly OrderItemModifierSnapshot[];
}

export interface NewOrderInput {
  readonly branchId: string;
  readonly orderType: OrderType;
  readonly salesChannelCode: string;
  readonly deliveryPlatformId?: string | null;
  readonly tableId?: string | null;
  readonly items: readonly NewOrderItemLine[];
  readonly occurredAt?: Date;
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
  readonly actorUserId?: string;
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
 */
export interface ManagerOverrideAuthenticator {
  verifyLiveChallenge(
    tenantId: string,
    managerUserId: string,
    managerOverridePin: string,
    initiatingActorUserId: string,
    /** Optional order link, recorded on the attempt ledger when provided. */
    orderId?: string,
  ): Promise<Date>;
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
  loadOrderItem(tenantId: string, orderItemId: string): Promise<OrderItemRecord | null>;
  loadActiveOrderItems(tenantId: string, orderId: string): Promise<readonly OrderItemRecord[]>;
  loadMenuItem(tenantId: string, menuItemId: string): Promise<{ id: string; name: LocalizedText; basePriceMinor: bigint; isActive: boolean } | null>;
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
  insertOrder(tenantId: string, order: { id: string; branchId: string; orderType: OrderType; salesChannelCode: string; deliveryPlatformId: string | null; tableId: string | null; initialStatusKindId: string; placedAt: Date }): Promise<void>;
  insertOrderItem(tenantId: string, item: { id: string; orderId: string; menuItemId: string; itemNameSnapshot: LocalizedText; unitPriceMinor: bigint; quantity: number; modifiersSnapshot: readonly OrderItemModifierSnapshot[]; initialStatusKindId: string; stationId: string; createdAt: Date }): Promise<void>;
  insertInitialStatusEvent(tenantId: string, orderItemId: string, orderId: string, toWorkflowStateId: string, occurredAt: Date): Promise<void>;
  resolveLineTax(tenantId: string, input: { orderLineId: string; branchId: string; menuItemId: string; customerAmountMinor: bigint; currencyCode: string; at: Date; salesChannel: string; deliveryPlatformId: string | null }): Promise<TaxResolution>;

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
  resolveVoidPermissionTier(tenantId: string, userId: string): Promise<VoidPermissionTier | null>;
  userIsActiveMember(tenantId: string, userId: string): Promise<boolean>;
  appendEvent(tenantId: string, branchId: string, eventType: OrderEventType, payload: Readonly<Record<string, unknown>>): Promise<number>;
  markOrderItemsVoided(tenantId: string, orderItemIds: readonly string[]): Promise<void>;
  recomputeOrderStatus(tenantId: string, orderId: string): Promise<string | null>;
  insertOrderVoid(tenantId: string, record: { id: string; orderId: string; orderItemId: string | null; actorUserId: string; actorPermissionTier: VoidPermissionTier; voidReasonId: string; requiredManagerOverride: boolean; managerUserId: string | null; overrideAuthenticatedAt: Date | null; orderPaymentStatusAtVoidTime: OrderPaymentStatus; notes: string | null }): Promise<OrderVoidAuditRecord>;
}

export interface OrdersStore {
  /** Runs fn in ONE transaction scoped to the tenant (repeatable read). */
  run<T>(tenantId: string, fn: (scope: OrdersTxScope) => Promise<T>): Promise<T>;
}
