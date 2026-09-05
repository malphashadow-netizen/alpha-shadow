/* eslint-disable preserve-caught-error, @typescript-eslint/no-unnecessary-type-assertion */
import type { QueryResult, QueryResultRow } from 'pg';

import { ValidationError } from '../../shared/errors.ts';
import { acquireDbClient } from './pool.ts';

export const TENANT_ID_SETTING = 'app.current_tenant_id';

// UUID with version nibble 1..8 and variant nibble 8/9/a/b (case-insensitive)
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

export type TenantId = string & { readonly __brand: 'TenantId' };

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

export type WithTenantContext = <T>(tenantId: string, fn: (q: TenantQuery) => Promise<T>) => Promise<T>;

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

async function discardAndRelease(client: TenantClient, originalError: unknown): Promise<never> {
  try {
    await client.query('DISCARD ALL');
    client.release();
  } catch (discardError) {
    const de = asError(discardError);
    client.release(de);
    throw new AggregateError([asError(originalError), de], 'DISCARD ALL failed after operation');
  }
  throw asError(originalError);
}

async function discardAndDestroy(client: TenantClient, originalError: unknown): Promise<never> {
  try {
    await client.query('DISCARD ALL');
  } catch (discardError) {
    const de = asError(discardError);
    client.release(de);
    if (originalError instanceof AggregateError) {
      const inner = (originalError as AggregateError).errors;
      throw new AggregateError([...(inner as unknown[]).map((e) => asError(e)), de], 'DISCARD ALL failed after rollback failure');
    }
    throw new AggregateError([asError(originalError), de], 'DISCARD ALL failed after rollback failure');
  }
  client.release(asError(originalError));
  throw asError(originalError);
}

export function createWithTenantContext(pool: TenantPool): WithTenantContext {
  return async function withTenantContext<T>(tenantId: string, fn: (q: TenantQuery) => Promise<T>): Promise<T> {
    const validTenantId = assertTenantId(tenantId);

    const client = await pool.connect();

    try {
      await client.query('BEGIN');
    } catch (beginError) {
      try {
        await client.query('DISCARD ALL');
        client.release();
      } catch (discardError) {
        const de = asError(discardError);
        client.release(de);
        throw new AggregateError([asError(beginError), de], 'BEGIN failed and DISCARD ALL also failed');
      }
      throw asError(beginError);
    }

    let operationError: unknown = null;
    let result: T | undefined;

    try {
      await client.query('SELECT set_config($1, $2, true)', [TENANT_ID_SETTING, validTenantId]);

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
          await client.query('DISCARD ALL');
          client.release();
        } catch (discardError) {
          const de = asError(discardError);
          client.release(de);
          throw new AggregateError([asError(operationError), de], 'ROLLBACK succeeded but DISCARD ALL failed');
        }
        throw asError(operationError);
      } else {
        const agg = new AggregateError([asError(operationError), asError(rollbackError)], 'Operation failed and ROLLBACK also failed');
        try {
          await client.query('DISCARD ALL');
        } catch (discardError) {
          const de = asError(discardError);
          client.release(de);
          throw new AggregateError(
            [asError(operationError), asError(rollbackError), de],
            'Operation, ROLLBACK and DISCARD ALL all failed',
          );
        }
        client.release(asError(agg));
        throw agg;
      }
    }

    try {
      await client.query('DISCARD ALL');
      client.release();
    } catch (discardError) {
      const de = asError(discardError);
      client.release(de);
      throw de;
    }

    return result as T;
  };
}

export const withTenantContext: WithTenantContext = (tenantId, fn) =>
  createWithTenantContext({ connect: () => acquireDbClient() as unknown as Promise<TenantClient> })(tenantId, fn);

export const __testing = {
  discardAndRelease,
  discardAndDestroy,
  asError,
  UUID_PATTERN,
};
