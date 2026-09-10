/**
 * Phase 9 domain contracts — inventory, recipes, unit conversions and the
 * stock-movement ledger.
 *
 * Pure types + ports only (zero dependencies outside domain/shared, same
 * rules as every other file in domain/contracts). The application engines
 * depend on these ports; the PostgreSQL adapters implement them through
 * withTenantContext().
 *
 * Core fail-closed principles encoded here:
 *   * Stock is branch-scoped; central reporting aggregates with read-only
 *     SELECTs (no materialized rollup table).
 *   * Recipe quantities are ALWAYS stored in the component's base unit —
 *     conversions happen at receiving time only, never on the sale path.
 *   * current_quantity is DERIVED from stock_movements (the trigger is the
 *     only writer); direct writes are forbidden at the database level.
 *   * A sale_deduction that would drive a balance below zero MUST carry
 *     single-use override evidence (attempt + claim), otherwise the database
 *     itself rejects the row.
 *
 * NUMERIC columns cross this boundary as canonical decimal STRINGS (scale 4
 * for quantities, scale 8 for conversion factors) — never JavaScript
 * numbers. Conversion to/from BigInt minor units happens once, inside the
 * application engines, with the scale stated explicitly at each call site.
 */

import type { LocalizedText } from './catalog.ts';

export type StockMovementType =
  | 'sale_deduction'
  | 'void_restoration'
  | 'waste_void'
  | 'waste_refund'
  | 'manual_receiving'
  | 'manual_adjustment';

export type RecipeOwnerType = 'menu_item' | 'modifier';

export interface InventoryItemRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly branchId: string;
  readonly name: LocalizedText;
  readonly baseUnit: string;
  /** Exact decimal text at scale 4 (may be negative after an override). */
  readonly currentQuantity: string;
  readonly lowStockThreshold: string | null;
  readonly isActive: boolean;
}

export interface RecipeOwnerRef {
  readonly ownerType: RecipeOwnerType;
  readonly ownerId: string;
}

export interface RecipeRequirementLine {
  readonly ownerType: RecipeOwnerType;
  readonly ownerId: string;
  readonly inventoryItemId: string;
  /** Base-unit quantity per ONE unit sold, exact decimal text (scale 4). */
  readonly quantityRequired: string;
}

export interface InsertStockMovementInput {
  readonly branchId: string;
  readonly inventoryItemId: string;
  /**
   * Engine-resolved display name for InsufficientStockError messages. Carried
   * alongside the row so the store mapper never parses localized JSON — it is
   * NOT stored on the movement row. Optional: writers whose rows can never
   * trip the sale-only shortage gate (void/refund/manual) omit it and the
   * mapper falls back to the item id.
   */
  readonly inventoryItemDisplayName?: string;
  readonly movementType: StockMovementType;
  /** Signed delta, exact decimal text (scale 4); the sign is CHECKed per kind. */
  readonly quantityDelta: string;
  readonly orderId: string | null;
  readonly orderItemId: string | null;
  readonly actorUserId: string;
  /** Override evidence — only meaningful on sale_deduction (CHECKed). */
  readonly managerOverrideId: string | null;
  /** I1: mandatory coded reason — manual_adjustment ONLY (CHECKed both directions). */
  readonly adjustmentReasonId: string | null;
  readonly occurredAt?: Date;
}

export interface ClaimStockOverrideInput {
  readonly managerOverrideId: string;
  readonly orderId: string;
}

export interface StockMovementRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly branchId: string;
  readonly inventoryItemId: string;
  readonly movementType: StockMovementType;
  readonly quantityDelta: string;
  readonly orderId: string | null;
  readonly orderItemId: string | null;
  readonly actorUserId: string;
  readonly managerOverrideId: string | null;
  /** I1: the coded reason (manual_adjustment only; NULL on every other kind). */
  readonly adjustmentReasonId: string | null;
  readonly occurredAt: Date;
}

/** Recorded sale deductions per (order item, component) — restoration mirrors these exactly. */
export interface SaleDeductionAggregate {
  readonly orderItemId: string;
  readonly inventoryItemId: string;
  /** SUM of sale_deduction deltas (negative), exact decimal text. */
  readonly totalDeducted: string;
}

