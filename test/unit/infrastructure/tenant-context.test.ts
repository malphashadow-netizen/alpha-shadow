import { describe, expect, it, vi } from 'vitest';

import { ValidationError } from '../../../src/shared/errors.ts';
import { createWithTenantContext, TENANT_ID_SETTING } from '../../../src/infrastructure/db/tenant-context.ts';
import type { TenantClient, TenantPool } from '../../../src/infrastructure/db/tenant-context.ts';

const VALID_TENANT = '123e4567-e89b-4123-a456-426614174000'; // v4, variant a
const VALID_TENANT_B = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'; // v4, variant 8
const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const INVALID_VERSION = '123e4567-e89b-0123-a456-426614174000'; // version 0
const INVALID_VARIANT = '123e4567-e89b-4123-c456-426614174000'; // variant c
const INVALID_FORMAT = 'not-a-uuid';

function createMockClient(opts: {
  beginFails?: boolean;
  setConfigFails?: boolean;
  commitFails?: boolean;
  rollbackFails?: boolean;
  discardFails?: boolean;
  // how many DISCARD calls should fail? we can make it fail always if true, or fail after N calls
  // For begin case, DISCARD is first after BEGIN fail; for operation case, DISCARD after ROLLBACK; for success case, DISCARD after COMMIT
  callbackFails?: boolean;
} = {}): { client: TenantClient; calls: string[]; releaseArgs: unknown[]; queryMock: ReturnType<typeof vi.fn> } {
  const calls: string[] = [];
  const releaseArgs: unknown[] = [];
  const queryMock = vi.fn(async (text: string, values?: unknown[]) => {
    calls.push(text);
    if (text === 'BEGIN' && opts.beginFails) throw new Error('BEGIN failed');
    if (text.startsWith('SELECT set_config') && opts.setConfigFails) throw new Error('set_config failed');
    if (text === 'COMMIT' && opts.commitFails) throw new Error('COMMIT failed');
    if (text === 'ROLLBACK' && opts.rollbackFails) throw new Error('ROLLBACK failed');
    if (text === 'DISCARD ALL' && opts.discardFails) throw new Error('DISCARD ALL failed');
    // callback failure is handled outside via fn throwing, not via query
    return { rows: [], rowCount: 0 } as unknown as never;
  });

  const client: TenantClient = {
    query: queryMock as TenantClient['query'],
    release: vi.fn((arg?: unknown) => {
      releaseArgs.push(arg);
    }) as TenantClient['release'],
  };
  return { client, calls, releaseArgs, queryMock };
}

function createMockPool(client: TenantClient): TenantPool & { connectCalls: number } {
  let connectCalls = 0;
  return {
    connect: vi.fn(async () => {
      connectCalls++;
      return client;
    }) as TenantPool['connect'],
    get connectCalls() {
      return connectCalls;
    },
  } as TenantPool & { connectCalls: number };
}

