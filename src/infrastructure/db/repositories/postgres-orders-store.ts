/**
 * PostgreSQL adapter for the Phase-7 orders/KDS ports (domain/contracts/orders.ts).
 *
 * Every use case runs in ONE withTenantContext() transaction (repeatable read,
 * tenant existence verified): the order row, its items, the routing decisions,
 * the status events, the outbox rows and the tax contexts/snapshots all commit
 * or roll back together — "no broadcast without a durable row" is structural,
 * not aspirational.
 *
 * This class never imports pg (see eslint-rules/pg-import-policy.ts); it only
 * receives the transaction-scoped TenantQuery from withTenantContext().
 */
import type {
  OrderBehaviorFlags,
  OrderItemModifierSnapshot,
  OrderItemRecord,
  OrderOutboxEvent,
  OrderRecord,
  OrdersStore,
  OrdersTxScope,
  SideEffectClaimOutcome,
  SideEffectType,
  StationRoutingDecision,
  StationRoutingContext,
  TenantWorkflowState,
  VoidPermissionTier,
  OrderType,
  OrderPaymentStatus,
  OrderVoidAuditRecord,
} from '../../../domain/contracts/orders.ts';
import { parseOrderBehaviorFlags } from '../../../domain/contracts/orders.ts';
import type { LocalizedText } from '../../../domain/contracts/catalog.ts';
import type {
  ClaimStockOverrideInput,
  InsertStockMovementInput,
  InventoryItemRecord,
  RecipeOwnerRef,
  RecipeOwnerType,
  RecipeRequirementLine,
  SaleDeductionAggregate,
  StockMovementRecord,
} from '../../../domain/contracts/inventory.ts';
import type { TaxResolution } from '../../../domain/contracts/tax.ts';
import {
  InsufficientStockError,
  NotFoundError,
  OrderWorkflowNotConfiguredError,
  WorkflowStateInUseError,
} from '../../../shared/errors.ts';
import { insertStockMovementRow, mapInventoryItem, type InventoryItemRow } from './stock-ledger-rows.ts';
import { resolveInvoiceAndSnapshot } from '../../../application/engines/tax/tax-resolution-engine.ts';
import type { WithTenantContext, TenantQuery } from '../tenant-context.ts';
import { PostgresTaxResolutionTransaction } from './postgres-tax-resolution-transaction.ts';

function row<T>(rows: readonly T[]): T {
  const first = rows[0];
  if (first === undefined) throw new Error('Expected database row');
  return first;
}

function localized(value: unknown): LocalizedText {
  return (value ?? {}) as LocalizedText;
}

interface WorkflowStateRow {
  id: string;
  tenant_id: string;
  workflow_id: string;
  kind_code: string;
  parent_kind_code: string | null;
  position: number;
  label: unknown;
  is_enabled: boolean;
}

interface OrderRow {
  id: string;
  tenant_id: string;
  branch_id: string;
  order_type: OrderType;
  sales_channel_code: string;
  delivery_platform_id: string | null;
  table_id: string | null;
  current_status_kind_id: string;
  payment_status: OrderPaymentStatus;
  split_people_count: number | null;
  placed_at: Date;
  closed_at: Date | null;
}

interface OrderItemRow {
  id: string;
  tenant_id: string;
  order_id: string;
  menu_item_id: string;
  item_name_snapshot: unknown;
  unit_price_minor: string;
  quantity: number;
  current_status_kind_id: string;
  station_id: string;
  is_voided: boolean;
  voided_at: Date | null;
  split_group_id: string | null;
  created_at: Date;
}

interface OutboxRow {
  id: string;
  tenant_id: string;
  branch_id: string;
  sequence_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: Date;
}

function mapWorkflowState(r: WorkflowStateRow): TenantWorkflowState {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    workflowId: r.workflow_id,
    kindCode: r.kind_code,
    parentKindCode: r.parent_kind_code,
    position: r.position,
    label: localized(r.label),
    isEnabled: r.is_enabled,
  };
}

function mapOrder(r: OrderRow): OrderRecord {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    branchId: r.branch_id,
    orderType: r.order_type,
    salesChannelCode: r.sales_channel_code,
    deliveryPlatformId: r.delivery_platform_id,
    tableId: r.table_id,
    currentStatusKindId: r.current_status_kind_id,
    paymentStatus: r.payment_status,
    splitPeopleCount: r.split_people_count,
    placedAt: r.placed_at,
    closedAt: r.closed_at,
  };
}

function mapOrderItem(r: OrderItemRow): OrderItemRecord {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    orderId: r.order_id,
    menuItemId: r.menu_item_id,
    itemNameSnapshot: localized(r.item_name_snapshot),
    unitPriceMinor: BigInt(r.unit_price_minor),
    quantity: r.quantity,
    currentStatusKindId: r.current_status_kind_id,
    stationId: r.station_id,
    isVoided: r.is_voided,
    voidedAt: r.voided_at,
    splitGroupId: r.split_group_id,
    createdAt: r.created_at,
  };
}

