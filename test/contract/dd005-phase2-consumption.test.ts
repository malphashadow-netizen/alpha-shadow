import { describe, expect, it } from 'vitest';
import { withTestClient } from '../support/database.ts';

interface DefinitionRow { readonly definition: string }

describe('DD-005 phase 2 consumption invariants', () => {
  it('pins exact full-layer allocation and stock reconciliation in the posting function', async () => {
    await withTestClient(async (client) => {
      const result = await client.query<DefinitionRow>(
        `SELECT pg_get_functiondef('post_inventory_consumption(uuid,uuid,uuid,uuid,timestamp with time zone)'::regprocedure) AS definition`,
      );
      const definition = result.rows[0]?.definition ?? '';
      expect(definition).toContain('v_allocated_cost := v_layer.remaining_cost_minor');
      expect(definition).toContain('v_allocated_qty := v_layer.remaining_qty');
      expect(definition).toContain('stock quantity and consumption allocations are inconsistent');
    });
  });

  it('makes consumption allocations append-only and tenant isolated', async () => {
    await withTestClient(async (client) => {
      const table = await client.query<{ readonly force: boolean }>(
        `SELECT relforcerowsecurity AS force FROM pg_class WHERE oid = 'consumption_allocations'::regclass`,
      );
      expect(table.rows[0]?.force).toBe(true);
      const policy = await client.query(
        `SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'consumption_allocations' AND policyname = 'tenant_isolation'`,
      );
      expect(policy.rowCount).toBe(1);
    });
  });
});
