#!/usr/bin/env node
/**
 * tools/migrate.ts — applies SQL migrations in `migrations/` to the database.
 *
 * This file is the ONLY tool allowed to import `pg` directly (along with
 * src/infrastructure/db/pool.ts and src/infrastructure/db/tenant-context.ts —
 * see eslint-rules/pg-import-policy.ts).
 *
 * Fail-closed security (enforced by tools/lib/migrate-env.ts, unit-tested):
 *   - MIGRATION_DATABASE_URL is REQUIRED and used exclusively. There is NO
 *     fallback to DATABASE_URL: the app connection string must never be used
 *     for schema changes (the app role must not be the schema owner).
 *   - SEED_TEST_DATA=true is refused: test/probe tenants live in
 *     test/support/seed.test.sql and are applied ONLY by the Vitest harness.
 *     This file performs zero data seeding.
 *   - The URL must be a valid postgres:// | postgresql:// URL.
 *   - Before any statement runs, every migration is checked by the migration
 *     security guard (tools/lib/migration-security.ts): no unapproved
 *     DROP … CASCADE, mandatory RLS template. A violation aborts the run.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import { assertMigrationUrl, assertMigrationEnvironment, MIGRATION_DATABASE_URL_KEY } from './lib/migrate-env.ts';
import { checkMigrationFile, parseApprovals } from './lib/migration-security.ts';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const MIGRATIONS_DIR = join(REPO_ROOT, 'migrations');

async function getMigrationFiles(): Promise<string[]> {
  const entries = await readdir(MIGRATIONS_DIR, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.sql'))
    .map((e) => e.name)
    .sort();
}

async function assertMigrationsAreSecure(files: string[]): Promise<void> {
  let approvals: Record<string, string> = {};
  try {
    const raw = await readFile(join(MIGRATIONS_DIR, '.cascade-approvals.json'), 'utf8');
    approvals = parseApprovals(raw).approvals;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw error;
  }

  for (const file of files) {
    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
    const violations = checkMigrationFile({ fileName: file, sql, approvals });
    if (violations.length > 0) {
      const messages = violations.map((v) => `${v.file}: ${v.message}`).join('; ');
      throw new Error(`Migration security guard rejected the run: ${messages}`);
    }
  }
}

async function migrate(): Promise<void> {
  // Single environment decision point — throws (never process.exit) so the
  // CLI catch below and any programmatic caller share the exact same error.
  const migrationUrl = assertMigrationEnvironment(process.env);

  const files = await getMigrationFiles();
  await assertMigrationsAreSecure(files);

  const client = new pg.Client({ connectionString: migrationUrl });

  try {
    await client.connect();

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      );
    `);

    const applied = await client.query<{ filename: string }>('SELECT filename FROM schema_migrations ORDER BY filename');
    const appliedSet = new Set(applied.rows.map((r) => r.filename));

    for (const file of files) {
      if (appliedSet.has(file)) {
        console.log(`Skipping already applied: ${file}`);
        continue;
      }
      const fullPath = join(MIGRATIONS_DIR, file);
      const sql = await readFile(fullPath, 'utf8');
      console.log(`Applying migration: ${file}`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`Applied: ${file}`);
      } catch (err: unknown) {
        await client.query('ROLLBACK');
        console.error(`Failed to apply ${file}:`, err);
        throw err;
      }
    }

    console.log('Migrations complete.');
  } finally {
    await client.end();
  }
}

const isMain = import.meta.url === `file://${process.argv[1] ?? ''}` || (process.argv[1]?.endsWith('migrate.ts') ?? false);
if (isMain) {
  migrate().catch((err: unknown) => {
    console.error(`Migration failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}

export { migrate, getMigrationFiles, assertMigrationUrl, assertMigrationEnvironment, MIGRATION_DATABASE_URL_KEY };
