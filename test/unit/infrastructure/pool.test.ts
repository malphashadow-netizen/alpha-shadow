import { describe, expect, it, vi } from 'vitest';

import { ConfigurationError } from '../../../src/shared/errors.ts';
import {
  acquireDbClient,
  computePoolMax,
  configureTypeParsers,
  createPool,
  ensureSharedPool,
  readPoolCapacity,
  resolveDatabaseUrl,
  resolvePoolOptions,
  closePool,
  getPool,
  __setPoolForTesting,
} from '../../../src/infrastructure/db/pool.ts';
import pg from 'pg';

describe('infrastructure/pool — resolveDatabaseUrl', () => {
  it('throws when DATABASE_URL missing', () => {
    expect(() => resolveDatabaseUrl({})).toThrow(ConfigurationError);
    expect(() => resolveDatabaseUrl({ DATABASE_URL: '' })).toThrow(ConfigurationError);
    expect(() => resolveDatabaseUrl({ DATABASE_URL: '   ' })).toThrow(ConfigurationError);
  });

  it('throws when DATABASE_URL equals MIGRATION_DATABASE_URL', () => {
    const url = 'postgresql://user:pass@localhost/db';
    expect(() => resolveDatabaseUrl({ DATABASE_URL: url, MIGRATION_DATABASE_URL: url })).toThrow(ConfigurationError);
    expect(() => resolveDatabaseUrl({ DATABASE_URL: ` ${url} `, MIGRATION_DATABASE_URL: url })).toThrow(ConfigurationError);
  });

  it('returns trimmed URL when valid and different', () => {
    expect(resolveDatabaseUrl({ DATABASE_URL: ' postgres://a ', MIGRATION_DATABASE_URL: 'postgres://b' })).toBe('postgres://a');
  });

  it('allows missing MIGRATION_DATABASE_URL', () => {
    expect(resolveDatabaseUrl({ DATABASE_URL: 'postgres://a' })).toBe('postgres://a');
  });

  it('allows different MIGRATION_DATABASE_URL', () => {
    expect(resolveDatabaseUrl({ DATABASE_URL: 'postgres://a', MIGRATION_DATABASE_URL: 'postgres://b' })).toBe('postgres://a');
  });
});

describe('infrastructure/pool — configureTypeParsers and createPool', () => {
  it('configureTypeParsers sets int8 and numeric to text', () => {
    const mockTypes = {
      builtins: { INT8: 20, NUMERIC: 1700 },
      setTypeParser: vi.fn(),
    } as unknown as typeof pg.types;
    configureTypeParsers(mockTypes);
    expect(mockTypes.setTypeParser).toHaveBeenCalledTimes(2);
    expect(mockTypes.setTypeParser).toHaveBeenCalledWith(20, expect.any(Function));
    expect(mockTypes.setTypeParser).toHaveBeenCalledWith(1700, expect.any(Function));
  });

  it('createPool configures parsers and creates pool', () => {
    const pool = createPool({ connectionString: 'postgresql://test' });
    expect(pool).toBeDefined();
    expect(pool).toBeInstanceOf(pg.Pool);
    pool.end().catch(() => undefined);
  });

  it('createPool respects custom options', () => {
    const pool = createPool({ connectionString: 'postgresql://test', max: 5 });
    expect(pool).toBeDefined();
    pool.end().catch(() => undefined);
  });

  it('closePool clears singleton without error when no pool', async () => {
    __setPoolForTesting(undefined);
    await expect(closePool()).resolves.toBeUndefined();
  });

  it('getPool is lazy singleton', async () => {
    __setPoolForTesting(undefined);
    const original = process.env['DATABASE_URL'];
    process.env['DATABASE_URL'] = 'postgresql://lazy-test';
    const { getPool } = await import('../../../src/infrastructure/db/pool.ts');
    const p1 = await getPool();
    const p2 = await getPool();
    expect(p1).toBe(p2);
    await closePool();
    process.env['DATABASE_URL'] = original;
  });

  it('pool is not created at import time', async () => {
    __setPoolForTesting(undefined);
    const original = process.env['DATABASE_URL'];
    delete process.env['DATABASE_URL'];
    // Import should not throw
    await expect(import('../../../src/infrastructure/db/pool.ts')).resolves.toBeDefined();
    const { getPool: gp } = await import('../../../src/infrastructure/db/pool.ts');
    await expect(gp()).rejects.toThrow(ConfigurationError);
    process.env['DATABASE_URL'] = original;
    __setPoolForTesting(undefined);
  });
});

