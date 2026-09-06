/**
 * Single PostgreSQL connection pool — lazy singleton.
 *
 * This module and tenant-context.ts are the ONLY files in src/ allowed to import `pg` directly
 * (see `eslint-rules/pg-import-policy.ts` — the single source of truth for the allow-list).
 * Every query therefore has exactly one way in: withTenantContext().
 *
 * Fail-closed configuration:
 *   - DATABASE_URL missing/empty → ConfigurationError
 *   - DATABASE_URL is not a valid postgres:// | postgresql:// URL → ConfigurationError
 *   - DATABASE_URL === MIGRATION_DATABASE_URL (compared AFTER URL normalisation,
 *     not by raw string) → ConfigurationError (app must not run as owner)
 *   - DATABASE_URL is a known default superuser URL (postgres:postgres@…) → ConfigurationError
 *   - In production (NODE_ENV=production) the URL MUST carry `sslmode=require`,
 *     `sslmode=verify-ca` or `sslmode=verify-full`, and the pool connects with
 *     `ssl: { rejectUnauthorized: true }`. Boot refuses to start otherwise.
 *
 * Pool capacity:
 *   - `max` is computed from `DATABASE_MAX_CONNECTIONS`, `APP_INSTANCES` and a
 *     safety headroom so that `instances × max` never exhausts the server's
 *     max_connections:
 *
 *         max = max(1, floor((DATABASE_MAX_CONNECTIONS - 5) / APP_INSTANCES))
 *
 *     Defaults: DATABASE_MAX_CONNECTIONS=100, APP_INSTANCES=1, headroom=5.
 *     The formula is documented in docs/backlog.md (pool capacity) and tested
 *     by test/unit/infrastructure/pool.test.ts.
 *
 * Money safety: int8 and numeric are delivered as strings, never as number.
 */

import pg from 'pg';
import type { ConnectionOptions } from 'node:tls';

import { ConfigurationError } from '../../shared/errors.ts';

export const DATABASE_URL_KEY = 'DATABASE_URL';
export const MIGRATION_DATABASE_URL_KEY = 'MIGRATION_DATABASE_URL';
export const DATABASE_MAX_CONNECTIONS_KEY = 'DATABASE_MAX_CONNECTIONS';
export const APP_INSTANCES_KEY = 'APP_INSTANCES';

export const DEFAULT_DATABASE_MAX_CONNECTIONS = 100;
export const DEFAULT_APP_INSTANCES = 1;
export const DEFAULT_CONNECTION_HEADROOM = 5;
export const DEFAULT_POOL_MAX = 10;
export const PRODUCTION_ENV = 'production';

export interface PoolEnvironment {
  readonly [DATABASE_URL_KEY]?: string | undefined;
  readonly [MIGRATION_DATABASE_URL_KEY]?: string | undefined;
  readonly [DATABASE_MAX_CONNECTIONS_KEY]?: string | undefined;
  readonly [APP_INSTANCES_KEY]?: string | undefined;
  readonly NODE_ENV?: string | undefined;
}

/**
 * Default superuser DSNs that must never be used by the app (fail closed).
 * Comparison is done on normalised URL fields, so whitespace, scheme variants
 * and reordered query parameters cannot smuggle one past the guard.
 */
const DEFAULT_SUPERUSER_URLS: readonly string[] = [
  'postgresql://postgres:postgres@localhost:5432/postgres',
  'postgresql://postgres:postgres@127.0.0.1:5432/postgres',
  'postgresql://postgres:postgres@[::1]:5432/postgres',
  'postgresql://postgres@localhost:5432/postgres',
  'postgresql://postgres@127.0.0.1:5432/postgres',
  'postgresql://postgres@[::1]:5432/postgres',
  'postgresql://postgres:postgres@localhost/postgres',
  'postgresql://postgres:postgres@127.0.0.1/postgres',
];

function parseDatabaseUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigurationError(`${DATABASE_URL_KEY} is not a valid database URL: "${raw}"`, DATABASE_URL_KEY);
  }
  const protocol = url.protocol.toLowerCase();
  if (protocol !== 'postgres:' && protocol !== 'postgresql:') {
    throw new ConfigurationError(
      `${DATABASE_URL_KEY} must use the postgres:// or postgresql:// protocol (got "${url.protocol}")`,
      DATABASE_URL_KEY,
    );
  }
  if (url.hostname === '') {
    throw new ConfigurationError(`${DATABASE_URL_KEY} must include a host name`, DATABASE_URL_KEY);
  }
  return url;
}

