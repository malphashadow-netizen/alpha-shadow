import { afterEach, describe, expect, it, vi } from 'vitest';

import { InMemoryCatalogRepository, InMemoryCatalogStore } from '../../../src/infrastructure/db/repositories/in-memory-catalog-repository.ts';
import { ConfigurationError } from '../../../src/shared/errors.ts';

describe('InMemory catalog repository — production runtime guard', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('refuses NODE_ENV=production with an explicit error', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => new InMemoryCatalogRepository(new InMemoryCatalogStore())).toThrow(ConfigurationError);
  });

  it('the error message names the Postgres implementation as the required alternative', () => {
    vi.stubEnv('NODE_ENV', 'production');
    try {
      new InMemoryCatalogRepository();
      throw new Error('expected the constructor to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      expect((error as Error).message).toContain('Postgres');
    }
  });

  it('constructs normally outside production (dev/test)', () => {
    vi.stubEnv('NODE_ENV', 'test');
    expect(() => new InMemoryCatalogRepository()).not.toThrow();
  });
});
