/* eslint-disable preserve-caught-error */
import type { QueryResult, QueryResultRow } from 'pg';

import { NotFoundError, TenantSuspendedError, ValidationError } from '../../shared/errors.ts';
import { acquireDbClient } from './pool.ts';
import { mapPostgresError } from './postgres-errors.ts';

export const TENANT_ID_SETTING = 'app.current_tenant_id';
export const STATEMENT_TIMEOUT_SETTING = 'statement_timeout';
export const LOCK_TIMEOUT_SETTING = 'lock_timeout';

/**
 * Default per-operation statement timeout (30s) applied by the PRODUCTION
 * `withTenantContext`. It is implemented as a transaction-scoped
 * `set_config('statement_timeout', …)` so PostgreSQL itself kills a runaway
 * query and frees the pooled connection — protecting the pool from exhaustion.
 * Tests that assert exact SQL sequences call `createWithTenantContext`
 * without options and therefore do not see this extra statement.
 */
export const DEFAULT_STATEMENT_TIMEOUT_MS = 30_000;

/**
 * B3: default per-transaction lock timeout (5s) applied by the PRODUCTION
 * `withTenantContext` (transaction-scoped `set_config('lock_timeout', …)`).
 * Honest transactions finish in milliseconds, so a 5s lock wait means real
 * pile-up: PostgreSQL aborts the waiter with 55P03, which mapPostgresError
 * turns into the retryable 503 — bounded waits, never a stuck pool slot.
 * Genuine deadlocks still surface as 40P01 (the detector runs at ~1s, well
 * under this bound), and REPEATABLE READ losers as 40001 — all three retry.
 */
export const DEFAULT_LOCK_TIMEOUT_MS = 5_000;

// UUID with version nibble 1..8 and variant nibble 8/9/a/b (case-insensitive)
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

export type TenantId = string & { readonly __brand: 'TenantId' };

export interface TenantAuditEvent {
  readonly event: 'invalid_tenant_id';
  readonly rawTenantId: string;
  readonly reason: string;
  readonly at: string;
}

/**
 * Security audit sink for anomalous tenant-context attempts (e.g. malformed
 * UUIDs). Injected per call by the composition root; the production default is
 * a no-op so the library itself never silently writes secrets — the DI layer
 * decides where audit events go (structured logger / audit table in Phase 4).
 */
export type TenantAuditLogger = (event: TenantAuditEvent) => void;

export interface WithTenantContextOptions {
  /** Chosen before any SELECT; tax/order work uses one consistent catalog view. */
  readonly isolationLevel?: 'read committed' | 'repeatable read' | 'serializable';
  /**
   * Alternative pool — the ONLY sanctioned way to swap the production pool at
   * runtime (e.g. tests, read replicas, multi-tenant pool routers). It is
   * structurally a `TenantPool` (connect → TenantClient), never a raw `pg.Pool`,
   * so the transaction lifecycle still belongs to this module.
   */
  readonly pool?: TenantPool | undefined;
  /** When true, verifies the tenant row exists in public.tenants AND its status is 'active' before fn runs (B5: suspended → TenantSuspendedError). */
  readonly verifyTenantExists?: boolean | undefined;
  /** PostgreSQL statement_timeout (ms). undefined = inherit server default. */
  readonly statementTimeoutMs?: number | undefined;
  /** B3: PostgreSQL lock_timeout (ms). undefined = inherit server default. */
  readonly lockTimeoutMs?: number | undefined;
  /** Audit sink for invalid tenant-id attempts (default: no-op). */
  readonly audit?: TenantAuditLogger | undefined;
}

export function assertTenantId(value: string): TenantId {
  if (value.toLowerCase() === NIL_UUID) {
    throw new ValidationError('tenantId must not be nil UUID', 'tenantId');
  }
  if (!UUID_PATTERN.test(value)) {
    throw new ValidationError('tenantId must be a UUID v1..8 with variant 8/9/a/b', 'tenantId');
  }
  return value.toLowerCase() as TenantId;
}

