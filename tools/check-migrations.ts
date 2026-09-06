#!/usr/bin/env node
/**
 * CI guard for migration security.
 *
 *   node tools/check-migrations.ts            # scan migrations/ (default)
 *   node tools/check-migrations.ts <dir>      # scan another directory
 *   node tools/check-migrations.ts --self-test# prove the guard detects violations
 *
 * Rules enforced (see tools/lib/migration-security.ts and migrations/README.md):
 *   1. No `DROP … CASCADE` without a tracked approval in
 *      migrations/.cascade-approvals.json.
 *   2. Every migration creating a tenant_id table carries the mandatory RLS
 *      template (ENABLE + FORCE + tenant_isolation FOR ALL policy).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkMigrationFile, parseApprovals, type MigrationViolation } from './lib/migration-security.ts';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

export async function scanMigrationsDir(migrationsDir: string): Promise<MigrationViolation[]> {
  const entries = await readdir(migrationsDir, { withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile() && e.name.endsWith('.sql'))
    .map((e) => e.name)
    .sort();

  let approvals: Record<string, string> = {};
  try {
    const raw = await readFile(join(migrationsDir, '.cascade-approvals.json'), 'utf8');
    approvals = parseApprovals(raw).approvals;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      throw error;
    }
    // No approvals file → zero approvals, guard is at its strictest.
  }

  const violations: MigrationViolation[] = [];
  for (const fileName of files) {
    const sql = await readFile(join(migrationsDir, fileName), 'utf8');
    violations.push(...checkMigrationFile({ fileName, sql, approvals }));
  }
  return violations;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);

  if (args[0] === '--self-test') {
    const dir = mkdtempSync(join(tmpdir(), 'alpha-shadow-migration-guard-'));
    try {
      const bad = join(dir, '9999_selfcheck.sql');
      writeFileSync(
        bad,
        'DROP TABLE IF EXISTS legacy_tenant CASCADE;\nCREATE TABLE legacy_tenant (id uuid, tenant_id uuid);\n',
      );
      const violations = await scanMigrationsDir(dir);
      const cascade = violations.filter((v) => v.message.includes('CASCADE'));
      const rls = violations.filter((v) => v.message.includes('tenant_id'));
      if (cascade.length === 0 || rls.length === 0) {
        console.error('Migration guard self-test FAILED: guard did not flag the deliberate violations.');
        return 1;
      }
      console.log('Migration guard self-test passed (flagged CASCADE + missing RLS template).');
      return 0;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const target = args[0] ?? join(REPO_ROOT, 'migrations');
  const migrationsDir = resolve(target);
  const violations = await scanMigrationsDir(migrationsDir);
  if (violations.length > 0) {
    for (const v of violations) {
      console.error(`Migration security violation: ${v.file}: ${v.message}`);
      if (v.statement) {
        console.error(`  offending statement: ${v.statement.split('\n').join(' ').slice(0, 300)}`);
      }
    }
    return 1;
  }
  console.log(`Migration security check passed [${migrationsDir}] — no CASCADE drops without approval, RLS template present.`);
  return 0;
}

const isMain =
  import.meta.url === `file://${process.argv[1] ?? ''}` || (process.argv[1]?.endsWith('check-migrations.ts') ?? false);
if (isMain) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(`Migration guard failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
