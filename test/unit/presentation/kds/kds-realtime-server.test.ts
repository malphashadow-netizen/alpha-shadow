import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { KDS_MAX_EVENT_BATCH_LIMIT, KdsRealtimeServer } from '../../../../src/presentation/kds/kds-realtime-server.ts';
import { ValidationError } from '../../../../src/shared/errors.ts';

const TENANT = '11111111-1111-4111-8111-111111111111';
const BRANCH = '22222222-2222-4222-8222-222222222222';

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(predicate()).toBe(true);
}

function options() {
  return {
    readEvents: async () => [],
    verifyDeviceToken: async () => ({ verified: true, tokenHash: 'token-hash' }),
    isTokenHashActive: async () => true,
  };
}

describe('KdsRealtimeServer', () => {
  it('validates numeric configuration bounds at construction', () => {
    expect(() => new KdsRealtimeServer({
      ...options(), pollIntervalMs: 1, maxLimit: 1, revalidationMs: 0, authFailureLimit: 1, authFailureWindowMs: 1,
    })).not.toThrow();
    for (const pollIntervalMs of [-1, 0, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new KdsRealtimeServer({ ...options(), pollIntervalMs })).toThrow(ValidationError);
    }
    for (const maxLimit of [-1, 0, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new KdsRealtimeServer({ ...options(), maxLimit })).toThrow(ValidationError);
    }
    expect(() => new KdsRealtimeServer({ ...options(), maxLimit: KDS_MAX_EVENT_BATCH_LIMIT + 1 })).toThrow(ValidationError);
    for (const revalidationMs of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new KdsRealtimeServer({ ...options(), revalidationMs })).toThrow(ValidationError);
    }
    for (const authFailureLimit of [-1, 0, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new KdsRealtimeServer({ ...options(), authFailureLimit })).toThrow(ValidationError);
    }
    for (const authFailureWindowMs of [-1, 0, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new KdsRealtimeServer({ ...options(), authFailureWindowMs })).toThrow(ValidationError);
    }
  });

  it('does not overlap readEvents calls for one subscription', async () => {
    let reads = 0;
    let resolveFirst: (() => void) | undefined;
    const firstRead = new Promise<void>((resolve) => { resolveFirst = resolve; });
    const server = new KdsRealtimeServer({
      ...options(),
      pollIntervalMs: 10,
      readEvents: async () => {
        reads += 1;
        if (reads === 1) await firstRead;
        return [];
      },
    });
    const port = await server.start();
    const socket = new WebSocket(`ws://127.0.0.1:${port}/kds/${TENANT}/branches/${BRANCH}/ws?token=token`);
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('open', () => { socket.send(JSON.stringify({ type: 'subscribe', last_sequence_id: 0 })); resolve(); });
        socket.once('error', reject);
      });
      await waitFor(() => reads === 1);
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(reads).toBe(1);
      resolveFirst?.();
      await waitFor(() => reads === 2);
    } finally {
      socket.close();
      await server.stop();
    }
  });

  it.each([
    'after=1x',
    'after=1.5',
    'after=-1',
    'after=',
    'after=9007199254740992',
    'limit=1x',
    'limit=1.5',
    'limit=-1',
    'limit=0',
    'limit=',
    'limit=9007199254740992',
  ])('rejects malformed polling query %s before reading events', async (query) => {
    let reads = 0;
    const server = new KdsRealtimeServer({
      ...options(),
      readEvents: async () => {
        reads += 1;
        return [];
      },
    });
    const port = await server.start();
    try {
      const response = await fetch(`http://127.0.0.1:${port}/kds/${TENANT}/branches/${BRANCH}/events?${query}`, {
        headers: { authorization: 'Bearer token' },
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'bad_request' });
      expect(reads).toBe(0);
    } finally {
      await server.stop();
    }
  });
});
