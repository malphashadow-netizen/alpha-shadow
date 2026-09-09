/**
 * Order-creation engine (Phase 7 + the Phase 8 shift gateway + Phase 9 stock).
 *
 * One transaction per order (repeatable read, tenant verified): the order row,
 * every item (name/price/modifier snapshot + station resolved by an EXPLICIT
 * routing rule), the initial status events and the Phase-6 tax contexts and
 * snapshots (order_items.id IS order_line_tax_contexts.order_line_id — the
 * documented seam). If ANY item has no matching routing rule, the whole order
 * is refused (fail-closed) and nothing is written — including outbox rows.
 *
 * Phase 8 — THE SHIFT GATEWAY: a new order can only be created by a cashier
 * who is an active member of the tenant AND holds a standing status='open'
 * shift at the order's branch. No open shift, no new order — never an
 * implicit allow (CashierShiftRequiredError; the payments engine enforces
 * the same gateway structurally for payments).
 *
 * Phase 9 — STOCK (same verify-then-act shape as the discount engine):
 *   1. Pre-flight read transaction — authorization FIRST (branch, active
 *      membership, open shift), THEN stock aggregation. An unauthorized
 *      caller learns NOTHING about stock levels (no oracle): the stock read
 *      is unreachable without passing the gates first.
 *   2. When the pre-flight finds a shortage, the optional manager challenge
 *      is verified (context 'stock_override', its own committed transaction
 *      BEFORE the write transaction's snapshot is taken) and the attempt id
 *      is carried forward. No challenge → InsufficientStockError naming the
 *      component and branch. The approving manager must personally hold the
 *      sensitive 'inventory:adjust' key (a sale into shortage is economically
 *      a downward adjustment).
 *   3. The write transaction re-checks everything authoritatively (existing
 *      gates, then FRESH requirements + quantities with clean errors) and
 *      appends the sale_deduction rows — plus the single-use claim when an
 *      override was challenged — in the SAME commit as the order. The
 *      database trigger remains the ultimate backstop for races (mapped back
 *      to InsufficientStockError by the store).
 */
import { randomUUID } from 'node:crypto';
import type {
  CreatedOrder,
  CreatedOrderItem,
  ManagerOverrideAuthenticator,
  NewOrderInput,
  NewOrderItemLine,
  OrdersStore,
  OrderItemModifierSnapshot,
  TenantWorkflowState,
} from '../../../domain/contracts/orders.ts';
import type { LocalizedText } from '../../../domain/contracts/catalog.ts';
import {
  STOCK_QUANTITY_SCALE,
  type InventoryItemRecord,
  type RecipeOwnerRef,
  type RecipeRequirementLine,
} from '../../../domain/contracts/inventory.ts';
import type { AuthorizationEngine } from '../rbac/authorization-engine.ts';
import { decimalTextToMinor, minorToDecimalText } from '../../../shared/decimal-text.ts';
import {
  CashierShiftRequiredError,
  ForbiddenError,
  InsufficientStockError,
  ManagerOverrideAuthenticationError,
  NoMatchingRoutingRuleError,
  NotFoundError,
  OrderWorkflowNotConfiguredError,
  TaxConfigurationError,
  ValidationError,
} from '../../../shared/errors.ts';

export interface OrderCreationEngineDependencies {
  readonly store: OrdersStore;
  readonly authorization: Pick<AuthorizationEngine, 'check'>;
  /** The live manager-override PIN challenge port (never a name list). */
  readonly managerAuthenticator: ManagerOverrideAuthenticator;
}

const MAX_ITEMS_PER_ORDER = 500;

/** The sensitive key a stock-override approver must personally hold. */
const MANAGER_STOCK_PERMISSION_KEY = 'inventory:adjust';

