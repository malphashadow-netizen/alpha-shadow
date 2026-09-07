/**
 * Static guard for migrations/0007_seed_currencies.sql (no database needed).
 *
 * `currencies.minor_unit_digits` is the rounding scale used by every FX
 * conversion, and `ISO_4217_MINOR_UNITS` in src/shared/money.ts is the single
 * source of truth for that scale. A seed row that disagrees with it would make
 * the database and the arithmetic layer round differently — this test fails
 * the build before such a migration can ever be applied.
 *
 * It also pins the conflict policy (DO NOTHING, never DO UPDATE) and the
 * "never rewrite / never delete global reference data" rules.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ISO_4217_MINOR_UNITS } from '../../../src/shared/money.ts';

const REPO_ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const SEED_MIGRATION = join(REPO_ROOT, 'migrations', '0007_seed_currencies.sql');
const PHASE4_MIGRATION = join(REPO_ROOT, 'migrations', '0006_phase4_multi_currency_audit.sql');

/** Currencies this migration is contracted to provide (Phase 4b scope). */
export const SEEDED_CURRENCY_CODES = ['SAR', 'EGP', 'KWD', 'USD', 'AED', 'EUR'] as const;

const seedSql = readFileSync(SEED_MIGRATION, 'utf8');

/** Strips SQL comments so documentation prose never satisfies (or trips) an assertion. */
function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

/** Parses the `('XXX', n)` value tuples of the INSERT statement. */
function parseSeededRows(sql: string): Map<string, number> {
  const rows = new Map<string, number>();
  const code = stripSqlComments(sql);
  for (const match of code.matchAll(/\(\s*'([A-Z]{3})'\s*,\s*(\d+)\s*\)/g)) {
    const currency = match[1];
    const digits = match[2];
    if (currency === undefined || digits === undefined) continue;
    expect(rows.has(currency), `duplicate seed row for ${currency}`).toBe(false);
    rows.set(currency, Number.parseInt(digits, 10));
  }
  return rows;
}

describe('migrations/0007_seed_currencies.sql — seeded rows vs. ISO_4217_MINOR_UNITS', () => {
  const rows = parseSeededRows(seedSql);

  it('seeds exactly the six Phase 4b base currencies', () => {
    expect([...rows.keys()].sort()).toEqual([...SEEDED_CURRENCY_CODES].sort());
  });

  it.each(SEEDED_CURRENCY_CODES)('%s minor_unit_digits matches src/shared/money.ts exactly', (currency) => {
    const expected = ISO_4217_MINOR_UNITS[currency];
    expect(expected, `${currency} is missing from ISO_4217_MINOR_UNITS`).toBeTypeOf('number');
    expect(rows.get(currency)).toBe(expected);
  });

  it('pins KWD to three decimal digits (fils), never two', () => {
    expect(ISO_4217_MINOR_UNITS['KWD']).toBe(3);
    expect(rows.get('KWD')).toBe(3);
  });

  it('inserts with ON CONFLICT (code) DO NOTHING and never DO UPDATE', () => {
    const code = stripSqlComments(seedSql);
    expect(code).toMatch(/insert\s+into\s+currencies/i);
    expect(code).toMatch(/on\s+conflict\s*\(\s*code\s*\)\s*do\s+nothing/i);
    expect(code).not.toMatch(/do\s+update/i);
  });

  it('never rewrites or removes existing reference rows', () => {
    const code = stripSqlComments(seedSql);
    expect(code).not.toMatch(/\bupdate\s+currencies\b/i);
    expect(code).not.toMatch(/\bdelete\s+from\s+currencies\b/i);
    expect(code).not.toMatch(/\btruncate\b/i);
    expect(code).not.toMatch(/\bdrop\b/i);
  });

  it('is a separate file: migration 0006 stays schema-only and untouched', () => {
    const phase4 = stripSqlComments(readFileSync(PHASE4_MIGRATION, 'utf8'));
    expect(phase4).not.toMatch(/insert\s+into\s+currencies/i);
  });

  it('adds no RLS block — currencies is global and has no tenant_id column', () => {
    const code = stripSqlComments(seedSql);
    expect(code).not.toMatch(/\btenant_id\b/i);
    expect(code).not.toMatch(/row\s+level\s+security/i);
  });

  it('is not test/probe data (the production-safety guard still holds)', () => {
    expect(seedSql).not.toMatch(/INSERT\s+INTO\s+tenants/i);
    expect(seedSql).not.toMatch(/probe-tenant/i);
  });
});