export interface TenantQuery {
  query<R extends QueryResultRow = QueryResultRow>(text: string, values?: readonly unknown[]): Promise<QueryResult<R>>;
}

export interface TenantClient {
  query<R extends QueryResultRow = QueryResultRow>(text: string, values?: readonly unknown[]): Promise<QueryResult<R>>;
  release(destroyError?: Error | boolean): void;
}

export interface TenantPool {
  connect(): Promise<TenantClient>;
}

export type WithTenantContext = <T>(tenantId: string, fn: (q: TenantQuery) => Promise<T>, options?: WithTenantContextOptions) => Promise<T>;

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * The ONE discard/release primitive. Every teardown path goes through it:
 *   - DISCARD ALL succeeds → release with `releaseError` (undefined = clean).
 *   - DISCARD ALL fails    → release with the discard error (destroy the
 *     connection; it may be in an unknown state) and throw the discard error.
 * Callers are responsible for aggregating their own errors around this helper,
 * using exactly one try/catch per caller so the semantics stay auditable.
 */
async function discardAndRelease(client: TenantClient, releaseError?: Error): Promise<void> {
  try {
    await client.query('DISCARD ALL');
    client.release(releaseError);
  } catch (discardError) {
    const de = asError(discardError);
    client.release(de);
    throw de;
  }
}

function isEnabled(value: boolean | undefined): boolean {
  return value === true;
}

export function createWithTenantContext(pool: TenantPool, options: WithTenantContextOptions = {}): WithTenantContext {
  return async function withTenantContext<T>(
    tenantId: string,
    fn: (q: TenantQuery) => Promise<T>,
    callOptions?: WithTenantContextOptions,
  ): Promise<T> {
    const effective: WithTenantContextOptions = { ...options, ...callOptions };
    const activePool = effective.pool ?? pool;
    const audit = effective.audit ?? (() => undefined);
    const verifyTenantExists = isEnabled(effective.verifyTenantExists);
    const statementTimeoutMs = effective.statementTimeoutMs;
    const lockTimeoutMs = effective.lockTimeoutMs;
    const beginSql = effective.isolationLevel === undefined ? 'BEGIN' : {
      'read committed': 'BEGIN ISOLATION LEVEL READ COMMITTED',
      'repeatable read': 'BEGIN ISOLATION LEVEL REPEATABLE READ',
      serializable: 'BEGIN ISOLATION LEVEL SERIALIZABLE',
    }[effective.isolationLevel];
    if (typeof beginSql !== 'string') throw new ValidationError('Invalid transaction isolation level');

    // Validate BEFORE acquiring a connection: invalid tenant ids never touch
    // the pool, and every attempt is recorded as a security event.
    let validTenantId: TenantId;
    try {
      validTenantId = assertTenantId(tenantId);
    } catch (error) {
      audit({
        event: 'invalid_tenant_id',
        rawTenantId: tenantId,
        reason: error instanceof Error ? error.message : String(error),
        at: new Date().toISOString(),
      });
      throw error;
    }

    const client = await activePool.connect();

    try {
      await client.query(beginSql);
    } catch (beginError) {
      try {
        await discardAndRelease(client);
      } catch (discardError) {
        throw new AggregateError([asError(beginError), asError(discardError)], 'BEGIN failed and DISCARD ALL also failed');
      }
      throw asError(beginError);
    }

    let operationError: unknown = null;
    let result: T | undefined;

    try {
      if (statementTimeoutMs !== undefined) {
        await client.query('SELECT set_config($1, $2, true)', [STATEMENT_TIMEOUT_SETTING, String(statementTimeoutMs)]);
      }
      if (lockTimeoutMs !== undefined) {
        await client.query('SELECT set_config($1, $2, true)', [LOCK_TIMEOUT_SETTING, String(lockTimeoutMs)]);
      }
      // Transaction-scoped tenant binding (set_config(…, true) INSIDE the
      // explicit transaction = the same safety property as SET LOCAL, but
      // parameterized — never interpolate the tenant id into SQL).
      await client.query('SELECT set_config($1, $2, true)', [TENANT_ID_SETTING, validTenantId]);

      if (verifyTenantExists) {
        // B5: existence AND active status in ONE in-transaction probe. The
        // check is positive on 'active' (fail-closed): a suspended (or any
        // non-active) tenant fails every operation here with a distinct
        // 403. Login/refresh fold this into the uniform 401 at the engine
        // layer — the status must never leak through authentication.
        const tenantCheck = await client.query<{ status: string }>(
          'SELECT status FROM tenants WHERE id = $1',
          [validTenantId],
        );
        const tenantStatus = tenantCheck.rows[0]?.status;
        if (tenantStatus === undefined) {
          throw new NotFoundError(`Tenant "${validTenantId}" does not exist`);
        }
        if (tenantStatus !== 'active') {
          throw new TenantSuspendedError(tenantStatus);
        }
      }

      const tenantQuery: TenantQuery = Object.freeze({
        query: <R extends QueryResultRow>(text: string, values?: readonly unknown[]) => client.query<R>(text, values),
      });

      result = await fn(tenantQuery);

      await client.query('COMMIT');
    } catch (e) {
      operationError = e;
    }

    if (operationError !== null) {
      let rollbackError: unknown = null;
      try {
        await client.query('ROLLBACK');
      } catch (re) {
        rollbackError = re;
      }

      if (rollbackError === null) {
        try {
          await discardAndRelease(client);
        } catch (discardError) {
          throw new AggregateError([asError(operationError), asError(discardError)], 'ROLLBACK succeeded but DISCARD ALL failed');
        }
        // B3: concurrency-control deaths (40001/40P01/55P03) surface as the
        // retryable domain error; everything else passes through untouched.
        throw asError(mapPostgresError(operationError));
      }

      const agg = new AggregateError([asError(operationError), asError(rollbackError)], 'Operation failed and ROLLBACK also failed');
      try {
        await discardAndRelease(client, agg);
      } catch (discardError) {
        const de = asError(discardError);
        throw new AggregateError([asError(operationError), asError(rollbackError), de], 'Operation, ROLLBACK and DISCARD ALL all failed');
      }
      throw agg;
    }

    await discardAndRelease(client);

    return result as T;
  };
}

