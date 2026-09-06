/**
 * Unit tests for the migration tooling (tools/migrate.ts + tools/check-migrations.ts)
 * and the production-safety invariants around test seed data.
 *
 * Verifies:
 *   1. tools/migrate.ts uses MIGRATION_DATABASE_URL EXCLUSIVELY and refuses to
 *      run when SEED_TEST_DATA=true (test seed is never applied by migrate,
 *      in production or anywhere else).
 *   2. tools/check-migrations.ts actually scans every .sql file, fails
 *      (exit ≠ 0) on an unapproved DROP … CASCADE, and passes when the file is
 *      listed in .cascade-approvals.json.
 *   3. migrations/*.sql contain NO data seeding, and the test seed lives only
 *      in test/support/seed.test.sql applied only by the test harness.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { assertMigrationEnvironment, assertMigrationUrl, SEED_TEST_DATA_KEY } from '../../../tools/lib/migrate-env.ts';
import { scanMigrationsDir } from '../../../tools/check-migrations.ts';

const REPO_ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const CHECK_SCRIPT = join(REPO_ROOT, 'tools', 'check-migrations.ts');

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'alpha-shadow-migrate-guard-'));
  tempDirs.push(dir);
  return dir;
}

const runCli = (...args: string[]) =>
  spawnSync(process.execPath, [CHECK_SCRIPT, ...args], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 60_000 });

describe('tools/migrate.ts — environment guard (MIGRATION_DATABASE_URL exclusive, no seed)', () => {
  const VALID_URL = 'postgresql://migrator:secret@db.internal:5432/app';

  it('refuses to run when MIGRATION_DATABASE_URL is missing (never falls back to DATABASE_URL)', () => {
    expect(() => assertMigrationEnvironment({})).toThrow(/MIGRATION_DATABASE_URL is not set/);
    expect(() => assertMigrationEnvironment({ MIGRATION_DATABASE_URL: '  ' })).toThrow(/MIGRATION_DATABASE_URL is not set/);
  });

  it('accepts a valid postgres URL and returns it trimmed', () => {
    expect(assertMigrationEnvironment({ MIGRATION_DATABASE_URL: ` ${VALID_URL} ` })).toBe(VALID_URL);
  });

  it('rejects malformed protocols / URLs', () => {
    expect(() => assertMigrationEnvironment({ MIGRATION_DATABASE_URL: 'https://db/app' })).toThrow(/postgres/);
    expect(() => assertMigrationEnvironment({ MIGRATION_DATABASE_URL: 'not a url' })).toThrow(/valid URL/);
  });

  it('refuses SEED_TEST_DATA=true REGARDLESS of NODE_ENV — including production explicitly', () => {
    const production: Record<string, string | undefined> = { NODE_ENV: 'production', MIGRATION_DATABASE_URL: VALID_URL, SEED_TEST_DATA: 'true' };
    expect(() => assertMigrationEnvironment(production)).toThrow(/SEED_TEST_DATA/);

    const dev: Record<string, string | undefined> = { NODE_ENV: 'development', MIGRATION_DATABASE_URL: VALID_URL, SEED_TEST_DATA: '1' };
    expect(() => assertMigrationEnvironment(dev)).toThrow(/SEED_TEST_DATA/);
  });

  it('production migration with valid URL and NO seed variable is allowed (schema only, no data)', () => {
    expect(assertMigrationEnvironment({ NODE_ENV: 'production', MIGRATION_DATABASE_URL: VALID_URL })).toBe(VALID_URL);
  });

  it('assertMigrationUrl is shared by the CLI module contract', () => {
    expect(assertMigrationUrl('postgresql://a/b')).toBe('postgresql://a/b');
    expect(() => assertMigrationUrl('mysql://a/b')).toThrow();
  });
});

describe('tools/check-migrations.ts — CASCADE guard really fails the CLI', () => {
  it('fails (exit ≠ 0) on an unapproved DROP … CASCADE and reports the file', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, '9999_bad.sql'), 'DROP TABLE IF EXISTS legacy_tenant CASCADE;\n');
    const result = runCli(dir);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('CASCADE');
    expect(result.stderr).toContain('9999_bad.sql');
  });

  it('passes (exit 0) when the CASCADE file is listed with an approval reason', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, '9999_approved.sql'), 'DROP TABLE IF EXISTS legacy_tenant CASCADE;\n');
    writeFileSync(
      join(dir, '.cascade-approvals.json'),
      JSON.stringify({ approvals: { '9999_approved.sql': 'Reviewer-approved destructive cleanup (dry-run on staging).' } }),
    );
    const result = runCli(dir);
    expect(result.status, result.stderr).toBe(0);
  });

  it('fails (exit ≠ 0) when the mandatory RLS template is missing for a tenant_id table', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, '9999_no_rls.sql'), 'CREATE TABLE t (id uuid, tenant_id uuid NOT NULL);\n');
    const result = runCli(dir);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('tenant_id');
  });

  it('scanMigrationsDir returns structured violations (not just CLI exit code)', async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, '9999_bad.sql'), 'DROP TABLE IF EXISTS legacy_tenant CASCADE;\n');
    const violations = await scanMigrationsDir(dir);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: '9999_bad.sql' });
    expect(violations[0]?.message).toContain('CASCADE');
  });

  it('the real migrations/ tree passes the guard (no unapproved CASCADE, RLS template present)', async () => {
    const violations = await scanMigrationsDir(join(REPO_ROOT, 'migrations'));
    expect(violations, violations.map((v) => v.message).join('\n')).toEqual([]);
  });
});

describe('production safety: test seed data never reaches migrations/', () => {
  it('no migrations/*.sql contains data seeding', () => {
    const sqlFiles = readdirSync(join(REPO_ROOT, 'migrations'))
      .filter((f) => f.endsWith('.sql'))
      .map((f) => readFileSync(join(REPO_ROOT, 'migrations', f), 'utf8'));
    for (const sql of sqlFiles) {
      expect(sql).not.toMatch(/INSERT\s+INTO\s+tenants/i);
      expect(sql).not.toMatch(/probe-tenant/i);
    }
  });

  it('the seed file lives ONLY in test/support and is applied ONLY by the test harness', () => {
    const seedPath = join(REPO_ROOT, 'test/support/seed.test.sql');
    const seed = readFileSync(seedPath, 'utf8');
    expect(seed).toMatch(/INSERT\s+INTO\s+tenants/i);
    expect(seed).toContain('probe-tenant');

    const harness = readFileSync(join(REPO_ROOT, 'test/support/postgres.global-setup.ts'), 'utf8');
    expect(harness).toContain('seed.test.sql');
    expect(harness).toContain('applyTestSeed');

    const migrate = readFileSync(join(REPO_ROOT, 'tools/migrate.ts'), 'utf8');
    // The doc header may mention the seed path, but the code never reads or
    // executes it — assert on actual data-source mechanics, not comments.
    expect(migrate).not.toContain('applyTestSeed');
    expect(migrate).not.toContain('TEST_SEED_FILE');
    expect(migrate).not.toMatch(/readFile\([^)]*seed\.test\.sql/);
    expect(migrate).toContain(SEED_TEST_DATA_KEY);
    expect(migrate).toContain('MIGRATION_DATABASE_URL');
    expect(migrate).toContain('assertMigrationEnvironment');
    expect(migrate).not.toMatch(/process\.env\[['"]DATABASE_URL['"]\]/);
  });

  it('CI runs the migration guard on the real migrations dir', () => {
    const ci = readFileSync(join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8');
    expect(ci).toContain('npm run check:migrations');
  });
});
