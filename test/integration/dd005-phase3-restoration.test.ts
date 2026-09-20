import { randomUUID } from 'node:crypto';

import type pg from 'pg';
import { describe, expect, it } from 'vitest';

import { withTestClient } from '../support/database.ts';

interface Fixture {
  readonly tenant: string;
  readonly branch: string;
  readonly user: string;
  readonly item: string;
  readonly order: string;
  readonly orderItem: string;
  readonly layer: string;
  readonly allocation: string;
}

async function fixture(client: pg.Client, options: { voided?: boolean; withCost?: boolean } = {}): Promise<Fixture> {
  const tenant = randomUUID();
  const branch = randomUUID();
  const user = randomUUID();
  const role = randomUUID();
  const workflow = randomUUID();
  const state = randomUUID();
  const category = randomUUID();
  const menuItem = randomUUID();
  const station = randomUUID();
  const item = randomUUID();
  const order = randomUUID();
  const orderItem = randomUUID();
  const receiving = randomUUID();
  const sale = randomUUID();

  await client.query('INSERT INTO tenants (id, name) VALUES ($1, $2)', [tenant, `phase3-${tenant}`]);
  await client.query("SELECT set_config('app.current_tenant_id', $1, false)", [tenant]);
  await client.query(
    `INSERT INTO branches (id,tenant_id,name,base_currency,timezone,country_code)
     VALUES ($1,$2,'Phase 3','SAR','Asia/Riyadh','SA')`, [branch, tenant],
  );
  await client.query('INSERT INTO users (id,tenant_id,email,pin_hash) VALUES ($1,$2,$3,$4)', [user, tenant, `${user}@example.test`, 'fixture']);
  await client.query('INSERT INTO roles (id,tenant_id,name) VALUES ($1,$2,$3)', [role, tenant, role]);
  await client.query("INSERT INTO role_permissions (tenant_id,role_id,permission_key) VALUES ($1,$2,'inventory:receive')", [tenant, role]);
  await client.query("INSERT INTO user_roles (tenant_id,user_id,role_id,scope_type,scope_id) VALUES ($1,$2,$3,'tenant',NULL)", [tenant, user, role]);
  await client.query('INSERT INTO tenant_order_workflows (id,tenant_id) VALUES ($1,$2)', [workflow, tenant]);
  await client.query(
    `INSERT INTO tenant_order_workflow_states (id,tenant_id,workflow_id,kind_code,position,label)
     VALUES ($1,$2,$3,'received',10,'{"en":"Received"}'::jsonb)`, [state, tenant, workflow],
  );
  await client.query('INSERT INTO menu_categories (id,tenant_id,name) VALUES ($1,$2,\'{"en":"Phase 3"}\'::jsonb)', [category, tenant]);
  await client.query(
    `INSERT INTO menu_items (id,tenant_id,category_id,name,base_price_amount_minor,base_price_currency_code)
     VALUES ($1,$2,$3,'{"en":"Phase 3"}'::jsonb,1000,'SAR')`, [menuItem, tenant, category],
  );
  await client.query('INSERT INTO stations (id,tenant_id,branch_id,name) VALUES ($1,$2,$3,\'Phase 3\')', [station, tenant, branch]);
  await client.query(
    `INSERT INTO orders (id,tenant_id,branch_id,order_type,sales_channel_code,current_status_kind_id)
     VALUES ($1,$2,$3,'takeaway','takeaway',$4)`, [order, tenant, branch, state],
  );
  await client.query(
    `INSERT INTO order_items (id,tenant_id,order_id,menu_item_id,item_name_snapshot,unit_price_minor,quantity,current_status_kind_id,station_id,is_voided,voided_at)
     VALUES ($1,$2,$3,$4,'{"en":"Phase 3"}'::jsonb,1000,1,$5,$6,$7,CASE WHEN $7 THEN now() ELSE NULL END)`,
    [orderItem, tenant, order, menuItem, state, station, options.voided ?? false],
  );
  await client.query(
    `INSERT INTO inventory_items (id,tenant_id,branch_id,name,base_unit)
     VALUES ($1,$2,$3,'{"en":"Component"}'::jsonb,'unit')`, [item, tenant, branch],
  );
  await client.query(
    `INSERT INTO stock_movements (id,tenant_id,branch_id,inventory_item_id,movement_type,quantity_delta,actor_user_id)
     VALUES ($1,$2,$3,$4,'manual_receiving',10,$5)`, [receiving, tenant, branch, item, user],
  );
  let layer = '0';
  if (options.withCost !== false) {
    const ledger = await client.query<{ id: string }>(
      `INSERT INTO inventory_cost_ledger (tenant_id,inventory_item_id,stock_movement_id,total_cost_minor,original_qty,currency_code,minor_unit_digits)
       VALUES ($1,$2,$3,1000,10,'SAR',2) RETURNING id::text`, [tenant, item, receiving],
    );
    const layers = await client.query<{ id: string }>(
      `INSERT INTO inventory_cost_layers (tenant_id,inventory_item_id,cost_ledger_id,original_qty,remaining_qty,total_cost_minor,remaining_cost_minor,currency_code,minor_unit_digits)
       VALUES ($1,$2,$3,10,10,1000,1000,'SAR',2) RETURNING id::text`, [tenant, item, ledger.rows[0]?.id],
    );
    layer = layers.rows[0]?.id ?? '0';
  }
  await client.query(
    `INSERT INTO stock_movements (id,tenant_id,branch_id,inventory_item_id,movement_type,quantity_delta,order_id,order_item_id,actor_user_id)
     VALUES ($1,$2,$3,$4,'sale_deduction',-2,$5,$6,$7)`, [sale, tenant, branch, item, order, orderItem, user],
  );
  if (options.withCost !== false) {
    await client.query(
      'UPDATE inventory_cost_layers SET remaining_qty=8, remaining_cost_minor=800 WHERE tenant_id=$1 AND id=$2',
      [tenant, layer],
    );
    await client.query(
      `INSERT INTO consumption_allocations
         (tenant_id,stock_movement_id,layer_id,order_item_id,qty,allocated_cost_minor)
       VALUES ($1,$2,$3,$4,2,200)`,
      [tenant, sale, layer, orderItem],
    );
  }
  const allocations = await client.query<{ id: string }>(
    'SELECT id::text FROM consumption_allocations WHERE tenant_id=$1 AND stock_movement_id=$2 ORDER BY id LIMIT 1', [tenant, sale],
  );
  return { tenant, branch, user, item, order, orderItem, layer, allocation: allocations.rows[0]?.id ?? '0' };
}

