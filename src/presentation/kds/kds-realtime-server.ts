/**
 * KDS realtime server (Phase 7, spec 2.3; R1 device-token gate) — the
 * broadcast layer over the transactional outbox.
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
 * R1 AUTHENTICATION — every connection (WebSocket upgrade AND every polling
 * GET) must present a device token, either as `Authorization: Bearer <token>`
 * or as the `?token=` query parameter (connect-time only; the query form
 * exists because browsers cannot set headers on a WebSocket handshake).
 * The server verifies (tenant, branch, token) BEFORE any replay:
 *   * missing/unknown/revoked/cross-branch token → 401 on polling, a 401
 *     handshake rejection on WebSocket. The status is DELIBERATELY uniform —
 *     no reason code ever oracles token existence, status, or home branch.
 *   * verification INFRASTRUCTURE failure (the hook throws) → 503, never a
 *     silent accept (fail-closed) and never counted against the limiter.
 *   * repeated failures from one (tenant, branch, IP) → 429 (brute-force
 *     brake, shared across both transports). A success resets the counter.
 *
 * REVOCATION has TWO enforcement paths: revokeConnectionsForTokenHash()
 * drops already-open WebSocket connections the moment a deployment wires it
 * to the engine's revoke call, and every open subscription is revalidated
 * against the token table every revalidationMs (a confirmed-inactive token
 * drops the connection; a revalidation INFRA failure skips the round and
 * retries — a DB blip must not mass-drop healthy screens, and a stale-open
 * socket still streams ONLY the branch it was authorized for).
 *
 * The future Local Branch Gateway (LAN replica) subscribes with the exact
 * same protocol; the per-branch gapless sequence_id is the resync key.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import type { OrderOutboxEvent } from '../../domain/contracts/orders.ts';

export interface KdsWireEvent {
  readonly sequence_id: number;
  readonly event_type: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly created_at: string;
}

export interface KdsDeviceVerificationOutcome {
  readonly verified: boolean;
  readonly tokenHash: string | null;
}

export interface KdsRealtimeServerOptions {
  /** The lossless outbox read (KdsEventService.readEvents). */
  readonly readEvents: (tenantId: string, branchId: string, afterSequenceId: number, limit: number) => Promise<readonly OrderOutboxEvent[]>;
  /**
   * R1: verifies a presented device token for the URL's tenant+branch
   * (KdsDeviceEngine.verifyDeviceToken binds here structurally). Fail-closed:
   * a throw rejects the connection with 503; `verified: false` with 401.
   */
  readonly verifyDeviceToken: (tenantId: string, branchId: string, plaintextToken: string) => Promise<KdsDeviceVerificationOutcome>;
  /**
   * R1: revalidation probe for open subscriptions (KdsDeviceEngine
   * isDeviceTokenActive binds here). The subscription stores only the HASH —
   * the plaintext is never retained past connect time.
   */
  readonly isTokenHashActive: (tenantId: string, tokenHash: string) => Promise<boolean>;
  readonly host?: string;
  readonly port?: number;
  /** Internal push-poll period per connection (default 200ms). */
  readonly pollIntervalMs?: number;
  /** Test/ops hook: refuse WS upgrades so clients exercise the polling fallback. */
  readonly disableWebSocket?: boolean;
  readonly maxLimit?: number;
  /** Auth failures per (tenant, branch, IP) window before 429 (default 10). */
  readonly authFailureLimit?: number;
  /** Brute-force window in ms (default 60_000). */
  readonly authFailureWindowMs?: number;
  /** Open-subscription revalidation period in ms (default 60_000). */
  readonly revalidationMs?: number;
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

/**
 * R1: extracts the presented device token — `Authorization: Bearer` first,
 * `?token=` second. EITHER form authenticates; header wins when both are
 * present. Empty/absent on both → null (rejected as missing).
 */
function extractDeviceToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header === 'string') {
    const bearer = /^Bearer (.+)$/.exec(header.trim());
    if (bearer !== null) {
      const credential = bearer[1];
      if (credential !== undefined && credential.trim() !== '') return credential.trim();
    }
  }
  if (req.url === undefined) return null;
  try {
    const query = new URL(req.url, 'http://kds.internal').searchParams.get('token');
    if (query === null || query === '') return null;
    return query;
  } catch {
    return null;
  }
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
  readonly tokenHash: string;
  lastSequenceId: number;
  /** 0 at subscribe so the FIRST pump always revalidates (see pump). */
  lastRevalidatedAt: number;
  timer: ReturnType<typeof setInterval> | null;
  socket: WebSocket;
}

interface AuthFailureBucket {
  count: number;
  windowStart: number;
}

export class KdsRealtimeServer {
  private readonly options: {
    pollIntervalMs: number;
    maxLimit: number;
    authFailureLimit: number;
    authFailureWindowMs: number;
    revalidationMs: number;
  } & KdsRealtimeServerOptions;
  private server: Server | null = null;
  private wss: WebSocketServer | null = null;
  private readonly subscriptions = new Set<Subscription>();
  private readonly authFailures = new Map<string, AuthFailureBucket>();
  private boundPort = 0;

  constructor(options: KdsRealtimeServerOptions) {
    this.options = {
      pollIntervalMs: 200,
      maxLimit: 1_000,
      authFailureLimit: 10,
      authFailureWindowMs: 60_000,
      revalidationMs: 60_000,
      ...options,
    };
  }

  get port(): number {
    return this.boundPort;
  }

