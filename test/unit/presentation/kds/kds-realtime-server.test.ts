import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { KdsRealtimeServer } from '../../../../src/presentation/kds/kds-realtime-server.ts';
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
    expect(() => new KdsRealtimeServer({ ...options(), pollIntervalMs: 1, maxLimit: 1, revalidationMs: 0 })).not.toThrow();
    for (const pollIntervalMs of [-1, 0, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new KdsRealtimeServer({ ...options(), pollIntervalMs })).toThrow(ValidationError);
    }
    for (const maxLimit of [-1, 0, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new KdsRealtimeServer({ ...options(), maxLimit })).toThrow(ValidationError);
    }
    for (const revalidationMs of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new KdsRealtimeServer({ ...options(), revalidationMs })).toThrow(ValidationError);
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
});