describe('infrastructure/tenant-context — withTenantContext', () => {
  it('1. success: BEGIN → set_config → callback → COMMIT → DISCARD → release normal and return value', async () => {
    const { client, calls, releaseArgs } = createMockClient();
    const pool = createMockPool(client);
    const withTenantContext = createWithTenantContext(pool);

    const result = await withTenantContext(VALID_TENANT, async (q) => {
      expect(Object.isFrozen(q)).toBe(true);
      expect(typeof q.query).toBe('function');
      expect((q as unknown as Record<string, unknown>)['release']).toBeUndefined();
      expect((q as unknown as Record<string, unknown>)['commit']).toBeUndefined();
      const r = await q.query('SELECT 1');
      expect(r).toBeDefined();
      return 42;
    });

    expect(result).toBe(42);
    expect(calls).toEqual(['BEGIN', `SELECT set_config($1, $2, true)`, 'SELECT 1', 'COMMIT', 'DISCARD ALL']);
    expect(releaseArgs).toHaveLength(1);
    expect(releaseArgs[0]).toBeUndefined(); // normal release
  });

  it('2. BEGIN fails, DISCARD succeeds → throw beginError only, release normal, no ROLLBACK', async () => {
    const { client, calls, releaseArgs } = createMockClient({ beginFails: true });
    const pool = createMockPool(client);
    const withTenantContext = createWithTenantContext(pool);

    await expect(withTenantContext(VALID_TENANT, async () => 1)).rejects.toThrow('BEGIN failed');

    expect(calls).toEqual(['BEGIN', 'DISCARD ALL']);
    expect(calls).not.toContain('ROLLBACK');
    expect(releaseArgs[0]).toBeUndefined();
  });

  it('3. BEGIN fails, DISCARD fails → AggregateError([beginError, discardError]), destroy', async () => {
    const { client, calls, releaseArgs } = createMockClient({ beginFails: true, discardFails: true });
    const pool = createMockPool(client);
    const withTenantContext = createWithTenantContext(pool);

    let caught: unknown;
    try {
      await withTenantContext(VALID_TENANT, async () => 1);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AggregateError);
    const agg = caught as AggregateError;
    expect(agg.errors).toHaveLength(2);
    expect((agg.errors[0] as Error).message).toBe('BEGIN failed');
    expect((agg.errors[1] as Error).message).toBe('DISCARD ALL failed');
    expect(releaseArgs[0]).toBeInstanceOf(Error);
    expect((releaseArgs[0] as Error).message).toBe('DISCARD ALL failed');
    expect(calls).toEqual(['BEGIN', 'DISCARD ALL']);
  });

  it('4. set_config fails, ROLLBACK succeeds, DISCARD succeeds → throw operationError only', async () => {
    const { client, calls, releaseArgs } = createMockClient({ setConfigFails: true });
    const pool = createMockPool(client);
    const withTenantContext = createWithTenantContext(pool);

    await expect(withTenantContext(VALID_TENANT, async () => 1)).rejects.toThrow('set_config failed');
    expect(calls).toEqual(['BEGIN', `SELECT set_config($1, $2, true)`, 'ROLLBACK', 'DISCARD ALL']);
    expect(releaseArgs[0]).toBeUndefined();
  });

  it('5. set_config fails, ROLLBACK succeeds, DISCARD fails → AggregateError([operationError, discardError])', async () => {
    const { client } = createMockClient({ setConfigFails: true, discardFails: true });
    const pool = createMockPool(client);
    const withTenantContext = createWithTenantContext(pool);

    let caught: unknown;
    try {
      await withTenantContext(VALID_TENANT, async () => 1);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors).toHaveLength(2);
    expect(((caught as AggregateError).errors[0] as Error).message).toBe('set_config failed');
  });

  it('6. callback fails, ROLLBACK succeeds, DISCARD succeeds → throw callbackError', async () => {
    const { client, calls } = createMockClient();
    const pool = createMockPool(client);
    const withTenantContext = createWithTenantContext(pool);

    const cbErr = new Error('callback boom');
    await expect(withTenantContext(VALID_TENANT, async () => { throw cbErr; })).rejects.toThrow(cbErr);
    expect(calls).toEqual(['BEGIN', `SELECT set_config($1, $2, true)`, 'ROLLBACK', 'DISCARD ALL']);
  });

  it('7. callback fails, ROLLBACK succeeds, DISCARD fails → AggregateError', async () => {
    const { client } = createMockClient({ discardFails: true });
    const pool = createMockPool(client);
    const withTenantContext = createWithTenantContext(pool);

    let caught: unknown;
    try {
      await withTenantContext(VALID_TENANT, async () => { throw new Error('cb'); });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors).toHaveLength(2);
  });

  it('8. COMMIT fails, ROLLBACK succeeds, DISCARD succeeds → throw commitError', async () => {
    const { client, calls } = createMockClient({ commitFails: true });
    const pool = createMockPool(client);
    const withTenantContext = createWithTenantContext(pool);

    await expect(withTenantContext(VALID_TENANT, async () => 1)).rejects.toThrow('COMMIT failed');
    expect(calls).toEqual(['BEGIN', `SELECT set_config($1, $2, true)`, 'COMMIT', 'ROLLBACK', 'DISCARD ALL']);
  });

  it('9. operation fails, ROLLBACK fails, DISCARD succeeds → AggregateError([operation, rollback]), destroy', async () => {
    const { client, releaseArgs } = createMockClient({ setConfigFails: true, rollbackFails: true });
    const pool = createMockPool(client);
    const withTenantContext = createWithTenantContext(pool);

    let caught: unknown;
    try {
      await withTenantContext(VALID_TENANT, async () => 1);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors).toHaveLength(2);
    expect(releaseArgs[0]).toBeInstanceOf(AggregateError);
  });

  it('10. operation fails, ROLLBACK fails, DISCARD fails → AggregateError with 3 errors', async () => {
    const { client, releaseArgs } = createMockClient({ setConfigFails: true, rollbackFails: true, discardFails: true });
    const pool = createMockPool(client);
    const withTenantContext = createWithTenantContext(pool);

    let caught: unknown;
    try {
      await withTenantContext(VALID_TENANT, async () => 1);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AggregateError);
    const agg = caught as AggregateError;
    expect(agg.errors).toHaveLength(3);
    expect((agg.errors[0] as Error).message).toBe('set_config failed');
    expect((agg.errors[1] as Error).message).toBe('ROLLBACK failed');
    expect((agg.errors[2] as Error).message).toBe('DISCARD ALL failed');
    expect(releaseArgs[0]).toBeInstanceOf(Error);
  });

  it('11. DISCARD ALL after COMMIT succeeds fails → throw only discardError, destroy, not return value', async () => {
    const { client, releaseArgs } = createMockClient({ discardFails: true });
    // Need to make only the final DISCARD fail, not earlier DISCARDs. Our mock fails all DISCARDs, but in success path there is only one DISCARD after COMMIT.
    // In this test, BEGIN/commit path has no earlier DISCARD, so failing DISCARD here is correct for case C.
    // However our mock will also fail DISCARD in operation failure cases, but here operation succeeds.
    const pool = createMockPool(client);
    const withTenantContext = createWithTenantContext(pool);

    let caught: unknown;
    let returned: unknown = 'not-called';
    try {
      returned = await withTenantContext(VALID_TENANT, async () => 99);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe('DISCARD ALL failed');
    expect(caught).not.toBeInstanceOf(AggregateError);
    expect(returned).toBe('not-called'); // should not return value
    expect(releaseArgs[0]).toBeInstanceOf(Error);
  });

  it('12. rejects invalid tenantId before acquiring connection (including nil UUID)', async () => {
    const { client } = createMockClient();
    const pool = {
      connect: vi.fn(async () => client),
    } as unknown as TenantPool;

    const withTenantContext = createWithTenantContext(pool);

    const invalids = [NIL_UUID, INVALID_VERSION, INVALID_VARIANT, INVALID_FORMAT, '', '123', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeeee'];
    for (const id of invalids) {
      await expect(withTenantContext(id, async () => 1)).rejects.toBeInstanceOf(ValidationError);
      expect(pool.connect).not.toHaveBeenCalled();
      vi.clearAllMocks();
    }

    // valid should not throw validation
    const { client: c2 } = createMockClient();
    const pool2 = createMockPool(c2);
    const w2 = createWithTenantContext(pool2);
    await expect(w2(VALID_TENANT_B, async () => 1)).resolves.toBe(1);
  });

  it('13. TenantQuery is frozen and only exposes query, forwards to client', async () => {
    const { client } = createMockClient();
    const pool = createMockPool(client);
    const withTenantContext = createWithTenantContext(pool);

    await withTenantContext(VALID_TENANT, async (q) => {
      expect(Object.isFrozen(q)).toBe(true);
      expect(Object.keys(q)).toEqual(['query']);
      // Ensure query is bound to client
      await q.query('SELECT $1', [TENANT_ID_SETTING]);
      expect(client.query).toHaveBeenCalledWith('SELECT $1', [TENANT_ID_SETTING]);
      // Verify set_config used parameterized $1, $2
      const setConfigCall = (client.query as ReturnType<typeof vi.fn>).mock.calls.find(
        (call) => typeof call[0] === 'string' && call[0].includes('set_config'),
      );
      expect(setConfigCall).toBeDefined();
      expect(setConfigCall?.[0]).toBe('SELECT set_config($1, $2, true)');
      expect(setConfigCall?.[1]).toEqual([TENANT_ID_SETTING, VALID_TENANT]);
    });
  });
});
