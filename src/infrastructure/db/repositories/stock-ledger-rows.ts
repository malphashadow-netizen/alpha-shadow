/**
 * Shared Phase-9 stock-ledger row shapes, mappers and the single-row movement
 * writer used by the orders, payments and inventory adapters.
 *
 * One SQL statement for the movement INSERT (same sharing precedent as
 * tax-row-mappers.ts): the orders store wraps it with the shortage-gate
 * mapping (23514 + prefix → InsufficientStockError); the payments and
 * inventory stores use it plainly (waste/manual rows can never trip the
 * sale-only gate, so a trigger rejection there is a bug signal, not a
 * user-facing error).
 *
 * This module never imports pg; callers pass the transaction-scoped
 * TenantQuery (see eslint-rules/pg-import-policy.ts).
 */
import type {
  InsertStockMovementInput,
  InventoryItemRecord,
  StockMovementRecord,
  StockMovementType,
} from '../../../domain/contracts/inventory.ts';
import type { LocalizedText } from '../../../domain/contracts/catalog.ts';
import type { TenantQuery } from '../tenant-context.ts';

export function localized(value: unknown): LocalizedText {
  return (value ?? {}) as LocalizedText;
}

export interface InventoryItemRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly branch_id: string;
  readonly name: unknown;
  readonly base_unit: string;
  readonly current_quantity: string;
  readonly low_stock_threshold: string | null;
  readonly is_active: boolean;
}

export function mapInventoryItem(r: InventoryItemRow): InventoryItemRecord {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    branchId: r.branch_id,
    name: localized(r.name),
    baseUnit: r.base_unit,
    currentQuantity: r.current_quantity,
    lowStockThreshold: r.low_stock_threshold,
    isActive: r.is_active,
  };
}

export interface MovementRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly branch_id: string;
  readonly inventory_item_id: string;
  readonly movement_type: StockMovementType;
  readonly quantity_delta: string;
  readonly order_id: string | null;
  readonly order_item_id: string | null;
  readonly actor_user_id: string;
  readonly manager_override_id: string | null;
  readonly adjustment_reason_id: string | null;
  readonly occurred_at: Date;
}

export function mapStockMovement(r: MovementRow): StockMovementRecord {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    branchId: r.branch_id,
    inventoryItemId: r.inventory_item_id,
    movementType: r.movement_type,
    quantityDelta: r.quantity_delta,
    orderId: r.order_id,
    orderItemId: r.order_item_id,
    actorUserId: r.actor_user_id,
    managerOverrideId: r.manager_override_id,
    adjustmentReasonId: r.adjustment_reason_id,
    occurredAt: r.occurred_at,
  };
}

/** Appends ONE movement row (the engine/store loops; the failing row stays identifiable). */
export async function insertStockMovementRow(
  q: TenantQuery,
  tenantId: string,
  movement: InsertStockMovementInput,
): Promise<StockMovementRecord> {
  const result = await q.query<MovementRow>(
    `INSERT INTO stock_movements (tenant_id, branch_id, inventory_item_id, movement_type, quantity_delta,
                                  order_id, order_item_id, actor_user_id, manager_override_id, adjustment_reason_id, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id, tenant_id, branch_id, inventory_item_id, movement_type, quantity_delta,
               order_id, order_item_id, actor_user_id, manager_override_id, adjustment_reason_id, occurred_at`,
    [
      tenantId,
      movement.branchId,
      movement.inventoryItemId,
      movement.movementType,
      movement.quantityDelta,
      movement.orderId,
      movement.orderItemId,
      movement.actorUserId,
      movement.managerOverrideId,
      movement.adjustmentReasonId,
      movement.occurredAt ?? new Date(),
    ],
  );
  const r = result.rows[0];
  if (r === undefined) throw new Error('Stock movement could not be inserted');
  return mapStockMovement(r);
}