async function movement(client: pg.Client, f: Fixture, type: 'void_restoration' | 'waste_void' | 'waste_refund'): Promise<string> {
  await client.query("SELECT set_config('app.current_tenant_id', $1, false)", [f.tenant]);
  const id = randomUUID();
  await client.query(
    `INSERT INTO stock_movements (id,tenant_id,branch_id,inventory_item_id,movement_type,quantity_delta,order_id,order_item_id,actor_user_id)
     VALUES ($1,$2,$3,$4,$5,CASE WHEN $5='void_restoration' THEN 2 ELSE 0 END,$6,$7,$8)`,
    [id, f.tenant, f.branch, f.item, type, f.order, f.orderItem, f.user],
  );
  return id;
}

async function post(client: pg.Client, f: Fixture, movementId: string): Promise<void> {
  await client.query("SELECT set_config('app.current_tenant_id', $1, false)", [f.tenant]);
  await client.query('SELECT post_inventory_restoration($1,$2,$3,now())', [f.tenant, movementId, f.user]);
}

async function lines(client: pg.Client, tenant: string, source: string): Promise<readonly Record<string, string>[]> {
  await client.query("SELECT set_config('app.current_tenant_id', $1, false)", [tenant]);
  const result = await client.query<Record<string, string>>(
    `SELECT a.system_purpose, l.debit_minor::text, l.credit_minor::text
       FROM journal_entries e JOIN journal_entry_lines l ON l.tenant_id=e.tenant_id AND l.journal_entry_id=e.id
       JOIN accounts a ON a.tenant_id=l.tenant_id AND a.id=l.account_id
      WHERE e.tenant_id=$1 AND e.source_type='inventory_restoration' AND e.source_id=$2 ORDER BY l.line_number`, [tenant, source],
  );
  return result.rows;
}

async function transaction(work: (client: pg.Client) => Promise<void>): Promise<void> {
  await withTestClient(async (client) => {
    await client.query('BEGIN');
    try { await work(client); } finally { await client.query('ROLLBACK'); }
  });
}

