/**
 * Inventory engine (Phase 9): manual receiving and manual stock adjustments.
 *
 * Receiving is the SINGLE conversion point in the system: the invoice /
 * purchase-unit quantity is converted to the component's base unit BEFORE
 * the movement row is written (exact factor math, ONE terminal banker
 * rounding to scale 4). The sale path never converts — recipes already
 * store base units.
 *
 * Authorization: receiving needs 'inventory:receive' (cacheable);
 * adjustments need the sensitive 'inventory:adjust' (never cached — a
 * downward adjustment can hide shrinkage or theft). The movement trigger
 * re-asserts the same keys structurally (tenant-wide or branch-scoped).
 *
 * Input discipline (fail-closed): quantities are strict canonical decimals
 * (no silent rounding of INPUTS — ‘2.55555’ at scale 4 is rejected, not
 * rounded); rounding happens exactly once, at the receiving conversion.
 */
import {
  STOCK_QUANTITY_SCALE,
  type InsertStockMovementInput,
  type InventoryActor,
  type InventoryOutboxEvent,
  type InventoryStore,
  type LowStockAlert,
  type StockMovementRecord,
} from '../../../domain/contracts/inventory.ts';
import type { AuthorizationEngine } from '../rbac/authorization-engine.ts';
import { minorToDecimalText, nonNegativeDecimalTextToMinor } from '../../../shared/decimal-text.ts';
import { divideRoundHalfToEven } from '../../../shared/money.ts';
import { AdjustmentReasonUnavailableError, NotFoundError, ValidationError } from '../../../shared/errors.ts';

export interface InventoryEngineDependencies {
  readonly store: InventoryStore;
  readonly authorization: Pick<AuthorizationEngine, 'check'>;
}

export interface ReceiveStockInput {
  readonly branchId: string;
  readonly inventoryItemId: string;
  /** Invoice quantity in the PURCHASE unit (strict canonical decimal, fraction ≤ 8). */
  readonly quantityText: string;
  /** The purchase unit (converted to the base unit; equal units skip the lookup). */
  readonly purchaseUnit: string;
  readonly occurredAt?: Date;
}

export interface AdjustStockInput {
  readonly branchId: string;
  readonly inventoryItemId: string;
  /** Signed delta in BASE units (strict canonical decimal, fraction ≤ 4, non-zero). */
  readonly quantityDeltaText: string;
  /** I1: MANDATORY coded reason (tenant_adjustment_reasons id, must be enabled). */
  readonly adjustmentReasonId: string;
  readonly occurredAt?: Date;
}

/** Input scale for purchase quantities (NUMERIC(18,8)-compatible). */
const RECEIVING_INPUT_SCALE = 8;
/** Conversion factors live at NUMERIC(18,8) (0038). */
const CONVERSION_FACTOR_SCALE = 8;
/** Scale-8 one, for same-unit receiving (uniform conversion path). */
const UNITY_FACTOR_TEXT = '1.00000000';

const RECEIVE_PERMISSION_KEY = 'inventory:receive';
const ADJUST_PERMISSION_KEY = 'inventory:adjust';

export class InventoryEngine {
  private readonly dependencies: InventoryEngineDependencies;

  constructor(dependencies: InventoryEngineDependencies) {
    this.dependencies = dependencies;
  }