  /**
   * R1: drops every OPEN WebSocket subscription authenticated by this token
   * hash (the instant-kill half of revocation; deployments wire it to the
   * engine's revoke call). Returns the number of dropped connections.
   */
  revokeConnectionsForTokenHash(tokenHash: string): number {
    let dropped = 0;
    for (const subscription of this.subscriptions) {
      if (subscription.tokenHash !== tokenHash) continue;
      this.dropSubscription(subscription, 1008, 'token_revoked');
      dropped += 1;
    }
    return dropped;
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
        void this.handleUpgrade(req, socket, head);
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
    this.authFailures.clear();
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

  private limiterKey(tenantId: string, branchId: string, req: IncomingMessage): string {
    return `${tenantId}:${branchId}:${req.socket.remoteAddress ?? 'unknown'}`;
  }

  /**
   * R1 brute-force brake. Success resets the bucket; failure increments it
   * (expired windows restart at 1) and reports whether the caller is now
   * limited. Expired buckets are pruned on every failure so the map cannot
   * grow unboundedly.
   */
  private recordAuthSuccess(key: string): void {
    this.authFailures.delete(key);
  }

  private recordAuthFailure(key: string): boolean {
    const now = Date.now();
    for (const [other, bucket] of this.authFailures) {
      if (now - bucket.windowStart >= this.options.authFailureWindowMs) this.authFailures.delete(other);
    }
    const bucket = this.authFailures.get(key);
    if (bucket === undefined || now - bucket.windowStart >= this.options.authFailureWindowMs) {
      this.authFailures.set(key, { count: 1, windowStart: now });
      return 1 > this.options.authFailureLimit;
    }
    bucket.count += 1;
    return bucket.count > this.options.authFailureLimit;
  }

  private async handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const route = parseKdsRoute(req.url);
    const wss = this.wss;
    if (route?.action !== 'ws' || wss === null) {
      socket.destroy();
      return;
    }
    const rejectUpgrade = (status: string): void => {
      socket.write(`${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    const key = this.limiterKey(route.tenantId, route.branchId, req);
    const token = extractDeviceToken(req);
    if (token === null) {
      rejectUpgrade(this.recordAuthFailure(key) ? 'HTTP/1.1 429 Too Many Requests' : 'HTTP/1.1 401 Unauthorized');
      return;
    }
    let outcome: KdsDeviceVerificationOutcome;
    try {
      outcome = await this.options.verifyDeviceToken(route.tenantId, route.branchId, token);
    } catch {
      // Fail-closed, and infrastructure failure is never a brute-force signal.
      rejectUpgrade('HTTP/1.1 503 Service Unavailable');
      return;
    }
    if (!outcome.verified || outcome.tokenHash === null) {
      rejectUpgrade(this.recordAuthFailure(key) ? 'HTTP/1.1 429 Too Many Requests' : 'HTTP/1.1 401 Unauthorized');
      return;
    }
    this.recordAuthSuccess(key);
    const tokenHash = outcome.tokenHash;
    wss.handleUpgrade(req, socket, head, (ws) => {
      this.handleWebSocket(ws, route.tenantId, route.branchId, tokenHash);
    });
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
    // R1: authentication BEFORE parameter validation and before any replay.
    const key = this.limiterKey(route.tenantId, route.branchId, req);
    const token = extractDeviceToken(req);
    if (token === null) {
      const limited = this.recordAuthFailure(key);
      finish(limited ? 429 : 401, { error: limited ? 'rate_limited' : 'unauthorized' });
      return;
    }
    let outcome: KdsDeviceVerificationOutcome;
    try {
      outcome = await this.options.verifyDeviceToken(route.tenantId, route.branchId, token);
    } catch {
      // Never leak internals; polling clients retry on the next tick.
      finish(503, { error: 'unavailable' });
      return;
    }
    if (!outcome.verified) {
      const limited = this.recordAuthFailure(key);
      finish(limited ? 429 : 401, { error: limited ? 'rate_limited' : 'unauthorized' });
      return;
    }
    this.recordAuthSuccess(key);
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

  private handleWebSocket(socket: WebSocket, tenantId: string, branchId: string, tokenHash: string): void {
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
        tokenHash,
        lastSequenceId: parsed.last_sequence_id,
        lastRevalidatedAt: 0,
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

  private dropSubscription(subscription: Subscription, code: number, reason: string): void {
    if (subscription.timer !== null) {
      clearInterval(subscription.timer);
      subscription.timer = null;
    }
    this.subscriptions.delete(subscription);
    if (subscription.socket.readyState === subscription.socket.OPEN) {
      subscription.socket.close(code, reason);
    }
  }

  private async pump(subscription: Subscription, replay: boolean): Promise<void> {
    if (subscription.socket.readyState !== subscription.socket.OPEN) return;
    // R1: revalidate the token on the schedule (and ALWAYS on the first
    // pump — a revocation landing between the upgrade handshake and the
    // subscribe message must not buy a full window of streaming).
    if (Date.now() - subscription.lastRevalidatedAt >= this.options.revalidationMs) {
      let stillActive: boolean;
      try {
        stillActive = await this.options.isTokenHashActive(subscription.tenantId, subscription.tokenHash);
      } catch {
        return; // infra failure: skip this round, retry on the next tick
      }
      if (!stillActive) {
        this.dropSubscription(subscription, 1008, 'token_revoked');
        return;
      }
      subscription.lastRevalidatedAt = Date.now();
    }
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
