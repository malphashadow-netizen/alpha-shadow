import { describe, expect, it } from 'vitest';

import { KdsRealtimeClient, type KdsRealtimeClientOptions } from '../../../../src/presentation/kds/kds-realtime-client.ts';

const options: KdsRealtimeClientOptions = {
  baseUrl: 'http://127.0.0.1:4123',
  tenantId: '11111111-1111-4111-8111-111111111111',
  branchId: '22222222-2222-4222-8222-222222222222',
  deviceToken: 'device-token',
  onEvent: () => undefined,
};

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(predicate()).toBe(true);
}

describe('KdsRealtimeClient', () => {
  it('validates polling and reconnect bounds at construction', () => {
    expect(() => new KdsRealtimeClient(options)).not.toThrow();
    expect(() => new KdsRealtimeClient({ ...options, pollIntervalMs: 0 })).toThrow('pollIntervalMs');
    expect(() => new KdsRealtimeClient({ ...options, reconnectBaseDelayMs: 1.5 })).toThrow('reconnectBaseDelayMs');
    expect(() => new KdsRealtimeClient({ ...options, reconnectMaxDelayMs: Number.NaN })).toThrow('reconnectMaxDelayMs');
    expect(() => new KdsRealtimeClient({ ...options, maxWebSocketRetries: -1 })).toThrow('maxWebSocketRetries');
    expect(() => new KdsRealtimeClient({ ...options, reconnectBaseDelayMs: 100, reconnectMaxDelayMs: 50 }))
      .toThrow('reconnectMaxDelayMs');
  });

  it('does not overlap polling requests while a previous fetch is pending', async () => {
    let concurrent = 0;
    let maximumConcurrent = 0;
    let resolveFirstFetch: (() => void) | undefined;
    const firstFetch = new Promise<void>((resolve) => { resolveFirstFetch = resolve; });
    const fetchImpl: typeof fetch = async () => {
      concurrent += 1;
      maximumConcurrent = Math.max(maximumConcurrent, concurrent);
      await firstFetch;
      concurrent -= 1;
      return new Response(JSON.stringify({ events: [] }), { status: 200 });
    };
    const client = new KdsRealtimeClient({
      ...options,
      pollIntervalMs: 10,
      maxWebSocketRetries: 0,
      webSocketFactory: () => { throw new Error('WebSocket unavailable'); },
      fetchImpl,
    });
    try {
      client.start();
      await waitFor(() => concurrent === 1);
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(maximumConcurrent).toBe(1);
    } finally {
      resolveFirstFetch?.();
      await client.stop();
    }
  });
});