  async receiveStock(tenantId: string, actor: InventoryActor, input: ReceiveStockInput): Promise<StockMovementRecord> {
    await this.dependencies.authorization.check({
      tenantId,
      userId: actor.userId,
      permissionKey: RECEIVE_PERMISSION_KEY,
      tokenSecV: actor.tokenSecV,
      context: { hasResource: false, actorBranchId: null, isSensitivePermission: false },
    });
    const purchaseMinor = parseStrictPositiveDecimal(input.quantityText, RECEIVING_INPUT_SCALE, 'quantityText');

    return this.dependencies.store.run(tenantId, async (scope) => {
      const item = await scope.loadInventoryItem(tenantId, input.inventoryItemId);
      if (item === null) throw new NotFoundError(`Inventory item ${input.inventoryItemId} not found`);
      if (item.branchId !== input.branchId) {
        throw new ValidationError('Inventory item does not belong to the receiving branch', 'branchId');
      }
      const factorText =
        input.purchaseUnit === item.baseUnit
          ? UNITY_FACTOR_TEXT
          : await scope.loadConversionFactor(tenantId, item.id, input.purchaseUnit, item.baseUnit);
      if (factorText === null) {
        throw new ValidationError(
          `No conversion from '${input.purchaseUnit}' to base unit '${item.baseUnit}' for this component`,
          'purchaseUnit',
        );
      }
      const factorMinor = nonNegativeDecimalTextToMinor(factorText, CONVERSION_FACTOR_SCALE, 'conversionFactor');
      // (purchase × 10^8) × (factor × 10^8) ÷ 10^12 → base × 10^4.
      const baseMinor = divideRoundHalfToEven(purchaseMinor * factorMinor, 10n ** 12n);
      if (baseMinor <= 0n) {
        throw new ValidationError('Converted receiving quantity must be greater than zero', 'quantityText');
      }
      const movement: InsertStockMovementInput = {
        branchId: input.branchId,
        inventoryItemId: item.id,
        movementType: 'manual_receiving',
        quantityDelta: minorToDecimalText(baseMinor, STOCK_QUANTITY_SCALE),
        orderId: null,
        orderItemId: null,
        actorUserId: actor.userId,
        managerOverrideId: null,
        adjustmentReasonId: null,
        occurredAt: input.occurredAt ?? new Date(),
      };
      return scope.insertStockMovement(tenantId, movement);
    });
  }

  async adjustStock(tenantId: string, actor: InventoryActor, input: AdjustStockInput): Promise<StockMovementRecord> {
    await this.dependencies.authorization.check({
      tenantId,
      userId: actor.userId,
      permissionKey: ADJUST_PERMISSION_KEY,
      tokenSecV: actor.tokenSecV,
      context: { hasResource: false, actorBranchId: null, isSensitivePermission: true },
    });
    const deltaMinor = parseStrictNonZeroDecimal(input.quantityDeltaText, STOCK_QUANTITY_SCALE, 'quantityDeltaText');

    return this.dependencies.store.run(tenantId, async (scope) => {
      const item = await scope.loadInventoryItem(tenantId, input.inventoryItemId);
      if (item === null) throw new NotFoundError(`Inventory item ${input.inventoryItemId} not found`);
      if (item.branchId !== input.branchId) {
        throw new ValidationError('Inventory item does not belong to the adjustment branch', 'branchId');
      }
      // I1: the coded reason must exist and be enabled (reason + platform
      // kind) — the tenant_void_reasons mirror, minus tiers (no inventory
      // tier ladder exists; the flat sensitive inventory:adjust key gates).
      const reason = await scope.loadAdjustmentReason(tenantId, input.adjustmentReasonId);
      if (reason === null || !reason.isEnabled || !reason.kindSettingEnabled) {
        throw new AdjustmentReasonUnavailableError(input.adjustmentReasonId);
      }
      const movement: InsertStockMovementInput = {
        branchId: input.branchId,
        inventoryItemId: item.id,
        movementType: 'manual_adjustment',
        quantityDelta: minorToDecimalText(deltaMinor, STOCK_QUANTITY_SCALE),
        orderId: null,
        orderItemId: null,
        actorUserId: actor.userId,
        managerOverrideId: null,
        adjustmentReasonId: reason.id,
        occurredAt: input.occurredAt ?? new Date(),
      };
      return scope.insertStockMovement(tenantId, movement);
    });
  }