describe('infrastructure/pool — capacity formula (instances → max, max_connections safe)', () => {
  it('computePoolMax reserves headroom and divides by instance count', () => {
    expect(computePoolMax(100, 1)).toBe(95);
    expect(computePoolMax(100, 4)).toBe(23);
    expect(computePoolMax(50, 2, 10)).toBe(20);
    // Never below 1.
    expect(computePoolMax(3, 10)).toBe(1);
  });

  it('readPoolCapacity reads env with fail-closed defaults', () => {
    expect(readPoolCapacity({})).toEqual({ maxConnections: 100, appInstances: 1, safetyHeadroom: 5 });
    expect(readPoolCapacity({ DATABASE_MAX_CONNECTIONS: '200', APP_INSTANCES: '8' })).toEqual({
      maxConnections: 200,
      appInstances: 8,
      safetyHeadroom: 5,
    });
    expect(() => readPoolCapacity({ DATABASE_MAX_CONNECTIONS: 'abc' })).toThrow(ConfigurationError);
    expect(() => readPoolCapacity({ APP_INSTANCES: '0' })).toThrow(ConfigurationError);
  });

  it('resolvePoolOptions computes max from the capacity env', () => {
    const options = resolvePoolOptions({ DATABASE_URL: 'postgres://a', DATABASE_MAX_CONNECTIONS: '200', APP_INSTANCES: '4' });
    expect(options.max).toBe(48);
  });
});

describe('infrastructure/pool — URL parsing, normalisation and production SSL', () => {
  const baseEnv = { DATABASE_URL: 'postgresql://app:pw@db.example.com:5432/app', NODE_ENV: 'production' };

  it('refuses non-postgres protocols', () => {
    expect(() => resolveDatabaseUrl({ DATABASE_URL: 'http://example.com/db' })).toThrow(ConfigurationError);
    expect(() => resolveDatabaseUrl({ DATABASE_URL: 'not a url' })).toThrow(ConfigurationError);
  });

  it('equality check is URL-normalised, not raw-text (query order / scheme do not bypass it)', () => {
    const a = 'postgresql://user:pass@localhost/db?a=1&b=2';
    const b = 'postgres://user:pass@localhost:5432/db?b=2&a=1';
    expect(() => resolveDatabaseUrl({ DATABASE_URL: a, MIGRATION_DATABASE_URL: b })).toThrow(ConfigurationError);
  });

  it('refuses the known default postgres superuser DSN', () => {
    expect(() => resolveDatabaseUrl({ DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/postgres' })).toThrow(
      ConfigurationError,
    );
  });

  it('requires a strict sslmode in production and sets rejectUnauthorized', () => {
    expect(() => resolvePoolOptions(baseEnv)).toThrow(ConfigurationError);
    expect(() => resolvePoolOptions({ ...baseEnv, DATABASE_URL: 'postgresql://app:pw@db/db?sslmode=disable' })).toThrow(
      ConfigurationError,
    );
    const options = resolvePoolOptions({
      ...baseEnv,
      DATABASE_URL: 'postgresql://app:pw@db.example.com/app?sslmode=require',
    });
    expect(options.ssl).toEqual({ rejectUnauthorized: true });
  });

  it('non-production boot allows plain URLs (tests/dev)', () => {
    const options = resolvePoolOptions({ DATABASE_URL: 'postgres://a', NODE_ENV: 'development' });
    expect(options.ssl).toBeUndefined();
  });
});

describe('infrastructure/pool — lazy-promise creation lock', () => {
  it('ensureSharedPool awaits the same singleton under concurrent calls', async () => {
    await closePool();
    const original = process.env['DATABASE_URL'];
    process.env['DATABASE_URL'] = 'postgresql://lock-test';
    const [p1, p2] = await Promise.all([ensureSharedPool(), ensureSharedPool()]);
    expect(p1).toBe(p2);
    expect(p1).toBe(await getPool());
    await closePool();
    process.env['DATABASE_URL'] = original;
  });

  it('creation failure is reported to EVERY consumer — getPool and ensureSharedPool both reject (no silent path)', async () => {
    await closePool();
    const original = process.env['DATABASE_URL'];
    // Default superuser DSN → resolvePoolOptions throws ConfigurationError.
    process.env['DATABASE_URL'] = 'postgresql://postgres:postgres@localhost:5432/postgres';

    const fromGetPool = getPool();
    const fromEnsure = ensureSharedPool();
    // Both consumers of the SAME memoised promise observe the failure.
    await expect(fromGetPool).rejects.toBeInstanceOf(ConfigurationError);
    await expect(fromEnsure).rejects.toBeInstanceOf(ConfigurationError);
    // A later caller still gets the same memoised rejection (never a silent re-create).
    await expect(getPool()).rejects.toBeInstanceOf(ConfigurationError);
    // And acquireDbClient (the actual production consumer) reports it too.
    await expect(acquireDbClient()).rejects.toBeInstanceOf(ConfigurationError);

    process.env['DATABASE_URL'] = original;
    __setPoolForTesting(undefined);
  });
});