/**
 * Production pool adapter. `acquireDbClient()` already returns `pg.PoolClient`,
 * which is structurally compatible with `TenantClient` (query + release); we
 * keep the narrow `TenantPool` interface here so nothing outside this module
 * can observe raw pg types.
 */
const productionPool: TenantPool = {
  connect: async (): Promise<TenantClient> => acquireDbClient(),
};

const defaultOptions: WithTenantContextOptions = {
  verifyTenantExists: true,
  statementTimeoutMs: DEFAULT_STATEMENT_TIMEOUT_MS,
  lockTimeoutMs: DEFAULT_LOCK_TIMEOUT_MS,
};

const defaultWithTenantContext: WithTenantContext = createWithTenantContext(productionPool, defaultOptions);

/**
 * FINAL exported entry point — the only production way to run a query.
 *
 * Defaults (fail closed):
 *   - verifies the tenant row exists in `public.tenants` (throw NotFoundError)
 *     AND its status is 'active' (B5: throw TenantSuspendedError → 403)
 *   - applies a 30s statement timeout so a runaway query cannot hold the pool;
 *     PostgreSQL kills the statement, the code path then ROLLBACKs + DISCARDs.
 *   - applies a 5s lock timeout (B3) so a piled-up lock wait fails fast with
 *     the retryable 503 instead of holding its pool slot indefinitely.
 *   - audits every invalid tenant UUID attempt (inject `options.audit`).
 *
 * A replacement pool can be injected ONLY through `options.pool` (a
 * `TenantPool`), keeping the transaction lifecycle inside this module.
 */
export const withTenantContext: WithTenantContext = (tenantId, fn, callOptions) => {
  if (callOptions === undefined) {
    return defaultWithTenantContext(tenantId, fn);
  }
  return createWithTenantContext(productionPool, { ...defaultOptions, ...callOptions })(tenantId, fn);
};

export const __testing = {
  discardAndRelease,
  asError,
  UUID_PATTERN,
};
