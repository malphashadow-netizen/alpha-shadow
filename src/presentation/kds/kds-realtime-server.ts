/**
 * KDS realtime server (Phase 7, spec 2.3) — the broadcast layer over the
 * transactional outbox.
 *
 *   * WebSocket is the PRIMARY channel. Protocol: the client's first message
 *     must be {"type":"subscribe","last_sequence_id":N}. The server then
 *     replays EVERY outbox event for the branch with sequence_id > N (lossless
 *     reconnect — the client never loses an event, whatever happened while it
 *     was disconnected) and keeps streaming new events.
 *   * HTTP short polling is the FALLBACK channel (the same lossless read is
 *     available at GET /kds/{tenant}/branches/{branch}/events?after=N&limit=M)
 *     for clients whose WebSocket path is completely unavailable.
 *
 * The server NEVER invents state: every pushed event was first durably
 * committed to order_events_outbox by the same transaction that changed the
 * order. Internally each connection polls the outbox on a short interval and
 * pushes only NEW sequences — a broadcast without a permanent row cannot
 * happen by construction.
 *
 * The future Local Branch Gateway (LAN replica) subscribes with the exact
 * same protocol; the per-branch gapless sequence_id is the resync key.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { OrderOutboxEvent } from '../../domain/contracts/orders.ts';

export interface KdsWireEvent {
  readonly sequence_id: number;
  readonly event_type: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly created_at: string;
}

export interface KdsRealtimeServerOptions {
  /** The lossless outbox read (KdsEventService.readEvents). */
  readonly readEvents: (tenantId: string, branchId: string, afterSequenceId: number, limit: number) => Promise<readonly OrderOutboxEvent[]>;
  readonly host?: string;
  readonly port?: number;
  /** Internal push-poll period per connection (default 200ms). */
  readonly pollIntervalMs?: number;
  /** Test/ops hook: refuse WS upgrades so clients exercise the polling fallback. */
  readonly disableWebSocket?: boolean;
  readonly maxLimit?: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface KdsRoute {
  readonly tenantId: string;
  readonly branchId: string;
  readonly action: 'ws' | 'events';
}

function parseKdsRoute(url: string | undefined): KdsRoute | null {
  if (url === undefined) return null;
  let path: string;
  try {
    path = new URL(url, 'http://kds.internal').pathname;
  } catch {
    return null;
  }
  const match = /^\/kds\/([0-9a-f-]{36})\/branches\/([0-9a-f-]{36})\/(ws|events)$/.exec(path);
  if (match === null) return null;
  const tenantId = match[1];
  const branchId = match[2];
  const action = match[3];
  if (tenantId === undefined || branchId === undefined || action === undefined) return null;
  if (!UUID_RE.test(tenantId) || !UUID_RE.test(branchId)) return null;
  return { tenantId, branchId, action: action === 'ws' ? 'ws' : 'events' };
}

function toWire(event: OrderOutboxEvent): KdsWireEvent {
  return {
    sequence_id: event.sequenceId,
    event_type: event.eventType,
    payload: event.payload,
    created_at: event.createdAt.toISOString(),
  };
}

interface Subscription {
  readonly tenantId: string;
  readonly branchId: string;
  lastSequenceId: number;
  timer: ReturnType<typeof setInterval> | null;
  socket: WebSocket;
}

export class KdsRealtimeServer {
  private readonly options: { pollIntervalMs: number; maxLimit: number } & KdsRealtimeServerOptions;
  private server: Server | null = null;
  private wss: WebSocketServer | null = null;
  private readonly subscriptions = new Set<Subscription>();
  private boundPort = 0;

  constructor(options: KdsRealtimeServerOptions) {
    this.options = { pollIntervalMs: 200, maxLimit: 1_000, ...options };
  }

  get port(): number {
    return this.boundPort;
  }

