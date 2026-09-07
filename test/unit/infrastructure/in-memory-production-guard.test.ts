/**
 * Runtime guard for the InMemory permission repositories (acceptance 7c).
 *
 * Selecting the InMemory implementation under NODE_ENV=production must fail
 * with an explicit error (ConfigurationError) — never silently fall back.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  InMemoryPermissionReadRepository,
  InMemoryPermissionStore,
  InMemoryPermissionWriteRepository,
} from '../../../src/infrastructure/db/repositories/in-memory-permission-repository.ts';
import { ConfigurationError } from '../../../src/shared/errors.ts';

describe('InMemory permission repositories — production runtime guard', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('(7c) the READ repository refuses NODE_ENV=production with an explicit error', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => new InMemoryPermissionReadRepository(new InMemoryPermissionStore())).toThrow(ConfigurationError);
  });

  it('(7c) the WRITE repository refuses NODE_ENV=production with an explicit error', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => new InMemoryPermissionWriteRepository(new InMemoryPermissionStore())).toThrow(ConfigurationError);
  });

  it('the error message names the Postgres implementation as the required alternative', () => {
    vi.stubEnv('NODE_ENV', 'production');
    try {
      new InMemoryPermissionReadRepository(new InMemoryPermissionStore());
      throw new Error('expected the constructor to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      expect((error as Error).message).toContain('Postgres');
    }
  });

  it('constructs normally outside production (dev/test)', () => {
    vi.stubEnv('NODE_ENV', 'test');
    const store = new InMemoryPermissionStore();
    expect(() => new InMemoryPermissionReadRepository(store)).not.toThrow();
    expect(() => new InMemoryPermissionWriteRepository(store)).not.toThrow();
  });
});