describe('DD-005 phase 3 inventory restoration', () => {
  it('fully reverses a costed void restoration once and replays idempotently', () => transaction(async (client) => {
    const f = await fixture(client, { voided: true });
    const restored = await movement(client, f, 'void_restoration');
    await post(client, f, restored);
    await post(client, f, restored);
    expect(await lines(client, f.tenant, restored)).toEqual([
      { system_purpose: 'inventory_asset', debit_minor: '200', credit_minor: '0' },
      { system_purpose: 'cost_of_goods_in_process', debit_minor: '0', credit_minor: '200' },
    ]);
    const count = await client.query<{ count: string }>('SELECT count(*)::text AS count FROM restoration_allocations WHERE tenant_id=$1 AND restoration_stock_movement_id=$2', [f.tenant, restored]);
    expect(count.rows[0]?.count).toBe('1');
  }));

  it('reclassifies waste without restoring its FIFO layer', () => transaction(async (client) => {
    const f = await fixture(client, { voided: true });
    const waste = await movement(client, f, 'waste_void');
    await post(client, f, waste);
    expect(await lines(client, f.tenant, waste)).toEqual([
      { system_purpose: 'waste_expense', debit_minor: '200', credit_minor: '0' },
      { system_purpose: 'cost_of_goods_in_process', debit_minor: '0', credit_minor: '200' },
    ]);
    const layer = await client.query<{ qty: string; cost: string }>('SELECT remaining_qty::text AS qty, remaining_cost_minor::text AS cost FROM inventory_cost_layers WHERE id=$1', [f.layer]);
    expect(layer.rows[0]).toEqual({ qty: '8.0000', cost: '800' });
  }));

  it('reclassifies waste_refund once without restoring its FIFO layer', () => transaction(async (client) => {
    const f = await fixture(client);
    const waste = await movement(client, f, 'waste_refund');
    await post(client, f, waste);
    await post(client, f, waste);
    expect(await lines(client, f.tenant, waste)).toEqual([
      { system_purpose: 'waste_expense', debit_minor: '200', credit_minor: '0' },
      { system_purpose: 'cost_of_goods_in_process', debit_minor: '0', credit_minor: '200' },
    ]);
    const layer = await client.query<{ qty: string; cost: string }>('SELECT remaining_qty::text AS qty, remaining_cost_minor::text AS cost FROM inventory_cost_layers WHERE id=$1', [f.layer]);
    expect(layer.rows[0]).toEqual({ qty: '8.0000', cost: '800' });
    const allocations = await client.query<{ count: string }>('SELECT count(*)::text AS count FROM restoration_allocations WHERE tenant_id=$1 AND restoration_stock_movement_id=$2', [f.tenant, waste]);
    expect(allocations.rows[0]?.count).toBe('1');
  }));

  it('rejects waste_refund cost reclassification for a voided order line', () => transaction(async (client) => {
    const f = await fixture(client, { voided: true });
    const waste = await movement(client, f, 'waste_refund');
    await expect(post(client, f, waste)).rejects.toThrow('waste_refund cost reclassification requires a live order line');
  }));

  it('does nothing when no cost allocation was posted', () => transaction(async (client) => {
    const f = await fixture(client, { voided: true, withCost: false });
    const restored = await movement(client, f, 'void_restoration');
    await post(client, f, restored);
    expect(await lines(client, f.tenant, restored)).toEqual([]);
  }));

  it('posts independent movement-scoped reversals for multiple live refund lines', () => transaction(async (client) => {
    const first = await fixture(client);
    const second = await fixture(client);
    const a = await movement(client, first, 'void_restoration');
    const b = await movement(client, second, 'void_restoration');
    await post(client, first, a);
    await post(client, second, b);
    expect(await lines(client, first.tenant, a)).toHaveLength(2);
    expect(await lines(client, second.tenant, b)).toHaveLength(2);
  }));

  it('never processes one original allocation through waste and restoration', () => transaction(async (client) => {
    const f = await fixture(client, { voided: true });
    const waste = await movement(client, f, 'waste_void');
    const restored = await movement(client, f, 'void_restoration');
    await post(client, f, waste);
    await post(client, f, restored);
    expect(await lines(client, f.tenant, waste)).toHaveLength(2);
    expect(await lines(client, f.tenant, restored)).toEqual([]);
    const uses = await client.query<{ count: string }>('SELECT count(*)::text AS count FROM restoration_allocations WHERE tenant_id=$1 AND original_consumption_allocation_id=$2', [f.tenant, f.allocation]);
    expect(uses.rows[0]?.count).toBe('1');
  }));
});
