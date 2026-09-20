import { randomUUID } from 'node:crypto';

import type pg from 'pg';
import { describe, expect, it } from 'vitest';

import { withTestClient } from '../support/database.ts';

interface Fixture {
  readonly tenantId: string;
  readonly branchId: string;
  readonly userId: string;
  readonly orderId: string;
  readonly orderItemId: string;
  readonly inventoryItemId: string;
  readonly secondLayerId: string;
}

interface JournalLine {
  readonly source_type: string;
  readonly source_id: string;
  readonly system_purpose: string;
  readonly debit_minor: string;
  readonly credit_minor: string;
}

async function createFixture(client: pg.Client): Promise<Fixture> {
  const tenantId = randomUUID();
  const branchId = randomUUID();
  const userId = randomUUID();
  const roleId = randomUUID();
  const workflowId = randomUUID();
  const stateId = randomUUID();
  const categoryId = randomUUID();
  const menuItemId = randomUUID();
  const stationId = randomUUID();
  const orderId = randomUUID();
  const firstOrderItemId = randomUUID();
  const orderItemId = randomUUID();
  const inventoryItemId = randomUUID();

  await client.query('INSERT INTO tenants (id, name) VALUES ($1, $2)', [tenantId, `phase4-${tenantId}`]);
  await client.query("SELECT set_config('app.current_tenant_id', $1, false)", [tenantId]);
  await client.query(
    `INSERT INTO branches (id, tenant_id, name, base_currency, timezone, country_code)
     VALUES ($1, $2, 'DD-005 phase 4', 'SAR', 'Asia/Riyadh', 'SA')`,
    [branchId, tenantId],
  );
  await client.query(
    'INSERT INTO users (id, tenant_id, email, pin_hash) VALUES ($1, $2, $3, $4)',
    [userId, tenantId, `${userId}@example.test`, 'fixture'],
  );
  await client.query('INSERT INTO roles (id, tenant_id, name) VALUES ($1, $2, $3)', [roleId, tenantId, roleId]);
  await client.query(
    "INSERT INTO role_permissions (tenant_id, role_id, permission_key) VALUES ($1, $2, 'inventory:receive')",
    [tenantId, roleId],
  );
  await client.query(
    `INSERT INTO user_roles (tenant_id, user_id, role_id, scope_type, scope_id)
     VALUES ($1, $2, $3, 'tenant', NULL)`,
    [tenantId, userId, roleId],
  );
  await client.query('INSERT INTO tenant_order_workflows (id, tenant_id) VALUES ($1, $2)', [workflowId, tenantId]);
  await client.query(
    `INSERT INTO tenant_order_workflow_states (id, tenant_id, workflow_id, kind_code, position, label)
     VALUES ($1, $2, $3, 'received', 10, '{"en":"Received"}'::jsonb)`,
    [stateId, tenantId, workflowId],
  );
  await client.query(
    `INSERT INTO menu_categories (id, tenant_id, name)
     VALUES ($1, $2, '{"en":"DD-005 phase 4"}'::jsonb)`,
    [categoryId, tenantId],
  );
  await client.query(
    `INSERT INTO menu_items
       (id, tenant_id, category_id, name, base_price_amount_minor, base_price_currency_code)
     VALUES ($1, $2, $3, '{"en":"FIFO item"}'::jsonb, 100, 'SAR')`,
    [menuItemId, tenantId, categoryId],
  );
  await client.query(
    `INSERT INTO stations (id, tenant_id, branch_id, name)
     VALUES ($1, $2, $3, 'DD-005 phase 4')`,
    [stationId, tenantId, branchId],
  );
  await client.query(
    `INSERT INTO orders
       (id, tenant_id, branch_id, order_type, sales_channel_code, current_status_kind_id)
     VALUES ($1, $2, $3, 'takeaway', 'takeaway', $4)`,
    [orderId, tenantId, branchId, stateId],
  );
  await client.query(
    `INSERT INTO order_items
       (id, tenant_id, order_id, menu_item_id, item_name_snapshot, unit_price_minor,
        quantity, current_status_kind_id, station_id)
     VALUES
       ($1, $3, $4, $5, '{"en":"FIFO item"}'::jsonb, 100, 10, $6, $7),
       ($2, $3, $4, $5, '{"en":"FIFO item"}'::jsonb, 100, 5, $6, $7)`,
    [firstOrderItemId, orderItemId, tenantId, orderId, menuItemId, stateId, stationId],
  );
  await client.query(
    `INSERT INTO inventory_items (id, tenant_id, branch_id, name, base_unit)
     VALUES ($1, $2, $3, '{"en":"Component"}'::jsonb, 'unit')`,
    [inventoryItemId, tenantId, branchId],
  );

  async function receiveLayer(totalCost: bigint): Promise<string> {
    const movementId = randomUUID();
    await client.query(
      `INSERT INTO stock_movements
         (id, tenant_id, branch_id, inventory_item_id, movement_type, quantity_delta, actor_user_id)
       VALUES ($1, $2, $3, $4, 'manual_receiving', $5, $6)`,
      [movementId, tenantId, branchId, inventoryItemId, '10', userId],
    );
    const ledger = await client.query<{ id: string }>(
      `INSERT INTO inventory_cost_ledger
         (tenant_id, inventory_item_id, stock_movement_id, total_cost_minor, original_qty,
          currency_code, minor_unit_digits)
       VALUES ($1, $2, $3, $4, $5, 'SAR', 2) RETURNING id::text`,
      [tenantId, inventoryItemId, movementId, totalCost.toString(), '10'],
    );
    const layer = await client.query<{ id: string }>(
      `INSERT INTO inventory_cost_layers
         (tenant_id, inventory_item_id, cost_ledger_id, original_qty, remaining_qty,
          total_cost_minor, remaining_cost_minor, currency_code, minor_unit_digits)
       VALUES ($1, $2, $3, $4, $4, $5, $5, 'SAR', 2) RETURNING id::text`,
      [tenantId, inventoryItemId, ledger.rows[0]?.id, '10', totalCost.toString()],
    );
    const layerId = layer.rows[0]?.id;
    if (layerId === undefined) throw new Error('Cost layer fixture insert returned no row');
    return layerId;
  }
  const firstLayerId = await receiveLayer(50n);
  const secondLayerId = await receiveLayer(70n);

  const firstSaleMovementId = randomUUID();
  const secondSaleMovementId = randomUUID();
  await client.query(
    `INSERT INTO stock_movements
       (id, tenant_id, branch_id, inventory_item_id, movement_type, quantity_delta,
        order_id, order_item_id, actor_user_id)
     VALUES
       ($1, $3, $4, $5, 'sale_deduction', -10, $6, $7, $9),
       ($2, $3, $4, $5, 'sale_deduction', -5, $6, $8, $9)`,
    [
      firstSaleMovementId, secondSaleMovementId, tenantId, branchId, inventoryItemId,
      orderId, firstOrderItemId, orderItemId, userId,
    ],
  );
  await client.query(
    `INSERT INTO consumption_allocations
       (tenant_id, stock_movement_id, layer_id, order_item_id, qty, allocated_cost_minor)
     VALUES
       ($1, $2, $4, $6, 10, 50),
       ($1, $3, $5, $7, 5, 35)`,
    [
      tenantId, firstSaleMovementId, secondSaleMovementId, firstLayerId,
      secondLayerId, firstOrderItemId, orderItemId,
    ],
  );
  await client.query(
    `UPDATE inventory_cost_layers
        SET remaining_qty = CASE WHEN id=$2 THEN 0 ELSE 5 END,
            remaining_cost_minor = CASE WHEN id=$2 THEN 0 ELSE 35 END
      WHERE tenant_id=$1 AND id IN ($2, $3)`,
    [tenantId, firstLayerId, secondLayerId],
  );

  return { tenantId, branchId, userId, orderId, orderItemId, inventoryItemId, secondLayerId };
}

