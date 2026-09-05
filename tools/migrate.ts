#!/usr/bin/env node
/**
 * tools/migrate.ts — applies SQL migrations in `migrations/` to the database.
 *
 * This file is the ONLY tool allowed to import `pg` directly (along with
 * src/infrastructure/db/pool.ts and src/infrastructure/db/tenant-context.ts).
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const MIGRATIONS_DIR = join(REPO_ROOT, 'migrations');

async function getMigrationFiles(): Promise<string[]> {
  const entries = await readdir(MIGRATIONS_DIR, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.sql'))
    .map((e) => e.name)
    .sort();
}

async function migrate(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL'];
  if (typeof databaseUrl !== 'string' || databaseUrl.trim() === '') {
    console.error('DATABASE_URL is not set; refusing to migrate.');
    process.exit(1);
  }

  const migrationUrl = process.env['MIGRATION_DATABASE_URL'] ?? databaseUrl;

  const client = new pg.Client({ connectionString: migrationUrl });

  try {
    await client.connect();

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      );
    `);

    const files = await getMigrationFiles();
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

export { migrate, getMigrationFiles };
