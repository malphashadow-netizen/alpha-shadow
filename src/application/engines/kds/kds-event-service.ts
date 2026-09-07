/**
 * KDS event service (Phase 7, spec 2.3) — the application-layer read surface
 * consumed by the realtime transport (WebSocket primary) and the
 * short-polling fallback. Both read the SAME transactional outbox, so a
 * reconnecting client that presents its last sequence_id gets every event it
 * missed — lossless replay is a property of the storage contract, not of the
 * transport.
 *
 * The future Local Branch Gateway (LAN-only replica server, not built in this
 * phase) subscribes through the same read: the per-branch gapless sequence_id
 * is the resynchronization key, so the design needs no schema change later.
 */
import type { OrderOutboxEvent, OrdersStore } from '../../../domain/contracts/orders.ts';

export interface KdsEventServiceDependencies {
  readonly store: OrdersStore;
}

export class KdsEventService {
  private readonly dependencies: KdsEventServiceDependencies;

  constructor(dependencies: KdsEventServiceDependencies) {
    this.dependencies = dependencies;
  }

  /** Every event for the branch STRICTLY AFTER afterSequenceId, in order. */
  async readEvents(tenantId: string, branchId: string, afterSequenceId: number, limit = 1_000): Promise<readonly OrderOutboxEvent[]> {
    return this.dependencies.store.run(tenantId, (scope) => scope.readOutboxEvents(tenantId, branchId, afterSequenceId, limit));
  }
}