async function postOrderCogs(client: pg.Client, fixture: Fixture): Promise<void> {
  await client.query("SELECT set_config('app.current_tenant_id', $1, false)", [fixture.tenantId]);
  await client.query('SELECT post_order_cogs($1, $2, $3, now())', [
    fixture.tenantId, fixture.orderId, fixture.userId,
  ]);
}

async function orderCogsLines(client: pg.Client, fixture: Fixture): Promise<readonly JournalLine[]> {
  const result = await client.query<JournalLine>(
    `SELECT e.source_type, e.source_id::text, a.system_purpose,
            l.debit_minor::text, l.credit_minor::text
       FROM journal_entries e
       JOIN journal_entry_lines l
         ON l.tenant_id = e.tenant_id AND l.journal_entry_id = e.id
       JOIN accounts a ON a.tenant_id = l.tenant_id AND a.id = l.account_id
      WHERE e.tenant_id = $1 AND e.source_type = 'order_cogs' AND e.source_id = $2
      ORDER BY l.line_number`,
    [fixture.tenantId, fixture.orderId],
  );
  return result.rows;
}

async function transaction(work: (client: pg.Client) => Promise<void>): Promise<void> {
  await withTestClient(async (client) => {
    await client.query('BEGIN');
    try {
      await work(client);
    } finally {
      await client.query('ROLLBACK');
    }
  });
}