function mapOutboxEvent(r: OutboxRow): OrderOutboxEvent {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    branchId: r.branch_id,
    sequenceId: Number(r.sequence_id),
    eventType: r.event_type,
    payload: r.payload,
    createdAt: r.created_at,
  };
}

/**
 * Stable prefix of the 0040 negative-balance rejection
 * ('stock: insufficient quantity …'). Pinned here AND in the migration AND in
 * the unit test — never reword one without the other two.
 */
export const STOCK_SHORTAGE_MESSAGE_PREFIX = 'stock: insufficient quantity';

/**
 * True only for the trigger's shortage rejection: code 23514 AND the stable
 * prefix. Every other database error (including any other 23514) propagates
 * untouched — fail-closed, never mislabelled.
 */
export function isStockShortageTriggerError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  if (!('code' in error) || !('message' in error)) return false;
  return error.code === '23514' && typeof error.message === 'string' && error.message.startsWith(STOCK_SHORTAGE_MESSAGE_PREFIX);
}

export interface PostgresOrdersStoreDependencies {
  readonly withTenantContext: WithTenantContext;
  /** B3: per-transaction lock_timeout override (ms). undefined = inherit the context default. */
  readonly lockTimeoutMs?: number | undefined;
}

export class PostgresOrdersStore implements OrdersStore {
  private readonly dependencies: PostgresOrdersStoreDependencies;

  constructor(dependencies: PostgresOrdersStoreDependencies) {
    this.dependencies = dependencies;
  }

  run<T>(tenantId: string, fn: (scope: OrdersTxScope) => Promise<T>): Promise<T> {
    return this.dependencies.withTenantContext(
      tenantId,
      async (q) => {
        // One tax-resolution transaction adapter per use case, closed with the
        // scope — the Phase-6 seam contract (existing transaction, never a pool).
        const tax = new PostgresTaxResolutionTransaction(q, tenantId);
        try {
          return await fn(buildScope(q, tax, tenantId));
        } finally {
          tax.close();
        }
      },
      {
        isolationLevel: 'repeatable read',
        verifyTenantExists: true,
        // B3: spread ONLY when set — an explicit undefined would wipe the
        // production lock_timeout default during option merging.
        ...(this.dependencies.lockTimeoutMs === undefined ? {} : { lockTimeoutMs: this.dependencies.lockTimeoutMs }),
      },
    );
  }
}

type Scope = OrdersTxScope;

