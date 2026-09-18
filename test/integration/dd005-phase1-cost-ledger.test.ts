import { randomUUID } from "node:crypto";
import type pg from "pg";
import { describe, expect, it } from "vitest";
import { withTestClient } from "../support/database.ts";

interface IdRow {
  readonly id: string | number;
}
interface CostRow {
  readonly id: string;
  readonly is_provisional: boolean;
}
interface SumRow {
  readonly total: string;
}

const tenantA = "11111111-1111-4111-8111-111111111111";
const tenantB = "22222222-2222-4222-8222-222222222222";

interface Fixture {
  readonly branch: string;
  readonly item: string;
  readonly movement: string;
  readonly user: string;
}

async function movement(
  client: pg.Client,
  tenant: string,
  branch: string,
  item: string,
  user: string,
): Promise<string> {
  const id = randomUUID();
  await client.query(
    "INSERT INTO stock_movements (id, tenant_id, branch_id, inventory_item_id, movement_type, quantity_delta, actor_user_id) VALUES ($1, $2, $3, $4, 'manual_receiving', 10, $5)",
    [id, tenant, branch, item, user],
  );
  return id;
}

async function fixture(client: pg.Client, tenant = tenantA): Promise<Fixture> {
  const branch = randomUUID();
  const item = randomUUID();
  const user = randomUUID();
  const role = randomUUID();
  await client.query("SELECT set_config($1, $2, false)", [
    "app.current_tenant_id",
    tenant,
  ]);
  await client.query(
    "INSERT INTO branches (id, tenant_id, name, base_currency, timezone, country_code) VALUES ($1, $2, $3, 'SAR', 'Asia/Riyadh', 'SA')",
    [branch, tenant, branch],
  );
  await client.query(
    "INSERT INTO users (id, tenant_id, email, pin_hash) VALUES ($1, $2, $3, $4)",
    [user, tenant, `${user}@example.test`, "fixture"],
  );
  await client.query(
    "INSERT INTO roles (id, tenant_id, name) VALUES ($1, $2, $3)",
    [role, tenant, role],
  );
  await client.query(
    "INSERT INTO role_permissions (tenant_id, role_id, permission_key) VALUES ($1, $2, 'inventory:receive')",
    [tenant, role],
  );
  await client.query(
    "INSERT INTO user_roles (tenant_id, user_id, role_id, scope_type, scope_id) VALUES ($1, $2, $3, 'tenant', NULL)",
    [tenant, user, role],
  );
  await client.query(
    "INSERT INTO inventory_items (id, tenant_id, branch_id, name, base_unit) VALUES ($1, $2, $3, $4::jsonb, $5)",
    [item, tenant, branch, '{"en":"fixture"}', "unit"],
  );
  const movementId = await movement(client, tenant, branch, item, user);
  return { branch, item, movement: movementId, user };
}

async function ledger(
  client: pg.Client,
  item: string,
  movement: string,
  cost = 5000,
  currency = "SAR",
): Promise<number> {
  const result = await client.query<IdRow>(
    "INSERT INTO inventory_cost_ledger (tenant_id, inventory_item_id, stock_movement_id, total_cost_minor, original_qty, currency_code, minor_unit_digits) VALUES ($1, $2, $3, $4, 10, $5, 2) RETURNING id",
    [tenantA, item, movement, cost, currency],
  );
  return Number(result.rows[0]?.id);
}

async function expectCode(
  work: () => Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await work();
    throw new Error("expected database rejection");
  } catch (error: unknown) {
    expect((error as { code?: string }).code).toBe(code);
  }
}

