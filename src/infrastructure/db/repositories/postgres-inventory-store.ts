/**
 * PostgreSQL adapter for the Phase-9 inventory port
 * (domain/contracts/inventory.ts — InventoryStore).
 *
 * Every use case runs in ONE withTenantContext() transaction (repeatable
 * read, tenant existence verified): receiving/adjustment reads and the
 * movement row commit or roll back together. Manual movements never carry
 * override evidence — their authorization is the inventory:receive /
 * inventory:adjust key, asserted both by the engine and structurally by the
 * movement validation trigger.
 *
 * This class never imports pg; it only receives the transaction-scoped
 * TenantQuery from withTenantContext().
 */
import type {
  InsertStockMovementInput,
  InventoryItemRecord,
  InventoryStore,
  InventoryTxScope,
  StockMovementRecord,
} from '../../../domain/contracts/inventory.ts';
import type { WithTenantContext, TenantQuery } from '../tenant-context.ts';
import {
  insertStockMovementRow,
  mapInventoryItem,
  type InventoryItemRow,
} from './stock-ledger-rows.ts';

export interface PostgresInventoryStoreDependencies {
  readonly withTenantContext: WithTenantContext;
}

export class PostgresInventoryStore implements InventoryStore {
  private readonly dependencies: PostgresInventoryStoreDependencies;

  constructor(dependencies: PostgresInventoryStoreDependencies) {
    this.dependencies = dependencies;
  }

  run<T>(tenantId: string, fn: (scope: InventoryTxScope) => Promise<T>): Promise<T> {
    return this.dependencies.withTenantContext(tenantId, async (q) => fn(buildScope(q)), {
      isolationLevel: 'repeatable read',
      verifyTenantExists: true,
    });
  }
}

function buildScope(q: TenantQuery): InventoryTxScope {
  return {
    async loadInventoryItem(tid: string, inventoryItemId: string): Promise<InventoryItemRecord | null> {
      const result = await q.query<InventoryItemRow>(
        `SELECT id, tenant_id, branch_id, name, base_unit, current_quantity, low_stock_threshold, is_active
           FROM inventory_items WHERE tenant_id = $1 AND id = $2`,
        [tid, inventoryItemId],
      );
      const r = result.rows[0];
      return r === undefined ? null : mapInventoryItem(r);
    },

    async loadConversionFactor(tid: string, inventoryItemId: string, fromUnit: string, toUnit: string): Promise<string | null> {
      const result = await q.query<{ conversion_factor: string }>(
        `SELECT conversion_factor FROM unit_conversions
          WHERE tenant_id = $1 AND inventory_item_id = $2 AND from_unit = $3 AND to_unit = $4`,
        [tid, inventoryItemId, fromUnit, toUnit],
      );
      return result.rows[0]?.conversion_factor ?? null;
    },

    async insertStockMovement(tid: string, movement: InsertStockMovementInput): Promise<StockMovementRecord> {
      return insertStockMovementRow(q, tid, movement);
    },

    async loadAdjustmentReason(tid: string, adjustmentReasonId: string) {
      const result = await q.query<{
        id: string;
        is_enabled: boolean;
        kind_code: string;
        kind_setting_enabled: boolean;
      }>(
        `SELECT r.id, r.is_enabled,
                r.adjustment_reason_kind_code AS kind_code,
                COALESCE(s.is_enabled, true) AS kind_setting_enabled
           FROM tenant_adjustment_reasons r
           LEFT JOIN tenant_adjustment_reason_kind_settings s
             ON s.tenant_id = r.tenant_id AND s.adjustment_reason_kind_code = r.adjustment_reason_kind_code
          WHERE r.tenant_id = $1 AND r.id = $2`,
        [tid, adjustmentReasonId],
      );
      const r = result.rows[0];
      return r === undefined
        ? null
        : { id: r.id, isEnabled: r.is_enabled, kindCode: r.kind_code, kindSettingEnabled: r.kind_setting_enabled };
    },
  };
}
