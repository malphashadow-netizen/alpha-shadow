import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectTestClient, testDatabaseUrl, withTestClient } from '../support/database.ts';

const tenant = '33333333-3333-4333-8333-333333333333';
const role = `app_login_dd005p1_${randomBytes(6).toString('hex')}`;
const rolePassword = randomBytes(18).toString('hex');

async function fixture(client: pg.Client): Promise<{ ledger: number; layer: number; branch: string; item: string; user: string }> {
  const branch=randomUUID(), item=randomUUID(), user=randomUUID(), appRole=randomUUID(), movement=randomUUID();
  await client.query('SELECT set_config($1,$2,false)',['app.current_tenant_id',tenant]);
  await client.query("INSERT INTO branches (id,tenant_id,name,base_currency,timezone,country_code) VALUES ($1,$2,$3,'SAR','Asia/Riyadh','SA')",[branch,tenant,branch]);
  await client.query('INSERT INTO users (id,tenant_id,email,pin_hash) VALUES ($1,$2,$3,$4)',[user,tenant,`${user}@example.test`,'fixture']);
  await client.query('INSERT INTO roles (id,tenant_id,name) VALUES ($1,$2,$3)',[appRole,tenant,appRole]);
  await client.query("INSERT INTO role_permissions (tenant_id,role_id,permission_key) VALUES ($1,$2,'inventory:receive')",[tenant,appRole]);
  await client.query("INSERT INTO user_roles (tenant_id,user_id,role_id,scope_type,scope_id) VALUES ($1,$2,$3,'tenant',NULL)",[tenant,user,appRole]);
  await client.query('INSERT INTO inventory_items (id,tenant_id,branch_id,name,base_unit) VALUES ($1,$2,$3,$4::jsonb,$5)',[item,tenant,branch,'{"en":"fixture"}','unit']);
  await client.query("INSERT INTO stock_movements (id,tenant_id,branch_id,inventory_item_id,movement_type,quantity_delta,actor_user_id) VALUES ($1,$2,$3,$4,'manual_receiving',10,$5)",[movement,tenant,branch,item,user]);
  const ledger=await client.query<{readonly id:string}>('INSERT INTO inventory_cost_ledger (tenant_id,inventory_item_id,stock_movement_id,total_cost_minor,original_qty,currency_code,minor_unit_digits) VALUES ($1,$2,$3,100,10,$4,2) RETURNING id',[tenant,item,movement,'SAR']);
  const layer=await client.query<{readonly id:string}>('INSERT INTO inventory_cost_layers (tenant_id,inventory_item_id,cost_ledger_id,original_qty,remaining_qty,total_cost_minor,remaining_cost_minor,currency_code,minor_unit_digits) VALUES ($1,$2,$3,10,10,100,100,$4,2) RETURNING id',[tenant,item,ledger.rows[0]?.id,'SAR']);
  return {ledger:Number(ledger.rows[0]?.id),layer:Number(layer.rows[0]?.id),branch,item,user};
}
async function rejected(work:()=>Promise<unknown>, code:string):Promise<void>{try{await work();throw new Error('expected rejection');}catch(error:unknown){expect((error as {code?:string}).code).toBe(code);}}
async function tx(work:(client:pg.Client)=>Promise<void>):Promise<void>{await withTestClient(async(client)=>{await client.query('BEGIN');try{await work(client);}finally{await client.query('ROLLBACK');}});}

describe('DD-005 cost ledger append-only barriers', () => {
  beforeAll(async()=>{const client=await connectTestClient();try{await client.query(`CREATE ROLE ${role} LOGIN PASSWORD '${rolePassword}'`);await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);await client.query(`GRANT SELECT, INSERT ON inventory_cost_ledger TO ${role}`);}finally{await client.end();}});
  afterAll(async()=>{const client=await connectTestClient();try{await client.query(`DROP OWNED BY ${role}`);}finally{try{await client.query(`DROP ROLE ${role}`);}finally{await client.end();}}});
  it('blocks UPDATE on inventory_cost_ledger',async()=>tx(async(client)=>{const f=await fixture(client);await rejected(()=>client.query('UPDATE inventory_cost_ledger SET total_cost_minor=99 WHERE id=$1',[f.ledger]),'55006');}));
  it('blocks DELETE on inventory_cost_ledger',async()=>tx(async(client)=>{const f=await fixture(client);await rejected(()=>client.query('DELETE FROM inventory_cost_ledger WHERE id=$1',[f.ledger]),'55006');}));
  it('blocks DELETE on inventory_cost_layers',async()=>tx(async(client)=>{const f=await fixture(client);await rejected(()=>client.query('DELETE FROM inventory_cost_layers WHERE id=$1',[f.layer]),'55006');}));
  it('blocks changing an immutable layer column',async()=>tx(async(client)=>{const f=await fixture(client);await rejected(()=>client.query('UPDATE inventory_cost_layers SET tenant_id=$1, original_qty=9, total_cost_minor=99 WHERE id=$2',[tenant,f.layer]),'42501');}));
  it('blocks increasing remaining_qty',async()=>tx(async(client)=>{const f=await fixture(client);await rejected(()=>client.query('UPDATE inventory_cost_layers SET remaining_qty=11 WHERE id=$1',[f.layer]),'42501');}));
  it('blocks increasing remaining_cost_minor',async()=>tx(async(client)=>{const f=await fixture(client);await rejected(()=>client.query('UPDATE inventory_cost_layers SET remaining_cost_minor=101 WHERE id=$1',[f.layer]),'42501');}));
  it('allows decreasing remaining_qty and remaining_cost_minor together',async()=>tx(async(client)=>{const f=await fixture(client);const updated=await client.query('UPDATE inventory_cost_layers SET remaining_qty=0,remaining_cost_minor=0 WHERE id=$1',[f.layer]);expect(updated.rowCount).toBe(1);const row=await client.query<{readonly remaining_qty:string;readonly remaining_cost_minor:string}>('SELECT remaining_qty::text,remaining_cost_minor::text FROM inventory_cost_layers WHERE id=$1',[f.layer]);expect(row.rows[0]).toEqual({remaining_qty:'0.0000',remaining_cost_minor:'0'});}));
  it('grants app_login insert and select but never update on the ledger',async()=>{const owner=await connectTestClient();let f:Awaited<ReturnType<typeof fixture>>;try{f=await fixture(owner);const movement=randomUUID();await owner.query("INSERT INTO stock_movements (id,tenant_id,branch_id,inventory_item_id,movement_type,quantity_delta,actor_user_id) VALUES ($1,$2,$3,$4,'manual_receiving',10,$5)",[movement,tenant,f.branch,f.item,f.user]);const url=new URL(testDatabaseUrl());url.username=role;url.password=rolePassword;const client=new pg.Client({connectionString:url.toString()});await client.connect();try{await client.query('SELECT set_config($1,$2,false)',['app.current_tenant_id',tenant]);await client.query('SELECT * FROM inventory_cost_ledger');const inserted=await client.query('INSERT INTO inventory_cost_ledger (tenant_id,inventory_item_id,stock_movement_id,total_cost_minor,original_qty,currency_code,minor_unit_digits) VALUES ($1,$2,$3,1,1,$4,2)',[tenant,f.item,movement,'SAR']);expect(inserted.rowCount).toBe(1);await rejected(()=>client.query('UPDATE inventory_cost_ledger SET total_cost_minor=1'),'42501');await rejected(()=>client.query('DELETE FROM inventory_cost_ledger'),'42501');}finally{await client.end();}}finally{await owner.end();}});
});
