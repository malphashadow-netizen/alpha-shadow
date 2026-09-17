import { describe, expect, it, vi } from 'vitest';
import { SideEffectWorker } from '../../../../src/application/engines/kds/side-effect-worker.ts';
import { ValidationError } from '../../../../src/shared/errors.ts';
import type {
  OrderOutboxEvent,
  OrdersStore,
  OrdersTxScope,
  SideEffectClaimOutcome,
  SideEffectExecutor,
  SideEffectType,
} from '../../../../src/domain/contracts/orders.ts';

const TENANT_ID = 'tenant-1';
const BRANCH_ID = 'branch-1';

function eventFixture(id: string, flags: { fires_kitchen_ticket: boolean; notifies_customer: boolean }): OrderOutboxEvent {
  return {
    id,
    tenantId: TENANT_ID,
    branchId: BRANCH_ID,
    sequenceId: 1,
    eventType: 'order_item.status_changed',
    payload: {
      behavior_flags: {
        fires_kitchen_ticket: flags.fires_kitchen_ticket,
        opens_payment_collection: false,
        notifies_customer: flags.notifies_customer,
        is_terminal: false,
        is_financial_close: false,
      },
    },
    createdAt: new Date(0),
  };
}

function fakeStore(events: readonly OrderOutboxEvent[], outcomes: readonly SideEffectClaimOutcome[]) {
  let claimIndex = 0;
  let runCount = 0;
  const markSideEffect = vi.fn<OrdersTxScope['markSideEffect']>().mockResolvedValue(undefined);
  const scope = {
    loadEventsWithBehaviorFlags: vi.fn().mockResolvedValue(events),
    claimSideEffect: vi.fn(async (): Promise<SideEffectClaimOutcome> => {
      const outcome = outcomes[claimIndex++];
      if (outcome === undefined) {
        throw new Error(`fakeStore: claimSideEffect called more times (${claimIndex}) than outcomes provided (${outcomes.length})`);
      }
      return outcome;
    }),
    markSideEffect,
  } as unknown as OrdersTxScope;
  const store: OrdersStore = {
    run: async <T>(_tenantId: string, fn: (transactionScope: OrdersTxScope) => Promise<T>): Promise<T> => {
      runCount += 1;
      return fn(scope);
    },
  };
  return { store, markSideEffect, runCount: () => runCount };
}

describe('SideEffectWorker', () => {
  it('validates numeric configuration bounds at construction', () => {
    const store = {} as OrdersStore;
    const executor = {} as SideEffectExecutor;
    expect(() => new SideEffectWorker({ store, executor, stalePendingAfterMs: 0, batchSize: 1 })).not.toThrow();
    for (const stalePendingAfterMs of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new SideEffectWorker({ store, executor, stalePendingAfterMs })).toThrow(ValidationError);
    }
    for (const batchSize of [-1, 0, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new SideEffectWorker({ store, executor, batchSize })).toThrow(ValidationError);
    }
  });

  it('uses separate claim and confirm transactions and passes the deterministic idempotency key', async () => {
    const event = eventFixture('event-1', { fires_kitchen_ticket: true, notifies_customer: false });
    const { store, runCount } = fakeStore([event], [{ outcome: 'claimed', attemptCount: 1 }]);
    const executor: SideEffectExecutor = { execute: vi.fn().mockResolvedValue(undefined) };

    const report = await new SideEffectWorker({ store, executor }).processPending(TENANT_ID, BRANCH_ID);

    expect(report).toEqual({ examined: 1, executed: 1, skippedAsSucceeded: 0, failed: 0 });
    expect(runCount()).toBe(2);
    expect(executor.execute).toHaveBeenCalledWith(event, 'kitchen_ticket_print', 'event-1:kitchen_ticket_print');
  });

  it('skips both completed effects and effects owned by live workers without executing them', async () => {
    const event = eventFixture('event-2', { fires_kitchen_ticket: true, notifies_customer: true });
    const { store, markSideEffect } = fakeStore([event], [
      { outcome: 'already_succeeded', attemptCount: 1 },
      { outcome: 'owned_by_live_worker', attemptCount: 1 },
    ]);
    const executor: SideEffectExecutor = { execute: vi.fn().mockResolvedValue(undefined) };

    const report = await new SideEffectWorker({ store, executor }).processPending(TENANT_ID, BRANCH_ID);

    expect(report).toEqual({ examined: 1, executed: 0, skippedAsSucceeded: 2, failed: 0 });
    expect(executor.execute).not.toHaveBeenCalled();
    expect(markSideEffect).not.toHaveBeenCalled();
  });

  it('confirms failures while continuing to execute and confirm other claimed effects', async () => {
    const event = eventFixture('event-3', { fires_kitchen_ticket: true, notifies_customer: true });
    const { store, markSideEffect } = fakeStore([event], [
      { outcome: 'claimed', attemptCount: 1 },
      { outcome: 'claimed', attemptCount: 1 },
    ]);
    const executor: SideEffectExecutor = {
      execute: vi.fn(async (_event: OrderOutboxEvent, type: SideEffectType): Promise<void> => {
        if (type === 'kitchen_ticket_print') throw new Error('printer unavailable');
      }),
    };

    const report = await new SideEffectWorker({ store, executor }).processPending(TENANT_ID, BRANCH_ID);

    expect(report).toEqual({ examined: 1, executed: 1, skippedAsSucceeded: 0, failed: 1 });
    expect(markSideEffect).toHaveBeenCalledWith(
      TENANT_ID,
      event.id,
      'kitchen_ticket_print',
      'failed',
      'printer unavailable',
    );
    expect(markSideEffect).toHaveBeenCalledWith(
      TENANT_ID,
      event.id,
      'customer_notification',
      'succeeded',
      undefined,
    );
  });
});
