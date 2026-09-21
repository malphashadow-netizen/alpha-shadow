import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { withTestClient } from '../support/database.ts';

interface DefinitionRow { readonly definition: string }

describe('DD-005 phase 4 order COGS invariants', () => {
  it('pins tenant isolation, net WIP calculation, journal identity, and idempotency', async () => {
    await withTestClient(async (client) => {
      const result = await client.query<DefinitionRow>(
        `SELECT pg_get_functiondef('post_order_cogs(uuid,uuid,uuid,timestamp with time zone)'::regprocedure) AS definition`,
      );
      const definition = result.rows[0]?.definition ?? '';
      expect(definition).toContain("current_setting('app.current_tenant_id')");
      expect(definition).toContain('restored_cost_minor');
      expect(definition).toContain("'order_cogs'");
      expect(definition).toContain('ON CONFLICT (tenant_id, source_type, source_id) DO NOTHING');
      expect(definition).toContain('cardinality(debit_ids)');
      expect(definition).toContain('cardinality(credit_ids)');
    });
  });

  it('revokes public execution and grants app_login through the phase role script', async () => {
    await withTestClient(async (client) => {
      const publicExecute = await client.query(
        `SELECT has_function_privilege('public',
          'post_order_cogs(uuid,uuid,uuid,timestamp with time zone)', 'EXECUTE') AS allowed`,
      );
      expect(publicExecute.rows[0]).toEqual({ allowed: false });
    });
    const roles = await readFile(new URL('../../migrations/roles/022_dd005_phase4.sql', import.meta.url), 'utf8');
    expect(roles).toContain('GRANT SELECT ON consumption_allocations, restoration_allocations TO app_login');
    expect(roles).toContain('GRANT EXECUTE ON FUNCTION post_order_cogs(uuid, uuid, uuid, timestamptz) TO app_login');
    expect(roles).not.toMatch(/GRANT[^;]*(?:INSERT|UPDATE|DELETE)/);
  });
});
