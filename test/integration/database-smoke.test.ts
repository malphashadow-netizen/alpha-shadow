/**
 * Integration harness smoke test.
 *
 * Phase 0 has no application database code yet (withTenantContext() arrives in
 * Phase 1). This test exists to prove, in CI, that the integration project is
 * wired to a REAL PostgreSQL server and that transaction-scoped settings behave
 * the way Phase 1's design relies on:
 *
 *   - `SET LOCAL` inside an explicit transaction is visible in that transaction
 *     and gone after COMMIT — the property withTenantContext() depends on.
 *   - `DISCARD ALL` clears session-level state (what the pool release hook will
 *     issue as defence-in-depth).
 */
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { connectTestClient } from '../support/database.ts';

const currentTenant = async (client: pg.Client): Promise<string> => {
  const r = await client.query<{ v: string }>("SELECT current_setting('app.current_tenant_id', true) AS v");
  return r.rows[0]?.v ?? '';
};

describe('integration harness: real PostgreSQL semantics used by withTenantContext()', () => {
  let client: pg.Client;
  const tenantA = '00000000-0000-4000-8000-00000000000a';

  beforeAll(async () => {
    client = await connectTestClient();
  });
  afterAll(async () => {
    await client.end();
  });

  it('SET LOCAL is scoped to the explicit transaction and vanishes after COMMIT', async () => {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantA]);
    expect(await currentTenant(client)).toBe(tenantA);
    await client.query('COMMIT');
    expect(await currentTenant(client)).toBe('');
  });

  it('SET LOCAL is also discarded on ROLLBACK', async () => {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantA]);
    await client.query('ROLLBACK');
    expect(await currentTenant(client)).toBe('');
  });

  it('a session-level SET (the dangerous form) leaks across statements until DISCARD ALL', async () => {
    // This is exactly why the spec forbids SET outside an explicit transaction:
    await client.query("SELECT set_config('app.current_tenant_id', $1, false)", [tenantA]);
    expect(await currentTenant(client)).toBe(tenantA);
    await client.query('DISCARD ALL');
    expect(await currentTenant(client)).toBe('');
  });
});