  /**
   * I3: mute a branch's low-stock ALERTS. Hiding shrinkage signals is
   * sensitive — the same 'inventory:adjust' key as manual adjustments gates
   * it. The outbox history is NEVER filtered by a mute.
   */
  async muteLowStockAlerts(tenantId: string, actor: InventoryActor, branchId: string): Promise<void> {
    await this.dependencies.authorization.check({
      tenantId,
      userId: actor.userId,
      permissionKey: ADJUST_PERMISSION_KEY,
      tokenSecV: actor.tokenSecV,
      context: { hasResource: false, actorBranchId: null, isSensitivePermission: true },
    });
    await this.dependencies.store.run(tenantId, async (scope) => {
      if (!(await scope.branchBelongsToTenant(tenantId, branchId))) {
        throw new NotFoundError(`Branch ${branchId} not found`);
      }
      await scope.muteLowStockAlerts(tenantId, branchId, actor.userId);
    });
  }

  /** I3: unmute a branch's low-stock alerts (same sensitive gate). */
  async unmuteLowStockAlerts(tenantId: string, actor: InventoryActor, branchId: string): Promise<void> {
    await this.dependencies.authorization.check({
      tenantId,
      userId: actor.userId,
      permissionKey: ADJUST_PERMISSION_KEY,
      tokenSecV: actor.tokenSecV,
      context: { hasResource: false, actorBranchId: null, isSensitivePermission: true },
    });
    await this.dependencies.store.run(tenantId, async (scope) => {
      if (!(await scope.branchBelongsToTenant(tenantId, branchId))) {
        throw new NotFoundError(`Branch ${branchId} not found`);
      }
      await scope.unmuteLowStockAlerts(tenantId, branchId);
    });
  }

  /**
   * I3: live actionable alerts for a branch — below-threshold components of
   * UNMUTED branches only. A read: RLS scopes the tenant, no permission key
   * (orderTotals precedent).
   */
  async listLowStockAlerts(tenantId: string, branchId: string): Promise<readonly LowStockAlert[]> {
    return this.dependencies.store.run(tenantId, (scope) => scope.loadLowStockAlerts(tenantId, branchId));
  }

  /** I3: crossing history for a branch — NEVER mute-filtered, gapless per branch. */
  async listInventoryEvents(
    tenantId: string,
    branchId: string,
    afterSequenceId: number,
    limit: number,
  ): Promise<readonly InventoryOutboxEvent[]> {
    return this.dependencies.store.run(tenantId, (scope) =>
      scope.loadInventoryEvents(tenantId, branchId, afterSequenceId, limit),
    );
  }
}

const STRICT_DECIMAL = /^(0|[1-9]\d*)(?:\.(\d+))?$/;

/** Strict positive canonical decimal → minor units (exact; never rounds). */
function parseStrictPositiveDecimal(text: string, scale: number, field: string): bigint {
  return parseStrictDecimal(text, scale, field, false);
}

/** Strict non-zero SIGNED canonical decimal → minor units (exact; never rounds). */
function parseStrictNonZeroDecimal(text: string, scale: number, field: string): bigint {
  const minor = parseStrictDecimal(text, scale, field, true);
  if (minor === 0n) throw new ValidationError('Adjustment quantity must be non-zero', field);
  return minor;
}

function parseStrictDecimal(text: string, scale: number, field: string, signed: boolean): bigint {
  const negative = signed && text.startsWith('-');
  const body = negative ? text.slice(1) : text;
  const match = STRICT_DECIMAL.exec(body);
  if (match === null) throw new ValidationError(`Invalid canonical decimal quantity: "${text}"`, field);
  const fraction = match[2] ?? '';
  if (fraction.length > scale) {
    throw new ValidationError(`Quantity has more than ${String(scale)} decimal places: "${text}"`, field);
  }
  const minor = BigInt(`${match[1] ?? '0'}${fraction.padEnd(scale, '0')}`);
  if (!signed && minor <= 0n) throw new ValidationError('Quantity must be greater than zero', field);
  return negative ? -minor : minor;
}
