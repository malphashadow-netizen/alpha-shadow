/**
 * Side-effect delivery worker (Phase 7, spec 2.3 + the idempotency addition).
 *
 * CLAIM-THEN-EXECUTE over the side_effect_delivery_log ledger
 * (UNIQUE (outbox_event_id, side_effect_type)):
 *
 *   1. For every outbox event whose platform-kind behavior_flags require an
 *      external effect (fires_kitchen_ticket → kitchen_ticket_print,
 *      notifies_customer → customer_notification — the mapping is bound to
 *      the kind, never to a label), the worker tries to INSERT a 'pending'
 *      claim row.
 *   2. The INSERT succeeds → this run owns the execution: run the executor,
 *      mark 'succeeded' (with executed_at) or 'failed' (with last_error).
 *   3. The INSERT conflicts → a previous attempt exists:
 *        'succeeded'                      → SKIP entirely (no double print /
 *                                          notification — exactly-once effect);
 *        'failed' or stale 'pending'      → RETRY on the SAME row with
 *                                          attempt_count + 1.
 *
 * Consequence for a PARTIAL FAILURE (kitchen ticket printed, notification
 * failed): a retry re-executes ONLY the failed half. Event delivery is
 * at-least-once. The external effect is exactly-once ONLY IF the injected
 * executor is idempotent by idempotencyKey — claim-then-execute alone cannot
 * make an external system participate in the DB's commit/rollback, so a crash
 * between a successful execute() and the confirming markSideEffect('succeeded')
 * can cause a retry to re-invoke execute() with the SAME idempotencyKey.
 * Treating that key as a deduplication key at the integration boundary is a
 * mandatory contract on every real executor, not a guarantee this worker can
 * provide alone. `already_succeeded` means a prior execution completed,
 * whereas `owned_by_live_worker` means a concurrent live attempt owns a fresh
 * pending row; both must not be executed by this worker.
 *
 * The executor is a port: real printing/SMS/push integrations are the future
 * integrations phase; tests inject fakes. The worker itself is production
 * code.
 */
import type {
  OrderOutboxEvent,
  OrdersStore,
  SideEffectExecutor,
  SideEffectRunReport,
  SideEffectType,
} from '../../../domain/contracts/orders.ts';
import { parseOrderBehaviorFlags } from '../../../domain/contracts/orders.ts';

export interface SideEffectWorkerDependencies {
  readonly store: OrdersStore;
  readonly executor: SideEffectExecutor;
  /** A 'pending' row younger than this is owned by a live attempt. */
  readonly stalePendingAfterMs?: number;
  readonly batchSize?: number;
}

export function requiredSideEffectTypes(event: OrderOutboxEvent): readonly SideEffectType[] {
  if (typeof event.payload['behavior_flags'] !== 'object' || event.payload['behavior_flags'] === null) {
    return [];
  }
  const flags = parseOrderBehaviorFlags(event.payload['behavior_flags']);
  const types: SideEffectType[] = [];
  if (flags.fires_kitchen_ticket) types.push('kitchen_ticket_print');
  if (flags.notifies_customer) types.push('customer_notification');
  return types;
}

export class SideEffectWorker {
  private readonly dependencies: SideEffectWorkerDependencies;

  constructor(dependencies: SideEffectWorkerDependencies) {
    this.dependencies = dependencies;
  }

  /**
   * Processes pending external effects. An optional branchId scopes the run to
   * one branch (the deployment shape of the future Local Branch Gateway: each
   * branch box drains its own events); without it the run covers the tenant.
   */
  async processPending(tenantId: string, branchId?: string  ): Promise<SideEffectRunReport> {
    const staleAfter = this.dependencies.stalePendingAfterMs ?? 60_000;
    const limit = this.dependencies.batchSize ?? 200;

    const claimed = await this.dependencies.store.run(tenantId, async (scope) => {
      const events = await scope.loadEventsWithBehaviorFlags(tenantId, limit, branchId);
      let skippedAsSucceeded = 0;
      const effectsToExecute: { event: OrderOutboxEvent; type: SideEffectType }[] = [];
      for (const event of events) {
        for (const type of requiredSideEffectTypes(event)) {
          const claim = await scope.claimSideEffect(tenantId, event.id, type, staleAfter);
          if (claim.outcome === 'already_succeeded' || claim.outcome === 'owned_by_live_worker') {
            skippedAsSucceeded += 1;
            continue;
          }
          effectsToExecute.push({ event, type });
        }
      }
      return { examinedCount: events.length, skippedAsSucceeded, effectsToExecute };
    });

    const results: { event: OrderOutboxEvent; type: SideEffectType; status: 'succeeded' | 'failed'; errorMessage?: string }[] = [];
    for (const { event, type } of claimed.effectsToExecute) {
      try {
        await this.dependencies.executor.execute(event, type, `${event.id}:${type}`);
        results.push({ event, type, status: 'succeeded' });
      } catch (error) {
        results.push({
          event,
          type,
          status: 'failed',
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const confirmed = await this.dependencies.store.run(tenantId, async (scope) => {
      let executed = 0;
      let failed = 0;
      for (const result of results) {
        await scope.markSideEffect(
          tenantId,
          result.event.id,
          result.type,
          result.status,
          result.errorMessage,
        );
        if (result.status === 'succeeded') {
          executed += 1;
        } else {
          failed += 1;
        }
      }
      return { executed, failed };
    });

    return {
      examined: claimed.examinedCount,
      executed: confirmed.executed,
      skippedAsSucceeded: claimed.skippedAsSucceeded,
      failed: confirmed.failed,
    };
  }
}
