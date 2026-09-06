/**
 * Migration environment guard — the ONLY place the migration tooling decides
 * which environment it may run in. Pure (no pg import) so it is unit-testable:
 *
 *   1. MIGRATION_DATABASE_URL is REQUIRED and used exclusively; there is NO
 *      fallback to DATABASE_URL (the app connection string must never run
 *      schema changes — the app role must not be the schema owner).
 *   2. SEED_TEST_DATA=true is refused unconditionally: test/probe seed data
 *      belongs to test/support/seed.test.sql and is applied ONLY by the
 *      Vitest harness. `npm run migrate` must never seed a database.
 *   3. The URL must be a valid postgres:// | postgresql:// URL with a host.
 */
export const MIGRATION_DATABASE_URL_KEY = 'MIGRATION_DATABASE_URL';
export const SEED_TEST_DATA_KEY = 'SEED_TEST_DATA';

export interface MigrateEnvironment {
  readonly [MIGRATION_DATABASE_URL_KEY]?: string | undefined;
  readonly [SEED_TEST_DATA_KEY]?: string | undefined;
  readonly NODE_ENV?: string | undefined;
}

export function assertMigrationUrl(raw: string): string {
  const url = raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('MIGRATION_DATABASE_URL is not a valid URL (postgres:// or postgresql:// expected)');
  }
  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== 'postgresql:' && protocol !== 'postgres:') {
    throw new Error(`MIGRATION_DATABASE_URL must use postgres:// or postgresql:// (got "${parsed.protocol}")`);
  }
  if (parsed.hostname === '') {
    throw new Error('MIGRATION_DATABASE_URL must include a host');
  }
  return url;
}

function isTruthyEnv(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/**
 * Returns the validated MIGRATION_DATABASE_URL, or throws:
 *   - if the variable is missing/empty (never falls back to DATABASE_URL);
 *   - if SEED_TEST_DATA is truthy (test seed must never reach a migrate run,
 *     in production or anywhere else);
 *   - if the URL does not parse as a postgres/PostgreSQL URL.
 */
export function assertMigrationEnvironment(env: MigrateEnvironment): string {
  if (isTruthyEnv(env[SEED_TEST_DATA_KEY])) {
    throw new Error(
      `${SEED_TEST_DATA_KEY} is set to a truthy value — test seed data is applied only by the test harness ` +
        `(test/support/seed.test.sql), never by tools/migrate.ts. Refusing to migrate.`,
    );
  }

  const raw = env[MIGRATION_DATABASE_URL_KEY];
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error(
      `${MIGRATION_DATABASE_URL_KEY} is not set; refusing to migrate (${MIGRATION_DATABASE_URL_KEY} is used exclusively — DATABASE_URL is never used for schema changes).`,
    );
  }
  return assertMigrationUrl(raw);
}
