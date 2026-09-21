import { randomUUID } from 'node:crypto';

import type pg from 'pg';
import { describe, expect, it } from 'vitest';

import { withTestClient } from '../support/database.ts';

interface ProjectionRow {
  readonly current_quantity: string;
  readonly remaining_qty: string;
  readonly remaining_cost_minor: string;
}

interface FindingRow {
  readonly discrepancy_type: string;
  readonly inventory_item_id: string;
  readonly projected_remaining_qty: string | null;
  readonly rebuilt_remaining_qty: string | null;
  readonly projected_remaining_cost_minor: string | null;
  readonly rebuilt_remaining_cost_minor: string | null;
}

async function projection(client: pg.Client, tenantId: string, itemId: string): Promise<ProjectionRow> {
  const result = await client.query<ProjectionRow>(
    `SELECT item.current_quantity::text,
            layer.remaining_qty::text,
            layer.remaining_cost_minor::text
       FROM inventory_items AS item
       JOIN inventory_cost_layers AS layer
         ON layer.tenant_id = item.tenant_id
        AND layer.inventory_item_id = item.id
      WHERE item.tenant_id = $1
        AND item.id = $2`,
    [tenantId, itemId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('inventory projection fixture is missing');
  return row;
}

describe('DD-005 phase 7 inventory reconciliation reporting', () => {
  it('reports exact drift without mutation and distinguishes restorations from waste', async () => {
    await withTestClient(async (client) => {
      await client.query('BEGIN');
      try {
        const tenant = randomUUID();
        const branch = randomUUID();
        const user = randomUUID();
        const role = randomUUID();
        const workflow = randomUUID();
        const state = randomUUID();
        const category = randomUUID();
        const menuItem = randomUUID();
        const station = randomUUID();
        const order = randomUUID();
        const item = randomUUID();
        const receiving = randomUUID();

        await client.query('INSERT INTO tenants (id, name) VALUES ($1, $2)', [tenant, `phase7-${tenant}`]);
        await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenant]);
        await client.query(
          `INSERT INTO branches (id, tenant_id, name, base_currency, timezone, country_code)
           VALUES ($1, $2, 'Phase 7', 'SAR', 'Asia/Riyadh', 'SA')`,
          [branch, tenant],
        );
        await client.query(
          'INSERT INTO users (id, tenant_id, email, pin_hash) VALUES ($1, $2, $3, $4)',
          [user, tenant, `${user}@example.test`, 'fixture'],
        );
        await client.query('INSERT INTO roles (id, tenant_id, name) VALUES ($1, $2, $3)', [role, tenant, role]);
        await client.query(
          "INSERT INTO role_permissions (tenant_id, role_id, permission_key) VALUES ($1, $2, 'inventory:receive')",
          [tenant, role],
        );
        await client.query(
          `INSERT INTO user_roles (tenant_id, user_id, role_id, scope_type, scope_id)
           VALUES ($1, $2, $3, 'tenant', NULL)`,
          [tenant, user, role],
        );
        await client.query('INSERT INTO tenant_order_workflows (id, tenant_id) VALUES ($1, $2)', [workflow, tenant]);
        await client.query(
          `INSERT INTO tenant_order_workflow_states
             (id, tenant_id, workflow_id, kind_code, position, label)
           VALUES ($1, $2, $3, 'received', 10, '{"en":"Received"}'::jsonb)`,
          [state, tenant, workflow],
        );
        await client.query(
          `INSERT INTO menu_categories (id, tenant_id, name)
           VALUES ($1, $2, '{"en":"Phase 7"}'::jsonb)`,
          [category, tenant],
        );
        await client.query(
          `INSERT INTO menu_items
             (id, tenant_id, category_id, name, base_price_amount_minor, base_price_currency_code)
           VALUES ($1, $2, $3, '{"en":"Phase 7"}'::jsonb, 1000, 'SAR')`,
          [menuItem, tenant, category],
        );
        await client.query(
          'INSERT INTO stations (id, tenant_id, branch_id, name) VALUES ($1, $2, $3, $4)',
          [station, tenant, branch, 'Phase 7'],
        );
        await client.query(
          `INSERT INTO orders
             (id, tenant_id, branch_id, order_type, sales_channel_code, current_status_kind_id)
           VALUES ($1, $2, $3, 'takeaway', 'takeaway', $4)`,
          [order, tenant, branch, state],
        );
        await client.query(
          `INSERT INTO inventory_items (id, tenant_id, branch_id, name, base_unit)
           VALUES ($1, $2, $3, '{"en":"Component"}'::jsonb, 'unit')`,
          [item, tenant, branch],
        );
        await client.query(
          `INSERT INTO stock_movements
             (id, tenant_id, branch_id, inventory_item_id, movement_type, quantity_delta, actor_user_id)
           VALUES ($1, $2, $3, $4, 'manual_receiving', 10, $5)`,
          [receiving, tenant, branch, item, user],
        );
        const ledger = await client.query<{ readonly id: string }>(
          `INSERT INTO inventory_cost_ledger
             (tenant_id, inventory_item_id, stock_movement_id, total_cost_minor,
              original_qty, currency_code, minor_unit_digits)
           VALUES ($1, $2, $3, 1000, 10, 'SAR', 2)
           RETURNING id::text`,
          [tenant, item, receiving],
        );
        const layer = await client.query<{ readonly id: string }>(
          `INSERT INTO inventory_cost_layers
             (tenant_id, inventory_item_id, cost_ledger_id, original_qty, remaining_qty,
              total_cost_minor, remaining_cost_minor, currency_code, minor_unit_digits)
           VALUES ($1, $2, $3, 10, 10, 1000, 1000, 'SAR', 2)
           RETURNING id::text`,
          [tenant, item, ledger.rows[0]?.id],
        );
        const layerId = layer.rows[0]?.id;
        if (layerId === undefined) throw new Error('cost layer fixture is missing');

        const cases = [
          { disposition: 'void_restoration', voided: true, movementType: 'void_restoration', delta: '1' },
          { disposition: 'refund_restoration', voided: false, movementType: 'void_restoration', delta: '1' },
          { disposition: 'waste_void', voided: true, movementType: 'waste_void', delta: '0' },
          { disposition: 'waste_refund', voided: false, movementType: 'waste_refund', delta: '0' },
        ] as const;

        // Sequential fixture construction preserves deterministic identity/FIFO order.
        for (const testCase of cases) {
          const orderItem = randomUUID();
          const sale = randomUUID();
          const restoration = randomUUID();
          await client.query(
            `INSERT INTO order_items
               (id, tenant_id, order_id, menu_item_id, item_name_snapshot, unit_price_minor,
                quantity, current_status_kind_id, station_id, is_voided, voided_at)
             VALUES ($1, $2, $3, $4, '{"en":"Phase 7"}'::jsonb, 1000,
                     1, $5, $6, $7, CASE WHEN $7 THEN now() ELSE NULL END)`,
            [orderItem, tenant, order, menuItem, state, station, testCase.voided],
          );
          await client.query(
            `INSERT INTO stock_movements
               (id, tenant_id, branch_id, inventory_item_id, movement_type, quantity_delta,
                order_id, order_item_id, actor_user_id)
             VALUES ($1, $2, $3, $4, 'sale_deduction', -1, $5, $6, $7)`,
            [sale, tenant, branch, item, order, orderItem, user],
          );
          const allocation = await client.query<{ readonly id: string }>(
            `INSERT INTO consumption_allocations
               (tenant_id, stock_movement_id, layer_id, order_item_id, qty, allocated_cost_minor)
             VALUES ($1, $2, $3, $4, 1, 100)
             RETURNING id::text`,
            [tenant, sale, layerId, orderItem],
          );
          await client.query(
            `INSERT INTO stock_movements
               (id, tenant_id, branch_id, inventory_item_id, movement_type, quantity_delta,
                order_id, order_item_id, actor_user_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [restoration, tenant, branch, item, testCase.movementType, testCase.delta, order, orderItem, user],
          );
          await client.query(
            `INSERT INTO restoration_allocations
               (tenant_id, restoration_stock_movement_id, original_consumption_allocation_id,
                layer_id, order_item_id, qty, restored_cost_minor, disposition)
             VALUES ($1, $2, $3, $4, $5, -1, 100, $6)`,
            [tenant, restoration, allocation.rows[0]?.id, layerId, orderItem, testCase.disposition],
          );
        }

        // Four units were consumed; only void/refund restoration return two.
        await client.query(
          `UPDATE inventory_cost_layers
              SET remaining_qty = 8,
                  remaining_cost_minor = 800
            WHERE tenant_id = $1 AND id = $2`,
          [tenant, layerId],
        );
        expect(await projection(client, tenant, item)).toEqual({
          current_quantity: '8.0000',
          remaining_qty: '8.0000',
          remaining_cost_minor: '800',
        });

        // A legal decrease simulates projection drift without rewriting evidence.
        await client.query(
          `UPDATE inventory_cost_layers
              SET remaining_qty = 7,
                  remaining_cost_minor = 700
            WHERE tenant_id = $1 AND id = $2`,
          [tenant, layerId],
        );
        const before = await projection(client, tenant, item);

        const report = await client.query<FindingRow>(
          `SELECT discrepancy_type,
                  inventory_item_id,
                  projected_remaining_qty,
                  rebuilt_remaining_qty,
                  projected_remaining_cost_minor,
                  rebuilt_remaining_cost_minor
             FROM reconcile_inventory($1)
            ORDER BY discrepancy_type, inventory_item_id`,
          [tenant],
        );

        expect(report.rows).toEqual([
          {
            discrepancy_type: 'quantity_and_cost_mismatch',
            inventory_item_id: item,
            projected_remaining_qty: '7.0000',
            rebuilt_remaining_qty: '8.0000',
            projected_remaining_cost_minor: '700',
            rebuilt_remaining_cost_minor: '800',
          },
        ]);

        const startedAt = new Date('2026-01-15T12:00:00.000Z');
        const cutoffAt = new Date('2026-01-15T12:01:00.000Z');
        const recorded = await client.query<{ readonly run_id: string }>(
          `SELECT record_inventory_reconciliation($1, $2, $3) AS run_id`,
          [tenant, startedAt, cutoffAt],
        );
        const runId = recorded.rows[0]?.run_id;
        expect(runId).toBeDefined();

        const run = await client.query<{
          readonly status: string;
          readonly quantity_discrepancy_count: string;
          readonly layer_discrepancy_count: string;
        }>(
          `SELECT status, quantity_discrepancy_count::text, layer_discrepancy_count::text
             FROM inventory_reconciliation_runs
            WHERE tenant_id = $1 AND id = $2`,
          [tenant, runId],
        );
        expect(run.rows).toEqual([{
          status: 'completed',
          quantity_discrepancy_count: '0',
          layer_discrepancy_count: '1',
        }]);

        const persisted = await client.query<FindingRow>(
          `SELECT discrepancy_type, inventory_item_id,
                  projected_remaining_qty::text,
                  rebuilt_remaining_qty::text,
                  projected_remaining_cost_minor::text,
                  rebuilt_remaining_cost_minor::text
             FROM inventory_reconciliation_findings
            WHERE tenant_id = $1 AND run_id = $2
            ORDER BY id`,
          [tenant, runId],
        );
        expect(persisted.rows).toEqual(report.rows);
        expect(await projection(client, tenant, item)).toEqual(before);

        await expect(
          client.query('SELECT record_inventory_reconciliation($1, $2, $3)', [randomUUID(), startedAt, cutoffAt]),
        ).rejects.toThrow('inventory reconciliation tenant must match current tenant');

        await client.query('ROLLBACK');
        await client.query('BEGIN');
        const cleanTenant = randomUUID();
        await client.query('INSERT INTO tenants (id, name) VALUES ($1, $2)', [cleanTenant, `phase7-clean-${cleanTenant}`]);
        await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [cleanTenant]);
        const cleanRecorded = await client.query<{ readonly run_id: string }>(
          'SELECT record_inventory_reconciliation($1, $2, $3) AS run_id',
          [cleanTenant, startedAt, cutoffAt],
        );
        const cleanRun = await client.query<{
          readonly quantity_discrepancy_count: string;
          readonly layer_discrepancy_count: string;
          readonly finding_count: string;
        }>(
          `SELECT run.quantity_discrepancy_count::text,
                  run.layer_discrepancy_count::text,
                  count(finding.id)::text AS finding_count
             FROM inventory_reconciliation_runs AS run
             LEFT JOIN inventory_reconciliation_findings AS finding
               ON finding.tenant_id = run.tenant_id AND finding.run_id = run.id
            WHERE run.tenant_id = $1 AND run.id = $2
            GROUP BY run.id`,
          [cleanTenant, cleanRecorded.rows[0]?.run_id],
        );
        expect(cleanRun.rows).toEqual([{
          quantity_discrepancy_count: '0',
          layer_discrepancy_count: '0',
          finding_count: '0',
        }]);
      } finally {
        await client.query('ROLLBACK');
      }
    });
  });
});