describe('DD-005 phase 4 order COGS settlement', () => {
  it('posts FIFO COGS only at full settlement and is idempotent', () => transaction(async (client) => {
    const fixture = await createFixture(client);

    // A partial payment must not invoke post_order_cogs. The WIP entry exists,
    // but there is no order_cogs entry until the full-settlement transition.
    expect(await orderCogsLines(client, fixture)).toEqual([]);

    await postOrderCogs(client, fixture);
    await postOrderCogs(client, fixture);

    expect(await orderCogsLines(client, fixture)).toEqual([
      {
        source_type: 'order_cogs', source_id: fixture.orderId,
        system_purpose: 'cost_of_goods_sold', debit_minor: '85', credit_minor: '0',
      },
      {
        source_type: 'order_cogs', source_id: fixture.orderId,
        system_purpose: 'cost_of_goods_in_process', debit_minor: '0', credit_minor: '85',
      },
    ]);
  }));

  it('posts net COGS after a five-unit void restores the cost-7 FIFO layer', () => transaction(async (client) => {
    const fixture = await createFixture(client);
    await client.query('UPDATE order_items SET is_voided=true, voided_at=now() WHERE tenant_id=$1 AND id=$2', [
      fixture.tenantId, fixture.orderItemId,
    ]);
    const restorationMovementId = randomUUID();
    await client.query(
      `INSERT INTO stock_movements
         (id, tenant_id, branch_id, inventory_item_id, movement_type, quantity_delta,
          order_id, order_item_id, actor_user_id)
       VALUES ($1, $2, $3, $4, 'void_restoration', 5, $5, $6, $7)`,
      [
        restorationMovementId, fixture.tenantId, fixture.branchId, fixture.inventoryItemId,
        fixture.orderId, fixture.orderItemId, fixture.userId,
      ],
    );
    await client.query('SELECT post_inventory_restoration($1, $2, $3, now())', [
      fixture.tenantId, restorationMovementId, fixture.userId,
    ]);

    const restoredLayer = await client.query<{ qty: string; cost: string }>(
      `SELECT remaining_qty::text AS qty, remaining_cost_minor::text AS cost
         FROM inventory_cost_layers WHERE tenant_id=$1 AND id=$2`,
      [fixture.tenantId, fixture.secondLayerId],
    );
    expect(restoredLayer.rows[0]).toEqual({ qty: '10.0000', cost: '70' });

    await postOrderCogs(client, fixture);
    expect(await orderCogsLines(client, fixture)).toEqual([
      {
        source_type: 'order_cogs', source_id: fixture.orderId,
        system_purpose: 'cost_of_goods_sold', debit_minor: '50', credit_minor: '0',
      },
      {
        source_type: 'order_cogs', source_id: fixture.orderId,
        system_purpose: 'cost_of_goods_in_process', debit_minor: '0', credit_minor: '50',
      },
    ]);
  }));
});
