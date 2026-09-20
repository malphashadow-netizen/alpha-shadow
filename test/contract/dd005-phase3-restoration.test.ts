import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { withTestClient } from '../support/database.ts';

interface DefinitionRow { readonly definition: string }

describe('DD-005 phase 3 restoration invariants', () => {
  it('pins cross-movement allocation deduplication and movement-scoped journal identity', async () => {
    await withTestClient(async (client) => {
      const result = await client.query<DefinitionRow>(
        `SELECT pg_get_functiondef('post_inventory_restoration(uuid,uuid,uuid,timestamp with time zone)'::regprocedure) AS definition`,
      );
      const definition = result.rows[0]?.definition ?? '';
      expect(definition).toContain("'inventory_restoration'");
      expect(definition).toContain('original_consumption_allocation_id');
      expect(definition).toContain('NOT EXISTS');
      expect(definition).toContain("oi.is_voided");
    });
  });

  it('forces tenant isolation and immutability on restoration allocations', async () => {
    await withTestClient(async (client) => {
      const table = await client.query<{ readonly force: boolean }>(
        `SELECT relforcerowsecurity AS force FROM pg_class WHERE oid = 'restoration_allocations'::regclass`,
      );
      expect(table.rows[0]?.force).toBe(true);
      const policy = await client.query(
        `SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'restoration_allocations' AND policyname = 'tenant_isolation'`,
      );
      expect(policy.rowCount).toBe(1);
      const trigger = await client.query(
        `SELECT 1 FROM pg_trigger WHERE tgrelid = 'restoration_allocations'::regclass AND tgname = 'trg_restoration_allocations_immutable' AND NOT tgisinternal`,
      );
      expect(trigger.rowCount).toBe(1);
    });
  });

  it('grants phase-3 evidence only SELECT and INSERT', async () => {
    const roles = await readFile(new URL('../../migrations/roles/021_dd005_phase3.sql', import.meta.url), 'utf8');
    expect(roles).toContain('GRANT SELECT, INSERT ON restoration_allocations TO app_login');
    expect(roles).not.toMatch(/GRANT[^;]*(?:UPDATE|DELETE)/);
  });
});
