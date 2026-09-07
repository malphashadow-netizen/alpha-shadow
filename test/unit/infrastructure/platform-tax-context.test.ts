import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { createWithPlatformTaxContext, resolvePlatformTaxDatabaseUrl } from '../../../src/infrastructure/db/platform-tax-context.ts';
import { createWithTenantContext, type TenantClient, type TenantPool, type TenantQuery } from '../../../src/infrastructure/db/tenant-context.ts';
import { ForbiddenError } from '../../../src/shared/errors.ts';
import { TAX_ACTOR, TAX_TENANT } from '../../support/tax-fakes.ts';

function fixture(permitted = true, tenantContext: string | null = null) {
  const statements: string[] = []; const released: (Error | boolean | undefined)[] = [];
  let failDiscard = false;
  const client: TenantClient = {
    async query<R extends pg.QueryResultRow>(text: string): Promise<pg.QueryResult<R>> {
      statements.push(text);
      if (text === 'DISCARD ALL' && failDiscard) throw new Error('discard failed');
      const rows = text.includes('AS permitted') ? [{ permitted, tenant_context: tenantContext }] : [];
      return { rows: rows as unknown as R[], rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] };
    },
    release(error) { released.push(error); },
  };
  const pool: TenantPool = { async connect() { return client; } };
  return { pool, statements, released, failDiscard() { failDiscard = true; } };
}

describe('isolated platform tax capability lifecycle', () => {
  it('requires a separate configured principal and never prints connection credentials in errors', () => {
    expect(() => resolvePlatformTaxDatabaseUrl({})).toThrow(/required/);
    expect(() => resolvePlatformTaxDatabaseUrl({ PLATFORM_TAX_DATABASE_URL: 'https://example.test' })).toThrow(/PostgreSQL/);
    expect(() => resolvePlatformTaxDatabaseUrl({ PLATFORM_TAX_DATABASE_URL: 'postgres://service@db/test', DATABASE_URL: 'postgres://service@db/other' })).toThrow(/must not reuse/);
    expect(resolvePlatformTaxDatabaseUrl({ PLATFORM_TAX_DATABASE_URL: 'postgres://platform@db/test', DATABASE_URL: 'postgres://app@db/test' })).toBe('postgres://platform@db/test');
  });
  it('rejects a tenant credential, or any existing tenant context, before the callback', async () => {
    for (const f of [fixture(false), fixture(true, TAX_TENANT)]) {
      let called = false;
      await expect(createWithPlatformTaxContext(f.pool)(TAX_ACTOR, async () => { called = true; })).rejects.toBeInstanceOf(ForbiddenError);
      expect(called).toBe(false);
      expect(f.statements).toContain('ROLLBACK');
      expect(f.statements.at(-1)).toBe('DISCARD ALL');
      expect(f.released).toHaveLength(1);
    }
  });
  it('commits once, scrubs ROLE/GUC state, and expires its narrow query capability', async () => {
    const f = fixture(); let captured: TenantQuery | undefined;
    expect(await createWithPlatformTaxContext(f.pool)(TAX_ACTOR, async (q) => { captured = q; return 42; })).toBe(42);
    expect(f.statements).toContain('SET LOCAL ROLE platform_tax_admin');
    expect(f.statements.slice(-2)).toEqual(['COMMIT', 'DISCARD ALL']);
    expect(() => captured?.query('SELECT 1')).toThrow(/scope has ended/);
    expect(f.released).toEqual([undefined]);
  });
  it('rolls back failures and destroys a connection when DISCARD ALL fails', async () => {
    const f = fixture(); f.failDiscard();
    await expect(createWithPlatformTaxContext(f.pool)(TAX_ACTOR, async () => { throw new Error('operation failed'); })).rejects.toBeInstanceOf(AggregateError);
    expect(f.statements.slice(-2)).toEqual(['ROLLBACK', 'DISCARD ALL']);
    expect(f.released).toEqual([true]);
  });
  it('rejects malformed actors before acquiring any database resources', async () => {
    const f = fixture(); await expect(createWithPlatformTaxContext(f.pool)('bad', async () => 1)).rejects.toThrow(/actor UUID/);
    expect(f.statements).toEqual([]);
  });
  it('tax repeatable-read isolation is set in BEGIN, before tenant/existence reads', async () => {
    const f = fixture();
    await createWithTenantContext(f.pool)(TAX_TENANT, async () => 1, { isolationLevel: 'repeatable read' });
    expect(f.statements[0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ');
  });
});