interface ComponentShortage {
  readonly inventoryItemId: string;
  readonly displayName: string;
}

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
    // Pure input-shape checks, up front (same errors the write transaction
    // used to raise — the pre-flight multiplies by quantity, so it must see
    // only validated lines).
    for (const line of input.items) {
      if (!Number.isInteger(line.quantity) || line.quantity < 1) {
        throw new ValidationError('Item quantity must be a positive integer', 'items');
      }
    }
    if (input.splitPeopleCount !== undefined && input.splitPeopleCount !== null && (!Number.isInteger(input.splitPeopleCount) || input.splitPeopleCount < 1)) {
      throw new ValidationError('splitPeopleCount must be a positive integer (display-only)', 'splitPeopleCount');
    }
    const occurredAt = input.occurredAt ?? new Date();

    // ── Step 1: pre-flight (ONE read transaction). Authorization gates run
    // BEFORE any stock read — fail fast, leak nothing.
    const pre = await this.dependencies.store.run(tenantId, async (scope) => {
      const branch = await scope.loadBranch(tenantId, input.branchId);
      if (!branch?.isActive) {
        throw new NotFoundError(`Branch ${input.branchId} is not an active branch of tenant ${tenantId}`);
      }
      if (!(await scope.userIsActiveMember(tenantId, input.cashierUserId))) {
        throw new ForbiddenError('the creating cashier is not an active member of the tenant');
      }
      if ((await scope.findOpenShiftForCashier(tenantId, input.cashierUserId, input.branchId)) === null) {
        throw new CashierShiftRequiredError(input.cashierUserId, input.branchId);
      }
      const lines = await scope.loadRecipeRequirements(tenantId, collectRecipeOwners(input.items));
      const requiredByComponent = aggregateRequiredMinor(lines, input.items);
      const stocked =
        requiredByComponent.size === 0
          ? []
          : await scope.loadInventoryItems(tenantId, input.branchId, [...requiredByComponent.keys()]);
      return {
        requiredByComponent,
        quantities: new Map(stocked.map((item) => [item.id, item] as const)),
      };
    });

    // ── Step 2: shortage decision on the pre-flight snapshot; the live
    // challenge (when needed) commits BEFORE the write transaction starts.
    let overrideAttemptId: string | null = null;
    const shortage = findShortage(pre.requiredByComponent, pre.quantities);
    if (shortage !== null) {
      const challenge = input.managerOverride;
      if (challenge === undefined) {
        throw new InsufficientStockError(shortage.displayName, shortage.inventoryItemId, input.branchId);
      }
      try {
        await this.dependencies.authorization.check({
          tenantId,
          userId: challenge.managerUserId,
          permissionKey: MANAGER_STOCK_PERMISSION_KEY,
          context: { hasResource: false, actorBranchId: null, isSensitivePermission: true },
        });
      } catch (error: unknown) {
        throw new ManagerOverrideAuthenticationError(
          'Manager override rejected: the approving manager does not hold the inventory:adjust permission',
          { cause: error instanceof Error ? error : undefined },
        );
      }
      // No order id: the order does not exist yet (NULL is recorded —
      // truthful); the single-use claim binds the attempt to the order
      // inside the write transaction.
      const verified = await this.dependencies.managerAuthenticator.verifyLiveChallengeWithId(
        tenantId,
        challenge.managerUserId,
        challenge.managerOverridePin,
        input.cashierUserId,
        'stock_override',
      );
      overrideAttemptId = verified.attemptId;
    }

    // ── Step 3: the write transaction (authoritative re-checks + the order
    // + tax + stock rows, all in ONE commit).
    return this.dependencies.store.run(tenantId, async (scope) => {
      const branch = await scope.loadBranch(tenantId, input.branchId);
      if (!branch?.isActive) {
        throw new NotFoundError(`Branch ${input.branchId} is not an active branch of tenant ${tenantId}`);
      }
      // THE SHIFT GATEWAY (Phase 8): the creating cashier must be an active
      // member holding the standing OPEN shift at this branch.
      if (!(await scope.userIsActiveMember(tenantId, input.cashierUserId))) {
        throw new ForbiddenError('the creating cashier is not an active member of the tenant');
      }
      if ((await scope.findOpenShiftForCashier(tenantId, input.cashierUserId, input.branchId)) === null) {
        throw new CashierShiftRequiredError(input.cashierUserId, input.branchId);
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
        splitPeopleCount: input.splitPeopleCount ?? null,
      });

      const items: CreatedOrderItem['item'][] = [];
      const taxInputs: { orderLineId: string; branchId: string; menuItemId: string; customerAmountMinor: bigint; currencyCode: string; at: Date; salesChannel: string; deliveryPlatformId: string | null }[] = [];
      for (const line of input.items) {
        const menuItem = await scope.loadMenuItem(tenantId, line.menuItemId);
        if (!menuItem?.isActive) {
          throw new ValidationError(`Menu item ${line.menuItemId} is not an active catalog item`);
        }
        // B10: the menu base price is denominated in the ITEM's currency —
        // charging it raw under a different branch currency silently
        // misprices the line (and mislabels its tax). Reject, never convert;
        // an explicit unitPriceMinor is branch-currency by contract, so it
        // legitimately bypasses the menu price.
        if (line.unitPriceMinor === undefined && menuItem.basePriceCurrencyCode !== branch.baseCurrencyCode) {
          throw new ValidationError(
            `Menu item ${line.menuItemId} is priced in ${menuItem.basePriceCurrencyCode} but branch ${input.branchId} settles in ${branch.baseCurrencyCode}: cross-currency lines are rejected — reprice the item or pass an explicit branch-currency unitPriceMinor`,
          );
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
          splitGroupId: line.splitGroupId ?? null,
        });
        // The initial event (from NULL → initial state) is the first row of
        // the immutable ledger; the triggers derive the item status and write
        // the outbox evidence in this same transaction.
        await scope.insertInitialStatusEvent(tenantId, itemId, orderId, initialState.id, occurredAt);

        // Phase-6 tax seam: collect the line's request — the tax engine
        // resolves the COMPLETE invoice once, after every item exists (B4).
        // Contexts and immutable snapshots land with order_line_id = this
        // item's id, inside the SAME transaction (the customer price, never
        // platform proceeds).
        const lineAmount = unitPriceMinor * BigInt(line.quantity);
        taxInputs.push({
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
        items.push(item);
      }

      // B4: ONE batched tax call for the complete invoice. Per-line
      // resolution cannot serve invoice_total jurisdictions (the rounded
      // unit is the invoice sum, not the line — isolated calls throw
      // InvoiceTaxBatchRequiredError), while the batch API allocates
      // before ANY snapshot write and is mathematically identical to
      // isolated lines under per_line. Every line shares branch,
      // currency, channel, platform and occurredAt by construction.
      const resolvedTaxes = await scope.resolveInvoiceTax(tenantId, taxInputs);
      const createdItems: CreatedOrderItem[] = items.map((item) => {
        const taxes = resolvedTaxes.get(item.id);
        if (taxes === undefined) throw new TaxConfigurationError('Missing invoice tax result');
        return { item, taxes };
      });

      // Phase-9 stock: FRESH requirements (recipes may have changed since the
      // pre-flight) + fresh quantities, re-checked with clean errors; then
      // the claim (when challenged) and one sale_deduction row per
      // (order line, component) — item attribution preserved so void/refund
      // mirror exact lines later. Lines and modifiers WITHOUT recipes simply
      // yield no rows (opt-in tracking; recipe-less sales proceed).
      const lines = await scope.loadRecipeRequirements(tenantId, collectRecipeOwners(input.items));
      const requiredByComponent = aggregateRequiredMinor(lines, input.items);
      if (requiredByComponent.size > 0) {
        const stocked = await scope.loadInventoryItems(tenantId, input.branchId, [...requiredByComponent.keys()]);
        const quantities = new Map(stocked.map((item) => [item.id, item] as const));
        const nowShort = findShortage(requiredByComponent, quantities);
        if (nowShort !== null && overrideAttemptId === null) {
          // Stock drained (or a recipe changed) since the pre-flight and no
          // override was challenged — fail closed (discount parity: a
          // requirement appearing after the challenge point is refused; the
          // cashier retries with the same challenge, which then verifies).
          throw new InsufficientStockError(nowShort.displayName, nowShort.inventoryItemId, input.branchId);
        }
        const grouped = groupRequirements(lines);
        if (overrideAttemptId !== null) {
          await scope.insertStockOverrideClaim(tenantId, { managerOverrideId: overrideAttemptId, orderId });
        }
        for (const [index, created] of createdItems.entries()) {
          const line = input.items[index];
          if (line === undefined) throw new ValidationError('Created order item could not be read back');
          for (const need of lineRequirements(grouped, line)) {
            const stockedItem = quantities.get(need.inventoryItemId);
            await scope.insertStockMovement(tenantId, {
              branchId: input.branchId,
              inventoryItemId: need.inventoryItemId,
              inventoryItemDisplayName:
                stockedItem === undefined ? need.inventoryItemId : displayNameOf(stockedItem.name, need.inventoryItemId),
              movementType: 'sale_deduction',
              quantityDelta: minorToDecimalText(-need.requiredMinor, STOCK_QUANTITY_SCALE),
              orderId,
              orderItemId: created.item.id,
              actorUserId: input.cashierUserId,
              managerOverrideId: overrideAttemptId,
              occurredAt,
            });
          }
        }
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

/** Every recipe owner referenced by the order lines (products + chosen modifiers), deduplicated. */
function collectRecipeOwners(lines: readonly NewOrderItemLine[]): RecipeOwnerRef[] {
  const seen = new Set<string>();
  const owners: RecipeOwnerRef[] = [];
  const add = (owner: RecipeOwnerRef): void => {
    const key = `${owner.ownerType}:${owner.ownerId}`;
    if (seen.has(key)) return;
    seen.add(key);
    owners.push(owner);
  };
  for (const line of lines) {
    add({ ownerType: 'menu_item', ownerId: line.menuItemId });
    for (const modifier of line.modifiers ?? []) add({ ownerType: 'modifier', ownerId: modifier.modifierId });
  }
  return owners;
}

function groupRequirements(lines: readonly RecipeRequirementLine[]): Map<string, RecipeRequirementLine[]> {
  const grouped = new Map<string, RecipeRequirementLine[]>();
  for (const line of lines) {
    const key = `${line.ownerType}:${line.ownerId}`;
    const bucket = grouped.get(key) ?? [];
    bucket.push(line);
    grouped.set(key, bucket);
  }
  return grouped;
}

interface LineRequirement {
  readonly inventoryItemId: string;
  /** Total base-unit minor units for the whole line (per-unit × quantity). */
  readonly requiredMinor: bigint;
}

/** Base-unit requirements of ONE order line (product recipe + modifier recipes). */
function lineRequirements(grouped: Map<string, RecipeRequirementLine[]>, line: NewOrderItemLine): LineRequirement[] {
  const out: LineRequirement[] = [];
  const owners: RecipeOwnerRef[] = [{ ownerType: 'menu_item', ownerId: line.menuItemId }];
  for (const modifier of line.modifiers ?? []) owners.push({ ownerType: 'modifier', ownerId: modifier.modifierId });
  for (const owner of owners) {
    for (const req of grouped.get(`${owner.ownerType}:${owner.ownerId}`) ?? []) {
      out.push({
        inventoryItemId: req.inventoryItemId,
        requiredMinor: decimalTextToMinor(req.quantityRequired, STOCK_QUANTITY_SCALE, 'quantityRequired') * BigInt(line.quantity),
      });
    }
  }
  return out;
}

/** Whole-order totals per component (every line aggregated BEFORE any comparison). */
function aggregateRequiredMinor(
  lines: readonly RecipeRequirementLine[],
  orderLines: readonly NewOrderItemLine[],
): Map<string, bigint> {
  const grouped = groupRequirements(lines);
  const totals = new Map<string, bigint>();
  for (const line of orderLines) {
    for (const need of lineRequirements(grouped, line)) {
      totals.set(need.inventoryItemId, (totals.get(need.inventoryItemId) ?? 0n) + need.requiredMinor);
    }
  }
  return totals;
}

/**
 * First component the order would drive below zero (line order — deterministic).
 * A component with NO stock row at this branch counts as ZERO (fail-closed:
 * the branch simply has none of it).
 */
function findShortage(
  requiredByComponent: Map<string, bigint>,
  quantities: Map<string, InventoryItemRecord>,
): ComponentShortage | null {
  for (const [inventoryItemId, requiredMinor] of requiredByComponent) {
    const stocked = quantities.get(inventoryItemId);
    const availableMinor = stocked === undefined ? 0n : decimalTextToMinor(stocked.currentQuantity, STOCK_QUANTITY_SCALE, 'currentQuantity');
    if (availableMinor - requiredMinor < 0n) {
      return {
        inventoryItemId,
        displayName: stocked === undefined ? inventoryItemId : displayNameOf(stocked.name, inventoryItemId),
      };
    }
  }
  return null;
}

/** Deterministic cashier-facing name (KSA-first: ar, then en, then first key, then id). */
function displayNameOf(name: LocalizedText, fallbackId: string): string {
  const direct = name['ar'] ?? name['en'];
  if (direct !== undefined) return direct;
  const firstKey = Object.keys(name).sort()[0];
  const first = firstKey === undefined ? undefined : name[firstKey];
  return first ?? fallbackId;
}