function buildScope(q: TenantQuery, tax: PostgresTaxResolutionTransaction, _tenantId: string): Scope {
  async function countWorkflowStateReferences(tid: string, stateId: string): Promise<number> {
    const result = await q.query<{ refs: string }>(
      `SELECT (
           (SELECT count(*) FROM orders WHERE tenant_id = $1 AND current_status_kind_id = $2)
         + (SELECT count(*) FROM order_items WHERE tenant_id = $1 AND current_status_kind_id = $2)
         + (SELECT count(*) FROM order_item_status_events WHERE tenant_id = $1 AND (from_status_kind_id = $2 OR to_status_kind_id = $2))
       )::text AS refs`,
      [tid, stateId],
    );
    return Number(row(result.rows).refs);
  }

  return {
    async loadWorkflowStates(tid: string, enabledOnly: boolean): Promise<readonly TenantWorkflowState[]> {
      const result = await q.query<WorkflowStateRow>(
        `SELECT s.id, s.tenant_id, s.workflow_id, s.kind_code, s.parent_kind_code, s.position, s.label, s.is_enabled
           FROM tenant_order_workflow_states s
           JOIN tenant_order_workflows w ON w.id = s.workflow_id AND w.tenant_id = s.tenant_id
          WHERE s.tenant_id = $1 AND w.is_active AND ($2 = false OR s.is_enabled)
          ORDER BY s.position ASC`,
        [tid, enabledOnly],
      );
      return result.rows.map(mapWorkflowState);
    },

    async loadOrder(tid: string, orderId: string): Promise<OrderRecord | null> {
      const result = await q.query<OrderRow>('SELECT * FROM orders WHERE tenant_id = $1 AND id = $2', [tid, orderId]);
      return result.rows[0] === undefined ? null : mapOrder(result.rows[0]);
    },

    // B2: the uniform serialization point — lock FIRST, bump, then decide.
    async lockOrder(tid: string, orderId: string): Promise<OrderRecord | null> {
      const result = await q.query<OrderRow>('SELECT * FROM orders WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [tid, orderId]);
      return result.rows[0] === undefined ? null : mapOrder(result.rows[0]);
    },

    async bumpOrderRevision(tid: string, orderId: string): Promise<void> {
      await q.query('UPDATE orders SET revision = revision + 1 WHERE tenant_id = $1 AND id = $2', [tid, orderId]);
    },

    async loadOrderItem(tid: string, orderItemId: string): Promise<OrderItemRecord | null> {
      const result = await q.query<OrderItemRow>('SELECT * FROM order_items WHERE tenant_id = $1 AND id = $2', [tid, orderItemId]);
      return result.rows[0] === undefined ? null : mapOrderItem(result.rows[0]);
    },

    async loadActiveOrderItems(tid: string, orderId: string): Promise<readonly OrderItemRecord[]> {
      const result = await q.query<OrderItemRow>(
        'SELECT * FROM order_items WHERE tenant_id = $1 AND order_id = $2 AND NOT is_voided ORDER BY created_at ASC, id ASC',
        [tid, orderId],
      );
      return result.rows.map(mapOrderItem);
    },

    async loadMenuItem(tid: string, menuItemId: string) {
      const result = await q.query<{ id: string; name: unknown; base_price_amount_minor: string; base_price_currency_code: string; is_active: boolean }>(
        'SELECT id, name, base_price_amount_minor, base_price_currency_code, is_active FROM menu_items WHERE tenant_id = $1 AND id = $2',
        [tid, menuItemId],
      );
      const r = result.rows[0];
      return r === undefined
        ? null
        : { id: r.id, name: localized(r.name), basePriceMinor: BigInt(r.base_price_amount_minor), basePriceCurrencyCode: r.base_price_currency_code, isActive: r.is_active };
    },

    async loadOrderStatusKindFlags(kindCode: string): Promise<OrderBehaviorFlags> {
      const result = await q.query<{ behavior_flags: Record<string, unknown> }>(
        'SELECT behavior_flags FROM order_status_kinds WHERE code = $1',
        [kindCode],
      );
      const r = result.rows[0];
      if (r === undefined) throw new NotFoundError(`Platform order status kind ${kindCode} not found`);
      return parseOrderBehaviorFlags(r.behavior_flags);
    },

    async loadBranch(tid: string, branchId: string) {
      const result = await q.query<{ id: string; base_currency: string; is_active: boolean }>(
        'SELECT id, base_currency, is_active FROM branches WHERE tenant_id = $1 AND id = $2',
        [tid, branchId],
      );
      const r = result.rows[0];
      return r === undefined ? null : { id: r.id, baseCurrencyCode: r.base_currency, isActive: r.is_active };
    },

    async createWorkflow(tid: string, topLevelKinds: readonly { kindCode: string; position: number; label: LocalizedText }[]): Promise<string> {
      const existing = await q.query<{ id: string }>(
        'SELECT id FROM tenant_order_workflows WHERE tenant_id = $1',
        [tid],
      );
      let workflowId: string;
      if (existing.rows[0] === undefined) {
        const created = await q.query<{ id: string }>(
          'INSERT INTO tenant_order_workflows (tenant_id) VALUES ($1) RETURNING id',
          [tid],
        );
        workflowId = row(created.rows).id;
      } else {
        workflowId = existing.rows[0].id;
      }
      for (const kind of topLevelKinds) {
        await q.query(
          `INSERT INTO tenant_order_workflow_states (tenant_id, workflow_id, kind_code, position, label)
           VALUES ($1, $2, $3, $4, $5::jsonb)`,
          [tid, workflowId, kind.kindCode, kind.position, JSON.stringify(kind.label)],
        );
      }
      return workflowId;
    },

    async addWorkflowState(tid: string, input: { kindCode: string; parentKindCode: string | null; position: number; label: LocalizedText }): Promise<string> {
      const workflow = await q.query<{ id: string }>('SELECT id FROM tenant_order_workflows WHERE tenant_id = $1', [tid]);
      const workflowId = row(workflow.rows).id;
      if (input.parentKindCode !== null) {
        // Fail-closed configuration: a sub-state may only refine a kind that
        // already has its TOP-LEVEL state in the same workflow (otherwise the
        // order-level aggregation would have no top-level state to resolve to).
        const parent = await q.query(
          `SELECT 1 FROM tenant_order_workflow_states
            WHERE tenant_id = $1 AND workflow_id = $2 AND kind_code = $3 AND parent_kind_code IS NULL AND is_enabled`,
          [tid, workflowId, input.parentKindCode],
        );
        if (parent.rows.length === 0) {
          throw new OrderWorkflowNotConfiguredError(tid);
        }
      }
      const created = await q.query<{ id: string }>(
        `INSERT INTO tenant_order_workflow_states (tenant_id, workflow_id, kind_code, parent_kind_code, position, label)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb) RETURNING id`,
        [tid, workflowId, input.kindCode, input.parentKindCode, input.position, JSON.stringify(input.label)],
      );
      return row(created.rows).id;
    },

    async setWorkflowStateEnabled(tid: string, stateId: string, isEnabled: boolean): Promise<void> {
      await q.query('UPDATE tenant_order_workflow_states SET is_enabled = $3 WHERE tenant_id = $1 AND id = $2', [tid, stateId, isEnabled]);
    },

    async setWorkflowStatePosition(tid: string, stateId: string, position: number): Promise<void> {
      await q.query('UPDATE tenant_order_workflow_states SET position = $3 WHERE tenant_id = $1 AND id = $2', [tid, stateId, position]);
    },

    async countWorkflowStateReferences(tid: string, stateId: string): Promise<number> {
      return countWorkflowStateReferences(tid, stateId);
    },

    async deleteWorkflowState(tid: string, stateId: string): Promise<void> {
      // Application-level fail-closed pre-check (clean, explicit error). The
      // FK ON DELETE RESTRICT chain from orders / order_items /
      // order_item_status_events remains the structural guarantee.
      const refs = await countWorkflowStateReferences(tid, stateId);
      if (refs > 0) throw new WorkflowStateInUseError(stateId);
      await q.query('DELETE FROM tenant_order_workflow_states WHERE tenant_id = $1 AND id = $2', [tid, stateId]);
    },

    async resolveStationRoute(tid: string, branchId: string, context: StationRoutingContext): Promise<StationRoutingDecision | null> {
      // DETERMINISTIC TIE-BREAK: specificity_score DESC, priority_weight DESC,
      // rule_id ASC — exactly one reproducible winner; never a default route.
      const result = await q.query<{ id: string; station_id: string; specificity_score: string; priority_weight: number }>(
        `SELECT id, station_id, priority_weight,
            ((CASE WHEN menu_item_id IS NOT NULL THEN 100 ELSE 0 END)
           + (CASE WHEN sales_channel_code IS NOT NULL THEN 20 ELSE 0 END)
           + (CASE WHEN order_type IS NOT NULL THEN 10 ELSE 0 END))::text AS specificity_score
           FROM station_routing_rules
          WHERE tenant_id = $1 AND branch_id = $2 AND is_enabled
            AND (menu_item_id IS NULL OR menu_item_id = $3)
            AND (sales_channel_code IS NULL OR sales_channel_code = $4)
            AND (order_type IS NULL OR order_type = $5)
            AND EXISTS (SELECT 1 FROM stations s WHERE s.id = station_routing_rules.station_id AND s.is_active)
          ORDER BY specificity_score DESC, priority_weight DESC, id ASC
          LIMIT 1`,
        [tid, branchId, context.menuItemId, context.salesChannelCode, context.orderType],
      );
      const r = result.rows[0];
      return r === undefined
        ? null
        : { ruleId: r.id, stationId: r.station_id, specificityScore: Number(r.specificity_score), priorityWeight: r.priority_weight };
    },

    async insertOrder(tid: string, order: { id: string; branchId: string; orderType: OrderType; salesChannelCode: string; deliveryPlatformId: string | null; tableId: string | null; initialStatusKindId: string; placedAt: Date; splitPeopleCount: number | null }): Promise<void> {
      await q.query(
        `INSERT INTO orders (id, tenant_id, branch_id, order_type, sales_channel_code, delivery_platform_id, table_id, current_status_kind_id, split_people_count, placed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [order.id, tid, order.branchId, order.orderType, order.salesChannelCode, order.deliveryPlatformId, order.tableId, order.initialStatusKindId, order.splitPeopleCount, order.placedAt],
      );
    },

    async insertOrderItem(tid: string, item: { id: string; orderId: string; menuItemId: string; itemNameSnapshot: LocalizedText; unitPriceMinor: bigint; quantity: number; modifiersSnapshot: readonly OrderItemModifierSnapshot[]; initialStatusKindId: string; stationId: string; createdAt: Date; splitGroupId: string | null }): Promise<void> {
      await q.query(
        `INSERT INTO order_items (id, tenant_id, order_id, menu_item_id, item_name_snapshot, unit_price_minor, quantity, modifiers_snapshot, current_status_kind_id, station_id, split_group_id, created_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8::jsonb, $9, $10, $11, $12)`,
        [
          item.id,
          tid,
          item.orderId,
          item.menuItemId,
          JSON.stringify(item.itemNameSnapshot),
          item.unitPriceMinor.toString(),
          item.quantity,
          // The snapshot carries bigint minor amounts, which JSON.stringify rejects;
          // serialize them as exact decimal strings (pass-through evidence, never math input).
          JSON.stringify(item.modifiersSnapshot, (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value),
          item.initialStatusKindId,
          item.stationId,
          item.splitGroupId,
          item.createdAt,
        ],
      );
    },

    async findOpenShiftForCashier(tid: string, cashierUserId: string, branchId: string): Promise<{ id: string } | null> {
      // The Phase-8 shift gateway probe (order creation).
      const result = await q.query<{ id: string }>(
        `SELECT id FROM shift_reconciliations
          WHERE tenant_id = $1 AND cashier_id = $2 AND branch_id = $3 AND status = 'open'
          LIMIT 1`,
        [tid, cashierUserId, branchId],
      );
      return result.rows[0] === undefined ? null : { id: result.rows[0].id };
    },

    async insertInitialStatusEvent(tid: string, orderItemId: string, orderId: string, toWorkflowStateId: string, occurredAt: Date): Promise<void> {
      await q.query(
        `INSERT INTO order_item_status_events (tenant_id, order_item_id, order_id, from_status_kind_id, to_status_kind_id, occurred_at)
         VALUES ($1, $2, $3, NULL, $4, $5)`,
        [tid, orderItemId, orderId, toWorkflowStateId, occurredAt],
      );
    },

    async resolveInvoiceTax(tid: string, inputs: readonly { orderLineId: string; branchId: string; menuItemId: string; customerAmountMinor: bigint; currencyCode: string; at: Date; salesChannel: string; deliveryPlatformId: string | null }[]): Promise<ReadonlyMap<string, TaxResolution>> {
      // B4: the whole invoice resolves in ONE call on this transaction —
      // allocations are made before ANY snapshot write (invoice_total), and
      // the per_line result is mathematically identical to isolated lines.
      return resolveInvoiceAndSnapshot(tax, tid, inputs.map((input) => ({
        orderLineId: input.orderLineId,
        branchId: input.branchId,
        menuItemId: input.menuItemId,
        grossOrNetAmountMinor: input.customerAmountMinor,
        currencyCode: input.currencyCode,
        at: input.at,
        salesChannel: input.salesChannel,
        deliveryPlatformId: input.deliveryPlatformId,
      })));
    },

    async insertStatusEvent(tid: string, input: { orderItemId: string; orderId: string; fromWorkflowStateId: string | null; toWorkflowStateId: string; actorUserId: string | null; occurredAt: Date }): Promise<void> {
      await q.query(
        `INSERT INTO order_item_status_events (tenant_id, order_item_id, order_id, from_status_kind_id, to_status_kind_id, actor_user_id, occurred_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [tid, input.orderItemId, input.orderId, input.fromWorkflowStateId, input.toWorkflowStateId, input.actorUserId, input.occurredAt],
      );
    },

    async readOutboxEvents(tid: string, branchId: string, afterSequenceId: number, limit: number): Promise<readonly OrderOutboxEvent[]> {
      const result = await q.query<OutboxRow>(
        `SELECT id, tenant_id, branch_id, sequence_id, event_type, payload, created_at
           FROM order_events_outbox
          WHERE tenant_id = $1 AND branch_id = $2 AND sequence_id > $3
          ORDER BY sequence_id ASC
          LIMIT $4`,
        [tid, branchId, afterSequenceId, limit],
      );
      return result.rows.map(mapOutboxEvent);
    },

    async lastOutboxSequence(tid: string, branchId: string): Promise<number> {
      const result = await q.query<{ last_sequence: string }>(
        'SELECT last_sequence::text FROM order_event_sequences WHERE tenant_id = $1 AND branch_id = $2',
        [tid, branchId],
      );
      const r = result.rows[0];
      return r === undefined ? 0 : Number(r.last_sequence);
    },

    async loadEventsWithBehaviorFlags(tid: string, limit: number, branchId?: string  ): Promise<readonly OrderOutboxEvent[]> {
      const result = await q.query<OutboxRow>(
        `SELECT id, tenant_id, branch_id, sequence_id, event_type, payload, created_at
           FROM order_events_outbox
          WHERE tenant_id = $1
            AND ($3::uuid IS NULL OR branch_id = $3::uuid)
            AND payload ? 'behavior_flags'
            AND ((payload->'behavior_flags'->>'fires_kitchen_ticket')::boolean
              OR (payload->'behavior_flags'->>'notifies_customer')::boolean)
          ORDER BY branch_id ASC, sequence_id ASC
          LIMIT $2`,
        [tid, limit, branchId ?? null],
      );
      return result.rows.map(mapOutboxEvent);
    },

    async claimSideEffect(tid: string, outboxEventId: string, sideEffectType: SideEffectType, stalePendingAfterMs: number): Promise<SideEffectClaimOutcome> {
      // CLAIM-THEN-EXECUTE: the INSERT is the ownership claim; a conflict
      // means an earlier attempt exists (succeeded → skip, failed/stale → retry).
      const claimed = await q.query<{ attempt_count: number }>(
        `INSERT INTO side_effect_delivery_log (outbox_event_id, side_effect_type, status, attempt_count)
         VALUES ($1, $2, 'pending', 1)
         ON CONFLICT (outbox_event_id, side_effect_type) DO NOTHING
         RETURNING attempt_count`,
        [outboxEventId, sideEffectType],
      );
      if (claimed.rows[0] !== undefined) {
        return { outcome: 'claimed', attemptCount: claimed.rows[0].attempt_count };
      }
      const existing = await q.query<{ status: 'pending' | 'succeeded' | 'failed'; attempt_count: number; updated_at: Date }>(
        `SELECT status, attempt_count, updated_at FROM side_effect_delivery_log
          WHERE outbox_event_id = $1 AND side_effect_type = $2
          FOR UPDATE`,
        [outboxEventId, sideEffectType],
      );
      const prior = existing.rows[0];
      if (prior === undefined) {
        // The outbox row must have been deleted between the two statements —
        // impossible through the app role (RESTRICT + no DELETE grant).
        throw new Error('side_effect_delivery_log row disappeared inside the claim transaction');
      }
      if (prior.status === 'succeeded') {
        return { outcome: 'succeeded', attemptCount: prior.attempt_count };
      }
      const staleBefore = new Date(Date.now() - stalePendingAfterMs);
      if (prior.status === 'pending' && prior.updated_at > staleBefore) {
        // A live attempt owns the row right now — do not double-execute.
        return { outcome: 'succeeded', attemptCount: prior.attempt_count };
      }
      const retried = await q.query<{ attempt_count: number }>(
        `UPDATE side_effect_delivery_log
            SET attempt_count = attempt_count + 1, status = 'pending', updated_at = now()
          WHERE outbox_event_id = $1 AND side_effect_type = $2
          RETURNING attempt_count`,
        [outboxEventId, sideEffectType],
      );
      return { outcome: 'retry', attemptCount: row(retried.rows).attempt_count };
    },

    async markSideEffect(tid: string, outboxEventId: string, sideEffectType: SideEffectType, status: 'succeeded' | 'failed', errorMessage?: string): Promise<void> {
      await q.query(
        `UPDATE side_effect_delivery_log
            SET status = $3, last_error = $4, updated_at = now(),
                executed_at = CASE WHEN $3 = 'succeeded' THEN now() ELSE executed_at END
          WHERE outbox_event_id = $1 AND side_effect_type = $2`,
        [outboxEventId, sideEffectType, status, errorMessage ?? null],
      );
    },

    async loadVoidReason(tid: string, voidReasonId: string) {
      const result = await q.query<{
        id: string;
        required_permission_tier: VoidPermissionTier;
        is_enabled: boolean;
        kind_code: string;
        kind_setting_enabled: boolean;
      }>(
        `SELECT r.id, r.required_permission_tier, r.is_enabled,
                r.void_reason_kind_code AS kind_code,
                COALESCE(s.is_enabled, true) AS kind_setting_enabled
           FROM tenant_void_reasons r
           LEFT JOIN tenant_void_reason_kind_settings s
             ON s.tenant_id = r.tenant_id AND s.void_reason_kind_code = r.void_reason_kind_code
          WHERE r.tenant_id = $1 AND r.id = $2`,
        [tid, voidReasonId],
      );
      const r = result.rows[0];
      return r === undefined
        ? null
        : { id: r.id, requiredPermissionTier: r.required_permission_tier, isEnabled: r.is_enabled, kindCode: r.kind_code, kindSettingEnabled: r.kind_setting_enabled };
    },

    async loadVoidTimeLimitMinutes(tid: string): Promise<number | null> {
      const result = await q.query<{ void_time_limit_minutes: number | null }>(
        'SELECT void_time_limit_minutes FROM tenant_void_settings WHERE tenant_id = $1',
        [tid],
      );
      return result.rows[0]?.void_time_limit_minutes ?? null;
    },

    async resolveVoidPermissionTier(tid: string, userId: string): Promise<VoidPermissionTier | null> {
      const result = await q.query<{ permission_key: string }>(
        `SELECT DISTINCT rp.permission_key
           FROM users u
           JOIN tenants t ON t.id = u.tenant_id
           JOIN user_roles ur ON ur.user_id = u.id AND ur.tenant_id = u.tenant_id
           JOIN roles r ON r.id = ur.role_id AND r.tenant_id = ur.tenant_id
           JOIN role_permissions rp ON rp.role_id = r.id AND rp.tenant_id = r.tenant_id
          WHERE u.id = $2 AND u.tenant_id = $1 AND u.is_active AND t.status = 'active' AND ur.is_active
            AND rp.permission_key = ANY($3::text[])`,
        [tid, userId, ['order:void', 'order:void:shift_supervisor', 'order:void:manager']],
      );
      let tier: VoidPermissionTier | null = null;
      for (const r of result.rows) {
        if (r.permission_key === 'order:void:manager') tier = 'manager';
        else if (r.permission_key === 'order:void:shift_supervisor' && tier !== 'manager') tier = 'shift_supervisor';
        else if (r.permission_key === 'order:void' && tier === null) tier = 'server';
      }
      return tier;
    },

    async userIsActiveMember(tid: string, userId: string): Promise<boolean> {
      const result = await q.query(
        `SELECT 1 FROM users u JOIN tenants t ON t.id = u.tenant_id
          WHERE u.id = $2 AND u.tenant_id = $1 AND u.is_active AND t.status = 'active'`,
        [tid, userId],
      );
      return result.rows.length > 0;
    },

    async appendEvent(tid: string, branchId: string, eventType: string, payload: Readonly<Record<string, unknown>>): Promise<number> {
      const result = await q.query<{ append_order_event: string }>(
        'SELECT append_order_event($1, $2, $3, $4::jsonb) AS append_order_event',
        [tid, branchId, eventType, JSON.stringify(payload)],
      );
      return Number(row(result.rows).append_order_event);
    },

    async markOrderItemsVoided(tid: string, orderItemIds: readonly string[]): Promise<void> {
      if (orderItemIds.length === 0) return;
      await q.query(
        'UPDATE order_items SET is_voided = true, voided_at = now() WHERE tenant_id = $1 AND id = ANY($2::uuid[])',
        [tid, orderItemIds],
      );
    },

    async setOrderPaymentStatus(tid: string, orderId: string, paymentStatus: OrderPaymentStatus): Promise<void> {
      await q.query('UPDATE orders SET payment_status = $3 WHERE tenant_id = $1 AND id = $2', [tid, orderId, paymentStatus]);
    },

    async recomputeOrderStatus(tid: string, orderId: string): Promise<string | null> {
      const result = await q.query<{ recompute_order_status: string | null }>(
        'SELECT recompute_order_status($1, $2) AS recompute_order_status',
        [tid, orderId],
      );
      return row(result.rows).recompute_order_status;
    },

    async insertOrderVoid(tid: string, record: { id: string; orderId: string; orderItemId: string | null; actorUserId: string; actorPermissionTier: VoidPermissionTier; voidReasonId: string; requiredManagerOverride: boolean; managerUserId: string | null; overrideAuthenticatedAt: Date | null; orderPaymentStatusAtVoidTime: OrderPaymentStatus; notes: string | null }): Promise<OrderVoidAuditRecord> {
      const result = await q.query<{
        id: string;
        order_id: string;
        order_item_id: string | null;
        actor_user_id: string;
        actor_permission_tier: VoidPermissionTier;
        void_reason_id: string;
        required_manager_override: boolean;
        manager_user_id: string | null;
        override_authenticated_at: Date | null;
        order_payment_status_at_void_time: OrderPaymentStatus;
        notes: string | null;
        occurred_at: Date;
      }>(
        `INSERT INTO order_voids (id, tenant_id, order_id, order_item_id, actor_user_id, actor_permission_tier,
                                  void_reason_id, required_manager_override, manager_user_id, override_authenticated_at,
                                  order_payment_status_at_void_time, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING id, order_id, order_item_id, actor_user_id, actor_permission_tier, void_reason_id,
                   required_manager_override, manager_user_id, override_authenticated_at,
                   order_payment_status_at_void_time, notes, occurred_at`,
        [
          record.id,
          tid,
          record.orderId,
          record.orderItemId,
          record.actorUserId,
          record.actorPermissionTier,
          record.voidReasonId,
          record.requiredManagerOverride,
          record.managerUserId,
          record.overrideAuthenticatedAt,
          record.orderPaymentStatusAtVoidTime,
          record.notes ?? null,
        ],
      );
      const r = row(result.rows);
      return {
        id: r.id,
        tenantId: tid,
        orderId: r.order_id,
        orderItemId: r.order_item_id,
        actorUserId: r.actor_user_id,
        actorPermissionTier: r.actor_permission_tier,
        voidReasonId: r.void_reason_id,
        requiredManagerOverride: r.required_manager_override,
        managerUserId: r.manager_user_id,
        overrideAuthenticatedAt: r.override_authenticated_at,
        orderPaymentStatusAtVoidTime: r.order_payment_status_at_void_time,
        notes: r.notes,
        occurredAt: r.occurred_at,
      };
    },

    async loadRecipeRequirements(tid: string, owners: readonly RecipeOwnerRef[]): Promise<readonly RecipeRequirementLine[]> {
      if (owners.length === 0) return [];
      // One statement over the recipe_ingredients view (the single read
      // source for products + modifiers); tuple-IN, one round trip.
      const values: string[] = [tid];
      const tuples = owners.map((owner) => {
        values.push(owner.ownerType, owner.ownerId);
        return `($${values.length - 1}, $${values.length})`;
      });
      const result = await q.query<{
        owner_type: RecipeOwnerType;
        owner_id: string;
        inventory_item_id: string;
        quantity_required: string;
      }>(
        `SELECT owner_type, owner_id, inventory_item_id, quantity_required
           FROM recipe_ingredients WHERE tenant_id = $1 AND (owner_type, owner_id) IN (${tuples.join(', ')})`,
        values,
      );
      return result.rows.map((r) => ({
        ownerType: r.owner_type,
        ownerId: r.owner_id,
        inventoryItemId: r.inventory_item_id,
        quantityRequired: r.quantity_required,
      }));
    },

    async loadInventoryItems(tid: string, branchId: string, inventoryItemIds: readonly string[]): Promise<readonly InventoryItemRecord[]> {
      if (inventoryItemIds.length === 0) return [];
      const result = await q.query<InventoryItemRow>(
        `SELECT id, tenant_id, branch_id, name, base_unit, current_quantity, low_stock_threshold, is_active
           FROM inventory_items WHERE tenant_id = $1 AND branch_id = $2 AND id = ANY($3::uuid[])`,
        [tid, branchId, inventoryItemIds],
      );
      return result.rows.map(mapInventoryItem);
    },

    async insertStockMovement(tid: string, movement: InsertStockMovementInput): Promise<StockMovementRecord> {
      try {
        return await insertStockMovementRow(q, tid, movement);
      } catch (error: unknown) {
        // The shortage gate lives in the trigger (the backstop for races);
        // map it to the cashier-facing error (same discipline as
        // rethrowCatalogWriteError — code + stable message prefix, nothing
        // else; every other error propagates untouched).
        if (isStockShortageTriggerError(error)) {
          throw new InsufficientStockError(
            movement.inventoryItemDisplayName ?? movement.inventoryItemId,
            movement.inventoryItemId,
            movement.branchId,
            { cause: error instanceof Error ? error : undefined },
          );
        }
        throw error;
      }
    },

    async insertStockOverrideClaim(tid: string, claim: ClaimStockOverrideInput): Promise<void> {
      // Single-use claim (0040): the PRIMARY KEY rejects any second claim of
      // the same attempt (23505, fail-closed) — the engine only ever claims
      // the attempt id its own verifyLiveChallengeWithId call just returned.
      await q.query('INSERT INTO stock_override_claims (manager_override_id, tenant_id, order_id) VALUES ($1, $2, $3)', [
        claim.managerOverrideId,
        tid,
        claim.orderId,
      ]);
    },

    async loadSaleDeductionsForOrderItems(tid: string, orderItemIds: readonly string[]): Promise<readonly SaleDeductionAggregate[]> {
      if (orderItemIds.length === 0) return [];
      const result = await q.query<{ order_item_id: string; inventory_item_id: string; total_deducted: string }>(
        `SELECT order_item_id, inventory_item_id, SUM(quantity_delta) AS total_deducted
           FROM stock_movements
          WHERE tenant_id = $1 AND order_item_id = ANY($2::uuid[]) AND movement_type = 'sale_deduction'
          GROUP BY order_item_id, inventory_item_id`,
        [tid, orderItemIds],
      );
      return result.rows.map((r) => ({
        orderItemId: r.order_item_id,
        inventoryItemId: r.inventory_item_id,
        totalDeducted: r.total_deducted,
      }));
    },

    async loadItemsWithKitchenTicketFired(tid: string, orderItemIds: readonly string[]): Promise<readonly string[]> {
      if (orderItemIds.length === 0) return [];
      // "Has this item EVER been in a ticket-firing state" — across the FULL
      // immutable event history (initial event included), resolved through
      // the tenant's workflow states to the platform kind flags.
      const result = await q.query<{ order_item_id: string }>(
        `SELECT DISTINCT e.order_item_id
           FROM order_item_status_events e
           JOIN tenant_order_workflow_states s ON s.id = e.to_status_kind_id AND s.tenant_id = e.tenant_id
           JOIN order_status_kinds k ON k.code = s.kind_code
          WHERE e.tenant_id = $1 AND e.order_item_id = ANY($2::uuid[])
            AND (k.behavior_flags ->> 'fires_kitchen_ticket')::boolean IS TRUE`,
        [tid, orderItemIds],
      );
      return result.rows.map((r) => r.order_item_id);
    },
  };
}