/** Components of an order line already recorded as refund waste (dedup key). */
export interface WasteRefundKey {
  readonly orderItemId: string;
  readonly inventoryItemId: string;
}

/** (order item, component) pair already carrying a void_restoration row. */
export interface RestorationKey {
  readonly orderItemId: string;
  readonly inventoryItemId: string;
}

// ── The inventory store port (one transaction per use case) ─────────────────

/** I4: a registered universal unit (platform-wide — no tenant scoping). */
export type UnitKind = 'mass' | 'volume' | 'count';

export interface UnitDefinition {
  readonly code: string;
  readonly kind: UnitKind;
  readonly kindBaseUnit: string;
  /** Factor to the kind's base unit (decimal text, scale 8 — 0051 mirrors 0038). */
  readonly toBaseFactor: string;
}

/** I3: one actionable low-stock alert (live state, mute-aware). */
export interface LowStockAlert {
  readonly branchId: string;
  readonly inventoryItemId: string;
  readonly name: LocalizedText;
  readonly baseUnit: string;
  readonly currentQuantity: string;
  readonly lowStockThreshold: string;
}

/** I3: one inventory outbox event (crossing history, never mute-filtered). */
export interface InventoryOutboxEvent {
  readonly id: string;
  readonly tenantId: string;
  readonly branchId: string;
  readonly sequenceId: number;
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly createdAt: Date;
}

export interface InventoryTxScope {
  loadInventoryItem(tenantId: string, inventoryItemId: string): Promise<InventoryItemRecord | null>;
  /**
   * The purchase→base factor (exact decimal text, scale 8), or null when no
   * conversion row exists for the direction. Missing rows fall through to
   * the I4 universal tier at the engine — tier-2 rows themselves are never
   * inverted or derived by division; an explicit row always wins on conflict.
   */
  loadConversionFactor(
    tenantId: string,
    inventoryItemId: string,
    fromUnit: string,
    toUnit: string,
  ): Promise<string | null>;

  /**
   * I4: load the registered unit definition for one code (platform table —
   * intentionally NO tenant parameter; unknown codes return null, never an
   * error). Matching is case-insensitive (LOWER) at the SQL predicate — the
   * SINGLE normalization point — but the returned `code` is always the
   * canonical registry spelling.
   */
  loadUnitDefinition(code: string): Promise<UnitDefinition | null>;

  insertStockMovement(tenantId: string, movement: InsertStockMovementInput): Promise<StockMovementRecord>;
  /**
   * I1: the coded adjustment reason (tenant_void_reasons mirror — reason
   * enabled + platform-kind enabled, defaulting to true when unset).
   */
  loadAdjustmentReason(
    tenantId: string,
    adjustmentReasonId: string,
  ): Promise<{ id: string; isEnabled: boolean; kindCode: string; kindSettingEnabled: boolean } | null>;

  /** I3: true when the branch belongs to the tenant (mute/unmute guard). */
  branchBelongsToTenant(tenantId: string, branchId: string): Promise<boolean>;

  /** I3: upsert the branch mute row (re-muting refreshes actor + time). */
  muteLowStockAlerts(tenantId: string, branchId: string, actorUserId: string): Promise<void>;

  /** I3: delete the branch mute row (no-op when already unmuted). */
  unmuteLowStockAlerts(tenantId: string, branchId: string): Promise<void>;

  /** I3: live actionable alerts — below-threshold items of UNMUTED branches only. */
  loadLowStockAlerts(tenantId: string, branchId: string): Promise<readonly LowStockAlert[]>;

  /** I3: crossing history — NEVER mute-filtered (the record stays complete). */
  loadInventoryEvents(
    tenantId: string,
    branchId: string,
    afterSequenceId: number,
    limit: number,
  ): Promise<readonly InventoryOutboxEvent[]>;
}

export interface InventoryStore {
  /** Runs fn in ONE transaction scoped to the tenant (repeatable read). */
  run<T>(tenantId: string, fn: (scope: InventoryTxScope) => Promise<T>): Promise<T>;
}

/** Quantity scale for all stock math (NUMERIC(18,4) columns) — single source. */
export const STOCK_QUANTITY_SCALE = 4;

/** The actor receiving/adjusting stock (same shape as VoidActor/PaymentActor). */
export interface InventoryActor {
  readonly userId: string;
  readonly tokenSecV: string;
}
