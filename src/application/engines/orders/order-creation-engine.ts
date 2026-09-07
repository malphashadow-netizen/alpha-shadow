/**
 * Order-creation engine (Phase 7).
 *
 * One transaction per order (repeatable read, tenant verified): the order row,
 * every item (name/price/modifier snapshot + station resolved by an EXPLICIT
 * routing rule), the initial status events and the Phase-6 tax contexts and
 * snapshots (order_items.id IS order_line_tax_contexts.order_line_id — the
 * documented seam). If ANY item has no matching routing rule, the whole order
 * is refused (fail-closed) and nothing is written — including outbox rows.
 */
import { randomUUID } from 'node:crypto';
import type {
  CreatedOrder,
  CreatedOrderItem,
  NewOrderInput,
  OrdersStore,
  OrderItemModifierSnapshot,
  TenantWorkflowState,
} from '../../../domain/contracts/orders.ts';
import { NoMatchingRoutingRuleError, NotFoundError, OrderWorkflowNotConfiguredError, ValidationError } from '../../../shared/errors.ts';

export interface OrderCreationEngineDependencies {
  readonly store: OrdersStore;
}

const MAX_ITEMS_PER_ORDER = 500;

export class OrderCreationEngine {
  private readonly dependencies: OrderCreationEngineDependencies;

  constructor(dependencies: OrderCreationEngineDependencies) {
    this.dependencies = dependencies;
  }

  async create(tenantId: string, input: NewOrderInput): Promise<CreatedOrder> {
    if (input.items.length === 0) {
      throw new ValidationError('An order must contain at least one item');
    }
    if (input.items.length > MAX_ITEMS_PER_ORDER) {
      throw new ValidationError(`An order cannot exceed ${MAX_ITEMS_PER_ORDER} items`);
    }
    const occurredAt = input.occurredAt ?? new Date();

    return this.dependencies.store.run(tenantId, async (scope) => {
      const branch = await scope.loadBranch(tenantId, input.branchId);
      if (!branch?.isActive) {
        throw new NotFoundError(`Branch ${input.branchId} is not an active branch of tenant ${tenantId}`);
      }
      // The tenant's effective sequence decides the initial state — there is
      // no hard-coded "received": a tenant whose workflow starts at
      // "confirmed" starts there.
      const enabledStates = await scope.loadWorkflowStates(tenantId, true);
      const initialState = initialTopLevelState(enabledStates);
      if (initialState === null) throw new OrderWorkflowNotConfiguredError(tenantId);

      const orderId = randomUUID();
      await scope.insertOrder(tenantId, {
        id: orderId,
        branchId: input.branchId,
        orderType: input.orderType,
        salesChannelCode: input.salesChannelCode,
        deliveryPlatformId: input.deliveryPlatformId ?? null,
        tableId: input.tableId ?? null,
        initialStatusKindId: initialState.id,
        placedAt: occurredAt,
      });

      const createdItems: CreatedOrderItem[] = [];
      for (const line of input.items) {
        if (!Number.isInteger(line.quantity) || line.quantity < 1) {
          throw new ValidationError('Item quantity must be a positive integer', 'items');
        }
        const menuItem = await scope.loadMenuItem(tenantId, line.menuItemId);
        if (!menuItem?.isActive) {
          throw new ValidationError(`Menu item ${line.menuItemId} is not an active catalog item`);
        }
        // FAIL-CLOSED routing: an item without an explicit station cannot
        // exist; the whole order creation is refused.
        const routing = await scope.resolveStationRoute(tenantId, input.branchId, {
          menuItemId: line.menuItemId,
          salesChannelCode: input.salesChannelCode,
          orderType: input.orderType,
        });
        if (routing === null) {
          throw new NoMatchingRoutingRuleError(input.branchId, line.menuItemId);
        }

        // Permanent purchase-evidence snapshot (order-time values).
        const unitPriceMinor = line.unitPriceMinor ?? menuItem.basePriceMinor;
        const modifiers: readonly OrderItemModifierSnapshot[] = line.modifiers ?? [];
        const itemId = randomUUID();
        await scope.insertOrderItem(tenantId, {
          id: itemId,
          orderId,
          menuItemId: line.menuItemId,
          itemNameSnapshot: menuItem.name,
          unitPriceMinor,
          quantity: line.quantity,
          modifiersSnapshot: modifiers,
          initialStatusKindId: initialState.id,
          stationId: routing.stationId,
          createdAt: occurredAt,
        });
        // The initial event (from NULL → initial state) is the first row of
        // the immutable ledger; the triggers derive the item status and write
        // the outbox evidence in this same transaction.
        await scope.insertInitialStatusEvent(tenantId, itemId, orderId, initialState.id, occurredAt);

        // Phase-6 tax seam: the tax engine writes order_line_tax_contexts and
        // the immutable snapshots with order_line_id = this item's id, inside
        // the SAME transaction (the customer price, never platform proceeds).
        const lineAmount = unitPriceMinor * BigInt(line.quantity);
        const taxes = await scope.resolveLineTax(tenantId, {
          orderLineId: itemId,
          branchId: input.branchId,
          menuItemId: line.menuItemId,
          customerAmountMinor: lineAmount,
          currencyCode: branch.baseCurrencyCode,
          at: occurredAt,
          salesChannel: input.salesChannelCode,
          deliveryPlatformId: input.deliveryPlatformId ?? null,
        });

        const item = await scope.loadOrderItem(tenantId, itemId);
        if (item === null) throw new ValidationError('Created order item could not be read back');
        createdItems.push({ item, taxes });
      }

      const order = await scope.loadOrder(tenantId, orderId);
      if (order === null) throw new ValidationError('Created order could not be read back');
      return { order, items: createdItems };
    });
  }
}

function initialTopLevelState(states: readonly TenantWorkflowState[]): TenantWorkflowState | null {
  const topLevel = states.filter((s) => s.parentKindCode === null);
  if (topLevel.length === 0) return null;
  return topLevel.reduce((min, s) => (s.position < min.position ? s : min));
}