  async start(): Promise<number> {
    if (this.server !== null) return this.boundPort;
    const server = createServer((req, res) => {
      void this.handlePolling(req, res);
    });
    this.server = server;
    if (this.options.disableWebSocket !== true) {
      this.wss = new WebSocketServer({ noServer: true });
      server.on('upgrade', (req, socket, head) => {
        const route = parseKdsRoute(req.url);
        const wss = this.wss;
        if (route?.action !== 'ws' || wss === null) {
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          this.handleWebSocket(ws, route.tenantId, route.branchId);
        });
      });
    } else {
      server.on('upgrade', (_req, socket) => {
        // WebSocket is hard-disabled: clients fall back to short polling.
        socket.destroy();
      });
    }
    await new Promise<void>((resolvePromise, rejectPromise) => {
      server.once('error', rejectPromise);
      server.listen(this.options.port ?? 0, this.options.host ?? '127.0.0.1', () => {
        const address = server.address();
        if (address !== null && typeof address === 'object') this.boundPort = address.port;
        resolvePromise();
      });
    });
    return this.boundPort;
  }

  async stop(): Promise<void> {
    for (const subscription of this.subscriptions) {
      if (subscription.timer !== null) clearInterval(subscription.timer);
      subscription.socket.close(1001, 'server shutting down');
    }
    this.subscriptions.clear();
    this.wss?.close();
    this.wss = null;
    const server = this.server;
    if (server !== null) {
      await new Promise<void>((resolvePromise) => {
        server.close(() => { resolvePromise(); });
        // Node keeps upgraded sockets open unless explicitly dropped.
        server.closeAllConnections();
      });
      this.server = null;
    }
  }

  private async handlePolling(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const finish = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'GET' || req.url === undefined) {
      finish(404, { error: 'not_found' });
      return;
    }
    const route = parseKdsRoute(req.url);
    if (route?.action !== 'events') {
      finish(404, { error: 'not_found' });
      return;
    }
    let url: URL;
    try {
      url = new URL(req.url, 'http://kds.internal');
    } catch {
      finish(400, { error: 'bad_request' });
      return;
    }
    const after = Number.parseInt(url.searchParams.get('after') ?? '0', 10);
    const limit = Number.parseInt(url.searchParams.get('limit') ?? String(this.options.maxLimit), 10);
    if (!Number.isInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1) {
      finish(400, { error: 'bad_request' });
      return;
    }
    try {
      const events = await this.options.readEvents(route.tenantId, route.branchId, after, Math.min(limit, this.options.maxLimit));
      finish(200, { events: events.map(toWire) });
    } catch {
      // Never leak internals; polling clients retry on the next tick.
      finish(503, { error: 'unavailable' });
    }
  }

  private handleWebSocket(socket: WebSocket, tenantId: string, branchId: string): void {
    let subscription: Subscription | null = null;
    socket.on('message', (data: unknown) => {
      let parsed: { type?: unknown; last_sequence_id?: unknown };
      try {
        parsed = JSON.parse(String(data)) as { type?: unknown; last_sequence_id?: unknown };
      } catch {
        socket.close(1008, 'invalid_json');
        return;
      }
      if (parsed.type !== 'subscribe' || typeof parsed.last_sequence_id !== 'number' || !Number.isInteger(parsed.last_sequence_id) || parsed.last_sequence_id < 0) {
        socket.close(1008, 'expected {"type":"subscribe","last_sequence_id":number}');
        return;
      }
      if (subscription !== null) return; // one subscribe per connection
      const sub: Subscription = {
        tenantId,
        branchId,
        lastSequenceId: parsed.last_sequence_id,
        timer: null,
        socket,
      };
      subscription = sub;
      this.subscriptions.add(sub);
      // Replay everything the client missed, then keep streaming.
      void this.pump(sub, true);
      sub.timer = setInterval(() => {
        void this.pump(sub, false);
      }, this.options.pollIntervalMs);
    });
    socket.on('close', () => {
      const sub = subscription;
      if (sub !== null) {
        if (sub.timer !== null) clearInterval(sub.timer);
        this.subscriptions.delete(sub);
      }
    });
    socket.on('error', () => {
      socket.close(1011, 'internal_error');
    });
  }

  private async pump(subscription: Subscription, replay: boolean): Promise<void> {
    if (subscription.socket.readyState !== subscription.socket.OPEN) return;
    let events: readonly OrderOutboxEvent[];
    try {
      events = await this.options.readEvents(
        subscription.tenantId,
        subscription.branchId,
        subscription.lastSequenceId,
        this.options.maxLimit,
      );
    } catch {
      return; // transient read failure: the next tick retries; nothing is lost
    }
    if (events.length === 0) {
      if (replay) {
        subscription.socket.send(JSON.stringify({ type: 'events', events: [] }));
      }
      return;
    }
    const last = events[events.length - 1];
    if (last !== undefined) subscription.lastSequenceId = last.sequenceId;
    subscription.socket.send(JSON.stringify({ type: 'events', events: events.map(toWire) }));
  }
}