describe("DD-005 phase 1 cost ledger structure", () => {
  async function transaction(
    work: (client: pg.Client) => Promise<void>,
  ): Promise<void> {
    await withTestClient(async (client) => {
      await client.query("BEGIN");
      try {
        await work(client);
      } finally {
        await client.query("ROLLBACK");
      }
    });
  }

  it("rejects a ledger row whose stock movement belongs to another tenant", async () =>
    transaction(async (client) => {
      const f = await fixture(client, tenantB);
      await client.query("SELECT set_config($1, $2, false)", [
        "app.current_tenant_id",
        tenantA,
      ]);
      await expectCode(
        () =>
          client.query(
            "INSERT INTO inventory_cost_ledger (tenant_id, inventory_item_id, stock_movement_id, total_cost_minor, original_qty, currency_code, minor_unit_digits) VALUES ($1, $2, $3, 1, 1, $4, 2)",
            [tenantA, f.item, f.movement, "SAR"],
          ),
        "42501",
      );
    }));
  it("rejects a second ledger row for the same stock movement", async () =>
    transaction(async (client) => {
      const f = await fixture(client);
      await ledger(client, f.item, f.movement);
      await expectCode(() => ledger(client, f.item, f.movement), "23505");
    }));
  it("assigns ascending identity ids in insertion order", async () =>
    transaction(async (client) => {
      const f = await fixture(client);
      const a = await ledger(client, f.item, f.movement);
      const secondMovement = await movement(
        client,
        tenantA,
        f.branch,
        f.item,
        f.user,
      );
      const b = await ledger(client, f.item, secondMovement);
      expect(b).toBeGreaterThan(a);
    }));
  it("rejects total_cost_minor of zero", async () =>
    transaction(async (client) => {
      const f = await fixture(client);
      await expectCode(() => ledger(client, f.item, f.movement, 0), "23514");
    }));
  it("rejects original_qty of zero", async () =>
    transaction(async (client) => {
      const f = await fixture(client);
      await expectCode(
        () =>
          client.query(
            "INSERT INTO inventory_cost_ledger (tenant_id, inventory_item_id, stock_movement_id, total_cost_minor, original_qty, currency_code, minor_unit_digits) VALUES ($1,$2,$3,1,0,$4,2)",
            [tenantA, f.item, f.movement, "SAR"],
          ),
        "23514",
      );
    }));
  it("rejects minor_unit_digits above four", async () =>
    transaction(async (client) => {
      const f = await fixture(client);
      await expectCode(
        () =>
          client.query(
            "INSERT INTO inventory_cost_ledger (tenant_id, inventory_item_id, stock_movement_id, total_cost_minor, original_qty, currency_code, minor_unit_digits) VALUES ($1,$2,$3,1,1,$4,5)",
            [tenantA, f.item, f.movement, "SAR"],
          ),
        "23514",
      );
    }));
  it("rejects a layer whose remaining_qty exceeds original_qty", async () =>
    transaction(async (client) => {
      const f = await fixture(client);
      const id = await ledger(client, f.item, f.movement);
      await expectCode(
        () =>
          client.query(
            "INSERT INTO inventory_cost_layers (tenant_id,inventory_item_id,cost_ledger_id,original_qty,remaining_qty,total_cost_minor,remaining_cost_minor,currency_code,minor_unit_digits) VALUES ($1,$2,$3,10,11,5000,5000,$4,2)",
            [tenantA, f.item, id, "SAR"],
          ),
        "23514",
      );
    }));
  it("rejects a layer whose remaining_cost_minor exceeds total_cost_minor", async () =>
    transaction(async (client) => {
      const f = await fixture(client);
      const id = await ledger(client, f.item, f.movement);
      await expectCode(
        () =>
          client.query(
            "INSERT INTO inventory_cost_layers (tenant_id,inventory_item_id,cost_ledger_id,original_qty,remaining_qty,total_cost_minor,remaining_cost_minor,currency_code,minor_unit_digits) VALUES ($1,$2,$3,10,10,5000,5001,$4,2)",
            [tenantA, f.item, id, "SAR"],
          ),
        "23514",
      );
    }));
  it("rejects a fully consumed layer that still carries remaining cost", async () =>
    transaction(async (client) => {
      const f = await fixture(client);
      const id = await ledger(client, f.item, f.movement);
      await expectCode(
        () =>
          client.query(
            "INSERT INTO inventory_cost_layers (tenant_id,inventory_item_id,cost_ledger_id,original_qty,remaining_qty,total_cost_minor,remaining_cost_minor,currency_code,minor_unit_digits) VALUES ($1,$2,$3,10,0,5000,1,$4,2)",
            [tenantA, f.item, id, "SAR"],
          ),
        "23514",
      );
    }));
  it("rejects a layer pointing at a ledger row for a different inventory item", async () =>
    transaction(async (client) => {
      const f = await fixture(client);
      const id = await ledger(client, f.item, f.movement);
      const other = await fixture(client);
      await expectCode(
        () =>
          client.query(
            "INSERT INTO inventory_cost_layers (tenant_id,inventory_item_id,cost_ledger_id,original_qty,remaining_qty,total_cost_minor,remaining_cost_minor,currency_code,minor_unit_digits) VALUES ($1,$2,$3,10,10,5000,5000,$4,2)",
            [tenantA, other.item, id, "SAR"],
          ),
        "23503",
      );
    }));
  it("rejects a ledger row whose currency differs from an earlier row of the same item", async () =>
    transaction(async (client) => {
      const f = await fixture(client);
      await ledger(client, f.item, f.movement);
      const laterMovement = await movement(
        client,
        tenantA,
        f.branch,
        f.item,
        f.user,
      );
      try {
        await ledger(client, f.item, laterMovement, 1, "USD");
        throw new Error("expected currency rejection");
      } catch (error: unknown) {
        expect((error as { code?: string }).code).toBe("42501");
        expect((error as Error).message).toContain("currency");
      }
    }));
  it("defaults is_provisional to false on a plain receipt row", async () =>
    transaction(async (client) => {
      const f = await fixture(client);
      const id = await ledger(client, f.item, f.movement);
      const result = await client.query<CostRow>(
        "SELECT id::text, is_provisional FROM inventory_cost_ledger WHERE id=$1",
        [id],
      );
      expect(result.rows[0]?.is_provisional).toBe(false);
    }));
  it("orders two receipt layers FIFO by identity id", async () =>
    transaction(async (client) => {
      const f = await fixture(client);
      const first = await ledger(client, f.item, f.movement, 5000);
      const laterMovement = await movement(
        client,
        tenantA,
        f.branch,
        f.item,
        f.user,
      );
      const second = await ledger(client, f.item, laterMovement, 7000);
      for (const [id, cost] of [
        [first, 5000],
        [second, 7000],
      ] as const)
        await client.query(
          "INSERT INTO inventory_cost_layers (tenant_id,inventory_item_id,cost_ledger_id,original_qty,remaining_qty,total_cost_minor,remaining_cost_minor,currency_code,minor_unit_digits) VALUES ($1,$2,$3,10,10,$4,$4,$5,2)",
          [tenantA, f.item, id, cost, "SAR"],
        );
      const sum = await client.query<SumRow>(
        "SELECT SUM(total_cost_minor)::text AS total FROM inventory_cost_layers WHERE inventory_item_id=$1",
        [f.item],
      );
      const rows = await client.query<{ readonly total_cost_minor: string }>(
        "SELECT total_cost_minor::text FROM inventory_cost_layers WHERE inventory_item_id=$1 ORDER BY id",
        [f.item],
      );
      expect(sum.rows[0]?.total).toBe("12000");
      expect(rows.rows.map((row) => row.total_cost_minor)).toEqual([
        "5000",
        "7000",
      ]);
    }));
  it("rejects a ledger row whose stock movement belongs to another inventory item", async () =>
    transaction(async (client) => {
      const f = await fixture(client);
      const other = await fixture(client);
      await expectCode(() => ledger(client, f.item, other.movement), "42501");
    }));
  it("rejects a layer whose currency differs from its ledger", async () =>
    transaction(async (client) => {
      const f = await fixture(client);
      const id = await ledger(client, f.item, f.movement);
      await expectCode(
        () =>
          client.query(
            "INSERT INTO inventory_cost_layers (tenant_id,inventory_item_id,cost_ledger_id,original_qty,remaining_qty,total_cost_minor,remaining_cost_minor,currency_code,minor_unit_digits) VALUES ($1,$2,$3,10,10,5000,5000,'USD',2)",
            [tenantA, f.item, id],
          ),
        "42501",
      );
    }));
  it("rejects a layer whose receipt quantity differs from its ledger", async () =>
    transaction(async (client) => {
      const f = await fixture(client);
      const id = await ledger(client, f.item, f.movement);
      await expectCode(
        () =>
          client.query(
            "INSERT INTO inventory_cost_layers (tenant_id,inventory_item_id,cost_ledger_id,original_qty,remaining_qty,total_cost_minor,remaining_cost_minor,currency_code,minor_unit_digits) VALUES ($1,$2,$3,9,9,5000,5000,'SAR',2)",
            [tenantA, f.item, id],
          ),
        "42501",
      );
    }));
  it("hides another tenant cost ledger rows under RLS", async () =>
    transaction(async (client) => {
      const a = await fixture(client);
      await ledger(client, a.item, a.movement);
      const b = await fixture(client, tenantB);
      await client.query("SELECT set_config($1,$2,false)", [
        "app.current_tenant_id",
        tenantB,
      ]);
      await client.query(
        "INSERT INTO inventory_cost_ledger (tenant_id,inventory_item_id,stock_movement_id,total_cost_minor,original_qty,currency_code,minor_unit_digits) VALUES ($1,$2,$3,1,1,$4,2)",
        [tenantB, b.item, b.movement, "SAR"],
      );
      const reader = `dd005_rls_${randomUUID().replaceAll("-", "")}`;
      await client.query(`CREATE ROLE ${reader}`);
      await client.query(`GRANT SELECT ON inventory_cost_ledger TO ${reader}`);
      await client.query(`SET LOCAL ROLE ${reader}`);
      await client.query("SELECT set_config($1,$2,false)", [
        "app.current_tenant_id",
        tenantA,
      ]);
      const rows = await client.query<IdRow>(
        "SELECT id FROM inventory_cost_ledger",
      );
      expect(rows.rowCount).toBe(1);
    }));
});
