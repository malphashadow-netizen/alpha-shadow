/**
 * KDS realtime client (Phase 7, spec 2.3) — transport-agnostic consumer with
 * the resilience contract:
 *
 *   * AUTO-RECONNECT with EXPONENTIAL BACKOFF when the WebSocket drops;
 *   * on every (re)connect the client presents its LAST sequence_id and the
 *     server replays everything after it — no lost events across the gap;
 *   * automatic FALLBACK to SHORT POLLING after repeated WebSocket failures
 *     (the same lossless read over plain HTTP);
 *   * received events are de-duplicated defensively by sequence_id (the
 *     server is the authority, but the client never double-applies).
 *
 * R1: the client authenticates EVERY connection with its device token
 * (REQUIRED — a tokenless client cannot be constructed): the WebSocket
 * handshake carries it as the `?token=` query parameter (browsers cannot set
 * headers on an upgrade), the polling fallback as `Authorization: Bearer`.
 */
export interface KdsClientEvent {
  readonly sequenceId: number;
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

export interface KdsRealtimeClientOptions {
  /** Base URL, e.g. http://127.0.0.1:4123 */
  readonly baseUrl: string;
  readonly tenantId: string;
  readonly branchId: string;
  /** R1 device token minted for THIS branch (KdsDeviceEngine.issueDeviceToken). */
  readonly deviceToken: string;
  readonly onEvent: (event: KdsClientEvent) => void;
  readonly initialLastSequenceId?: number;
  /** Short-polling fallback period (default 250ms). */
  readonly pollIntervalMs?: number;
  /** Backoff base (default 50ms), doubled per attempt up to max. */
  readonly reconnectBaseDelayMs?: number;
  readonly reconnectMaxDelayMs?: number;
  /** Consecutive WebSocket failures before switching to polling (default 3). */
  readonly maxWebSocketRetries?: number;
  /** Injectable WebSocket factory (Node global / browser / test double). */
  readonly webSocketFactory?: (url: string) => WebSocket;
  readonly fetchImpl?: typeof fetch;
}

type ClientState = 'idle' | 'connecting' | 'streaming' | 'backing-off' | 'polling' | 'stopped';

export class KdsRealtimeClient {
  private readonly options: {
    pollIntervalMs: number;
    reconnectBaseDelayMs: number;
    reconnectMaxDelayMs: number;
    maxWebSocketRetries: number;
  } & KdsRealtimeClientOptions;
  private state: ClientState = 'idle';
  private lastSequenceId: number;
  private socket: WebSocket | null = null;
  private wsFailures = 0;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: KdsRealtimeClientOptions) {
    this.options = {
      pollIntervalMs: 250,
      reconnectBaseDelayMs: 50,
      reconnectMaxDelayMs: 2_000,
      maxWebSocketRetries: 3,
      ...options,
    };
    this.lastSequenceId = options.initialLastSequenceId ?? 0;
  }

  get currentState(): ClientState {
    return this.state;
  }

  get lastReceivedSequenceId(): number {
    return this.lastSequenceId;
  }

  start(): void {
    if (this.state !== 'idle' && this.state !== 'stopped') return;
    this.wsFailures = 0;
    this.connectWebSocket();
  }

  async stop(): Promise<void> {
    this.state = 'stopped';
    if (this.pendingTimer !== null) clearTimeout(this.pendingTimer);
    this.pendingTimer = null;
    if (this.pollTimer !== null) clearInterval(this.pollTimer);
    this.pollTimer = null;
    const socket = this.socket;
    this.socket = null;
    if (socket !== null && socket.readyState === socket.CONNECTING) {
      await new Promise<void>((resolvePromise) => {
        socket.addEventListener('close', () => { resolvePromise(); });
        socket.addEventListener('error', () => { resolvePromise(); });
        socket.close();
      });
    } else {
      socket?.close(1000, 'client stopped');
    }
  }

  /** Simulates a network-level drop WITHOUT stopping the client: auto-reconnect follows. */
  forceDrop(): void {
    const socket = this.socket;
    if (socket !== null && (socket.readyState === socket.OPEN || socket.readyState === socket.CONNECTING)) {
      // NOTE: this.socket is intentionally NOT nulled — the close event must
      // still be recognized as OUR socket so the auto-reconnect runs.
      socket.close(4000, 'simulated network drop');
    }
  }