/** Canonical, order-insensitive representation used for security comparisons. */
export function normaliseDatabaseUrl(raw: string): URL {
  const url = parseDatabaseUrl(raw);
  return url;
}

function sameDatabaseUrl(leftRaw: string, rightRaw: string): boolean {
  const left = parseDatabaseUrl(leftRaw);
  const right = parseDatabaseUrl(rightRaw);

  const protocol = (u: URL): string => {
    const p = u.protocol.toLowerCase().replace(/:$/, '');
    return p === 'postgres' ? 'postgresql' : p;
  };
  const port = (u: URL): string => (u.port === '' ? '5432' : u.port);
  const search = (u: URL): string =>
    [...u.searchParams.entries()]
      .map(([k, v]) => `${k}=${v}`)
      .sort()
      .join('&');

  return (
    protocol(left) === protocol(right) &&
    left.username.toLowerCase() === right.username.toLowerCase() &&
    left.password === right.password &&
    left.hostname.toLowerCase() === right.hostname.toLowerCase() &&
    port(left) === port(right) &&
    left.pathname === right.pathname &&
    search(left) === search(right)
  );
}

function assertNotDefaultSuperuser(url: string): void {
  for (const candidate of DEFAULT_SUPERUSER_URLS) {
    if (sameDatabaseUrl(url, candidate)) {
      throw new ConfigurationError(
        `${DATABASE_URL_KEY} points at the default postgres superuser URL ("${url}"); use a least-privilege application role.`,
        DATABASE_URL_KEY,
      );
    }
  }
}

function isProduction(env: PoolEnvironment): boolean {
  return env.NODE_ENV?.trim() === PRODUCTION_ENV;
}

/** Values from the environment that feed the pool capacity formula. */
export interface PoolCapacity {
  readonly maxConnections: number;
  readonly appInstances: number;
  readonly safetyHeadroom: number;
}

export function readPoolCapacity(env: PoolEnvironment): PoolCapacity {
  const parsePositiveInt = (value: string | undefined, fallback: number, key: string): number => {
    if (value === undefined || value.trim() === '') return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new ConfigurationError(`${key} must be a positive integer (got "${value}")`, key);
    }
    return parsed;
  };
  return {
    maxConnections: parsePositiveInt(env[DATABASE_MAX_CONNECTIONS_KEY], DEFAULT_DATABASE_MAX_CONNECTIONS, DATABASE_MAX_CONNECTIONS_KEY),
    appInstances: parsePositiveInt(env[APP_INSTANCES_KEY], DEFAULT_APP_INSTANCES, APP_INSTANCES_KEY),
    safetyHeadroom: DEFAULT_CONNECTION_HEADROOM,
  };
}

/**
 * max = max(1, floor((maxConnections - headroom) / appInstances))
 */
export function computePoolMax(maxConnections: number, appInstances: number, safetyHeadroom: number = DEFAULT_CONNECTION_HEADROOM): number {
  if (!Number.isInteger(maxConnections) || maxConnections <= 0) {
    throw new ConfigurationError('maxConnections must be a positive integer', DATABASE_MAX_CONNECTIONS_KEY);
  }
  if (!Number.isInteger(appInstances) || appInstances <= 0) {
    throw new ConfigurationError('appInstances must be a positive integer', APP_INSTANCES_KEY);
  }
  const usable = Math.max(1, maxConnections - safetyHeadroom);
  return Math.max(1, Math.floor(usable / appInstances));
}

export function resolveDatabaseUrl(env: PoolEnvironment): string {
  const raw = env[DATABASE_URL_KEY];
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new ConfigurationError(`${DATABASE_URL_KEY} is not set; refusing to start without a database.`, DATABASE_URL_KEY);
  }
  const url = raw.trim();
  parseDatabaseUrl(url); // structural/protocol validation at boot
  assertNotDefaultSuperuser(url);
  const migrationUrl = env[MIGRATION_DATABASE_URL_KEY];
  if (typeof migrationUrl === 'string' && migrationUrl.trim() !== '' && sameDatabaseUrl(url, migrationUrl.trim())) {
    throw new ConfigurationError(
      `${DATABASE_URL_KEY} must not equal ${MIGRATION_DATABASE_URL_KEY}: the application must not run as the schema owner.`,
      DATABASE_URL_KEY,
    );
  }
  return url;
}

