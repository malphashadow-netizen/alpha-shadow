import { describe, expect, it, vi } from 'vitest';

import { ConfigurationError } from '../../../src/shared/errors.ts';
import { createPool, configureTypeParsers, resolveDatabaseUrl, closePool, __setPoolForTesting } from '../../../src/infrastructure/db/pool.ts';
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
    const p1 = getPool();
    const p2 = getPool();
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
    expect(() => gp()).toThrow(ConfigurationError);
    process.env['DATABASE_URL'] = original;
    __setPoolForTesting(undefined);
  });
});
