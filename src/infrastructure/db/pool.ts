/**
 * Single PostgreSQL connection pool — lazy singleton.
 *
 * This module and tenant-context.ts are the ONLY files in src/ allowed to import `pg` directly.
 * Every query therefore has exactly one way in: withTenantContext().
 *
 * Fail-closed configuration:
 *   - DATABASE_URL missing/empty → ConfigurationError
 *   - DATABASE_URL === MIGRATION_DATABASE_URL → ConfigurationError (app must not run as owner)
 *
 * Money safety: int8 and numeric are delivered as strings, never as number.
 */

import pg from 'pg';

import { ConfigurationError } from '../../shared/errors.ts';

export const DATABASE_URL_KEY = 'DATABASE_URL';
export const MIGRATION_DATABASE_URL_KEY = 'MIGRATION_DATABASE_URL';

export interface PoolEnvironment {
  readonly [DATABASE_URL_KEY]?: string | undefined;
  readonly [MIGRATION_DATABASE_URL_KEY]?: string | undefined;
}

export function resolveDatabaseUrl(env: PoolEnvironment): string {
  const url = env[DATABASE_URL_KEY];
  if (typeof url !== 'string' || url.trim() === '') {
    throw new ConfigurationError(`${DATABASE_URL_KEY} is not set; refusing to start without a database.`, DATABASE_URL_KEY);
  }
  const migrationUrl = env[MIGRATION_DATABASE_URL_KEY];
  if (typeof migrationUrl === 'string' && migrationUrl.trim() !== '' && migrationUrl.trim() === url.trim()) {
    throw new ConfigurationError(
      `${DATABASE_URL_KEY} must not equal ${MIGRATION_DATABASE_URL_KEY}: the application must not run as the schema owner.`,
      DATABASE_URL_KEY,
    );
  }
  return url.trim();
}

const asText = (value: string): string => value;

export function configureTypeParsers(types: typeof pg.types = pg.types): void {
  types.setTypeParser(types.builtins.INT8, asText);
  types.setTypeParser(types.builtins.NUMERIC, asText);
}

export interface PoolOptions {
  readonly connectionString: string;
  readonly max?: number;
  readonly connectionTimeoutMillis?: number;
  readonly idleTimeoutMillis?: number;
}

export function createPool(options: PoolOptions): pg.Pool {
  configureTypeParsers();
  return new pg.Pool({
    connectionString: options.connectionString,
    max: options.max ?? 10,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 10_000,
    idleTimeoutMillis: options.idleTimeoutMillis ?? 30_000,
    allowExitOnIdle: false,
  });
}

let sharedPool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  if (sharedPool) return sharedPool;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
  sharedPool = createPool({ connectionString: resolveDatabaseUrl(process.env as PoolEnvironment) });
  return sharedPool;
}

export async function acquireDbClient(): Promise<pg.PoolClient> {
  const pool = getPool();
  const client = await pool.connect();
  return client;
}

export async function closePool(): Promise<void> {
  const pool = sharedPool;
  sharedPool = undefined;
  if (pool) {
    await pool.end();
  }
}

// For testing: allow injecting a fake pool
export function __setPoolForTesting(pool: pg.Pool | undefined): void {
  sharedPool = pool;
}