  private wsUrl(): string {
    const base = this.options.baseUrl.replace(/\/$/, '');
    // The WebSocket constructor only accepts the ws/wss schemes; callers may
    // legitimately pass the plain-HTTP base URL of the KDS service.
    const wsBase = base.replace(/^http:\/\//i, 'ws://').replace(/^https:\/\//i, 'wss://');
    return `${wsBase}/kds/${this.options.tenantId}/branches/${this.options.branchId}/ws?token=${encodeURIComponent(this.options.deviceToken)}`;
  }

  private pollUrl(): string {
    const base = this.options.baseUrl.replace(/\/$/, '');
    return `${base}/kds/${this.options.tenantId}/branches/${this.options.branchId}/events?after=${this.lastSequenceId}`;
  }

  private connectWebSocket(): void {
    if (this.state === 'stopped') return;
    this.state = 'connecting';
    const factory = this.options.webSocketFactory ?? ((url: string) => new WebSocket(url));
    let socket: WebSocket;
    try {
      socket = factory(this.wsUrl());
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.addEventListener('open', () => {
      this.wsFailures = 0;
      if (this.socket !== socket) return;
      this.state = 'streaming';
      socket.send(JSON.stringify({ type: 'subscribe', last_sequence_id: this.lastSequenceId }));
    });
    socket.addEventListener('message', (event: MessageEvent) => {
      this.handleMessage(String(event.data));
    });
    // 'error' and 'close' both funnel into ONE idempotent failure handler,
    // because implementations disagree on the failure handshake:
    //   * some (undici on a failed handshake) fire 'error' but NEVER 'close';
    //   * others fire 'error' then 'close'.
    // Whichever arrives first detaches the socket and schedules exactly ONE
    // reconnect; the second is a no-op. Never call socket.close() from inside
    // the error handler — undici re-dispatches 'error' from the forced close
    // of a CONNECTING socket, recursing synchronously until the stack
    // overflows and leaving the client stuck in 'connecting', never falling
    // back to polling.
    let failureHandled = false;
    const handleSocketFailure = (): void => {
      if (this.state === 'stopped') return;
      if (this.socket !== socket) return; // already replaced/stopped
      if (failureHandled) return;
      failureHandled = true;
      this.socket = null;
      this.scheduleReconnect();
    };
    socket.addEventListener('close', handleSocketFailure);
    socket.addEventListener('error', handleSocketFailure);
  }

  private scheduleReconnect(): void {
    if (this.state === 'stopped') return;
    if (this.wsFailures >= this.options.maxWebSocketRetries) {
      this.switchToPolling();
      return;
    }
    this.wsFailures += 1;
    this.state = 'backing-off';
    const delay = Math.min(this.options.reconnectBaseDelayMs * 2 ** (this.wsFailures - 1), this.options.reconnectMaxDelayMs);
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = null;
      this.connectWebSocket();
    }, delay);
  }

  private switchToPolling(): void {
    if (this.state === 'stopped') return;
    this.state = 'polling';
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const poll = async (): Promise<void> => {
      if (this.state !== 'polling') return;
      try {
        const response = await fetchImpl(this.pollUrl(), {
          headers: { authorization: `Bearer ${this.options.deviceToken}` },
        });
        if (response.ok) {
          const body = JSON.parse(await response.text()) as { events?: unknown };
          const events = Array.isArray(body.events) ? parseWireEvents(body.events) : [];
          for (const event of events) this.applyEvent(event);
        }
      } catch {
        // transient: the next tick retries from the same sequence cursor
      }
    };
    void poll();
    this.pollTimer = setInterval(() => {
      void poll();
    }, this.options.pollIntervalMs);
  }

  private handleMessage(raw: string): void {
    let parsed: { type?: unknown; events?: unknown };
    try {
      parsed = JSON.parse(raw) as { type?: unknown; events?: unknown };
    } catch {
      return;
    }
    if (parsed.type !== 'events' || !Array.isArray(parsed.events)) return;
    for (const event of parseWireEvents(parsed.events)) this.applyEvent(event);
  }

  private applyEvent(event: KdsClientEvent): void {
    // Defensive de-dup: never re-apply an already-seen sequence (the server is
    // the authority; the client is the last line of defense).
    if (event.sequenceId <= this.lastSequenceId) return;
    this.lastSequenceId = event.sequenceId;
    this.options.onEvent(event);
  }
}

/**
 * Normalizes the documented wire format — {"sequence_id", "event_type",
 * "payload", "created_at"} (snake_case, shared by the WebSocket 'events'
 * frames and the polling endpoint) — into the client-facing camelCase event.
 * Anything without a valid numeric sequence_id is dropped: the sequence
 * contract is what makes replay lossless, so a frame without it is not an
 * event.
 */
function parseWireEvents(candidates: readonly unknown[]): readonly KdsClientEvent[] {
  const events: KdsClientEvent[] = [];
  for (const candidate of candidates) {
    if (candidate === null || typeof candidate !== 'object') continue;
    const wire = candidate as Partial<KdsWireEvent>;
    if (typeof wire.sequence_id !== 'number' || !Number.isFinite(wire.sequence_id)) continue;
    if (typeof wire.event_type !== 'string' || typeof wire.created_at !== 'string') continue;
    if (typeof wire.payload !== 'object' || wire.payload === null) continue;
    events.push({
      sequenceId: wire.sequence_id,
      eventType: wire.event_type,
      payload: wire.payload as Readonly<Record<string, unknown>>,
      createdAt: wire.created_at,
    });
  }
  return events;
}

/** The snake_case wire event produced by the KDS server (both channels). */
interface KdsWireEvent {
  readonly sequence_id?: unknown;
  readonly event_type?: unknown;
  readonly payload?: unknown;
  readonly created_at?: unknown;
}