export interface PoolOptions {
  readonly connectionString: string;
  readonly max?: number;
  readonly connectionTimeoutMillis?: number;
  readonly idleTimeoutMillis?: number;
  readonly ssl?: boolean | ConnectionOptions | undefined;
}

/**
 * Resolves the complete production-safe pool options from the environment.
 * Called at boot (getPool/acquireDbClient) — NOT by `createPool` directly, so
 * unit tests can build throw-away pools without NODE_ENV=production.
 */
export function resolvePoolOptions(env: PoolEnvironment, overrides: { readonly max?: number } = {}): PoolOptions {
  const connectionString = resolveDatabaseUrl(env);
  assertNotDefaultSuperuser(connectionString);
  const { maxConnections, appInstances } = readPoolCapacity(env);

  if (isProduction(env)) {
    const parsed = parseDatabaseUrl(connectionString);
    const sslMode = parsed.searchParams.get('sslmode')?.toLowerCase() ?? '';
    const allowed = new Set(['require', 'verify-ca', 'verify-full']);
    if (!allowed.has(sslMode)) {
      throw new ConfigurationError(
        `${DATABASE_URL_KEY} must declare sslmode=require, sslmode=verify-ca or sslmode=verify-full when NODE_ENV=${PRODUCTION_ENV}; refusing to boot with an unencrypted or unverified connection.`,
        DATABASE_URL_KEY,
      );
    }
    return {
      connectionString,
      max: overrides.max ?? computePoolMax(maxConnections, appInstances),
      ssl: { rejectUnauthorized: true },
    };
  }

  return {
    connectionString,
    max: overrides.max ?? computePoolMax(maxConnections, appInstances),
  };
}

export function configureTypeParsers(types: typeof pg.types = pg.types): void {
  // int8 + numeric arrive as strings from PostgreSQL. The parser is the
  // identity function on purpose (see "asText" note in docs/backlog.md): the
  // value must stay a text representation so `minorUnitsFromDb`/BigInt does
  // the exact conversion — never pass it through a JS number.
  types.setTypeParser(types.builtins.INT8, (value: string): string => value);
  types.setTypeParser(types.builtins.NUMERIC, (value: string): string => value);
}

export function createPool(options: PoolOptions): pg.Pool {
  configureTypeParsers();
  const base: pg.PoolConfig = {
    connectionString: options.connectionString,
    max: options.max ?? DEFAULT_POOL_MAX,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 10_000,
    idleTimeoutMillis: options.idleTimeoutMillis ?? 30_000,
    allowExitOnIdle: false,
  };
  const config: pg.PoolConfig = options.ssl === undefined ? base : { ...base, ssl: options.ssl };
  return new pg.Pool(config);
}

let sharedPool: pg.Pool | undefined;
/**
 * Lazy-promise lock for shared pool creation — the ONLY path to the pool.
 *
 * `createSharedPool` is deliberately invoked through a memoised promise
 * (`sharedPoolPromise ??= …`), so:
 *   - concurrent callers can never create two pools (creation runs once);
 *   - a creation failure rejects the ONE memoised promise and therefore
 *     surfaces to EVERY consumer (`getPool()` and `acquireDbClient()`), with
 *     no swallowed/ignored rejection and no silent second code path.
 * There is intentionally no synchronous `getPool()` variant: the singleton
 * needs environment resolution that can fail, and every failure must be
 * observable by every caller.
 */
let sharedPoolPromise: Promise<pg.Pool> | undefined;

function createSharedPool(): pg.Pool {
  const pool = createPool(resolvePoolOptions(process.env));
  sharedPool = pool;
  return pool;
}

export function ensureSharedPool(): Promise<pg.Pool> {
  // A sync throw inside `.then` becomes a rejection of the memoised promise,
  // so this single code path reports failures to every consumer.
  sharedPoolPromise ??= Promise.resolve().then(createSharedPool);
  return sharedPoolPromise;
}

export async function getPool(): Promise<pg.Pool> {
  return ensureSharedPool();
}

export async function acquireDbClient(): Promise<pg.PoolClient> {
  const pool = await getPool();
  const client = await pool.connect();
  return client;
}

export async function closePool(): Promise<void> {
  const pool = sharedPool;
  sharedPool = undefined;
  sharedPoolPromise = undefined;
  if (pool) {
    await pool.end();
  }
}

// For testing: allow injecting a fake pool
export function __setPoolForTesting(pool: pg.Pool | undefined): void {
  sharedPool = pool;
  sharedPoolPromise = undefined;
}
