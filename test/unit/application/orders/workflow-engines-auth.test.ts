/**
 * Audit F-D pin: the workflow engines gate HUMAN actors before any WRITE.
 *
 * Each test drives the engine with a REJECTING authorization spy and a store
 * spy, then asserts three things at once:
 *   1. the method rejects with ForbiddenError (no key → no execution);
 *   2. `check` received the EXACT input — the right key, the actor as the
 *      subject, and the right sensitivity flag (transition = cached,
 *      workflow-admin = NEVER cached);
 *   3. `store.run` was NEVER called — the gate is the first executable line,
 *      no probe/lock/read happens before it.
 *
 * The sensitivity flags asserted here are the other half of the L1 proof in
 * test/unit/application/rbac/authorization-engine.test.ts ("F-D: ..."), which
 * proves the sensitive key bypasses the cache when the flag arrives as true.
 */
import { describe, expect, it, vi } from 'vitest';
import { WorkflowAdminEngine } from '../../../../src/application/engines/orders/workflow-admin-engine.ts';
import { WorkflowTransitionEngine } from '../../../../src/application/engines/orders/workflow-transition-engine.ts';
import type { OrderItemRecord, OrderRecord, OrdersStore, OrdersTxScope } from '../../../../src/domain/contracts/orders.ts';
import { ForbiddenError, NotFoundError } from '../../../../src/shared/errors.ts';

const TENANT = '0fd00000-0000-4000-8000-00000000000d';
const ACTOR = '0fd00000-0000-4000-8000-0000000000a1';
const SEC_V = 'test-sec-v-fresh';
const ITEM_ID = 'item-1';
const ORDER_ID = 'order-1';
const BRANCH_ID = '0fd00000-0000-4000-8000-0000000000b1';

function rejectingAuth() {
  return { check: vi.fn().mockRejectedValue(new ForbiddenError('missing permission test-key')) };
}

function allowingAuth() {
  return { check: vi.fn().mockResolvedValue(undefined) };
}

function unreachedStore() {
  return { run: vi.fn() } as unknown as OrdersStore;
}

function orderItemFixture(overrides: Partial<OrderItemRecord> = {}): OrderItemRecord {
  return {
    id: ITEM_ID, tenantId: TENANT, orderId: ORDER_ID, menuItemId: 'menu-1', itemNameSnapshot: { ar: 'x' },
    unitPriceMinor: 1000n, quantity: 1, currentStatusKindId: 'state-received', stationId: 'station-1',
    isVoided: false, voidedAt: null, splitGroupId: null, createdAt: new Date(0), ...overrides,
  };
}

function orderFixture(overrides: Partial<OrderRecord> = {}): OrderRecord {
  return {
    id: ORDER_ID, tenantId: TENANT, branchId: BRANCH_ID, orderType: 'dine_in', salesChannelCode: 'pos',
    deliveryPlatformId: null, tableId: null, currentStatusKindId: 'state-received', paymentStatus: 'open',
    splitPeopleCount: null, placedAt: new Date(0), closedAt: null, ...overrides,
  };
}

function unused(name: string): never {
  throw new Error(`unused scope method called: ${name}`);
}

function fakeScope(overrides: {
  readonly loadOrderItem: OrdersTxScope['loadOrderItem'];
  readonly lockOrder: OrdersTxScope['lockOrder'];
}): OrdersTxScope {
  return {
    loadWorkflowStates: async () => unused('loadWorkflowStates'),
    loadOrder: async () => unused('loadOrder'),
    lockOrder: overrides.lockOrder,
    bumpOrderRevision: async () => unused('bumpOrderRevision'),
    loadOrderItem: overrides.loadOrderItem,
    loadActiveOrderItems: async () => unused('loadActiveOrderItems'),
    loadMenuItem: async () => unused('loadMenuItem'),
    loadOrderStatusKindFlags: async () => unused('loadOrderStatusKindFlags'),
    loadBranch: async () => unused('loadBranch'),
    createWorkflow: async () => unused('createWorkflow'),
    addWorkflowState: async () => unused('addWorkflowState'),
    setWorkflowStateEnabled: async () => unused('setWorkflowStateEnabled'),
    setWorkflowStatePosition: async () => unused('setWorkflowStatePosition'),
    countWorkflowStateReferences: async () => unused('countWorkflowStateReferences'),
    deleteWorkflowState: async () => unused('deleteWorkflowState'),
    resolveStationRoute: async () => unused('resolveStationRoute'),
    insertOrder: async () => unused('insertOrder'),
    insertOrderItem: async () => unused('insertOrderItem'),
    findOpenShiftForCashier: async () => unused('findOpenShiftForCashier'),
    insertInitialStatusEvent: async () => unused('insertInitialStatusEvent'),
    resolveInvoiceTax: async () => unused('resolveInvoiceTax'),
    insertStatusEvent: async () => unused('insertStatusEvent'),
    readOutboxEvents: async () => unused('readOutboxEvents'),
    loadEventsWithBehaviorFlags: async () => unused('loadEventsWithBehaviorFlags'),
    lastOutboxSequence: async () => unused('lastOutboxSequence'),
    claimSideEffect: async () => unused('claimSideEffect'),
    markSideEffect: async () => unused('markSideEffect'),
    loadVoidReason: async () => unused('loadVoidReason'),
    loadVoidTimeLimitMinutes: async () => unused('loadVoidTimeLimitMinutes'),
    resolveVoidPermissionTier: async () => unused('resolveVoidPermissionTier'),
    userIsActiveMember: async () => unused('userIsActiveMember'),
    appendEvent: async () => unused('appendEvent'),
    markOrderItemsVoided: async () => unused('markOrderItemsVoided'),
    setOrderPaymentStatus: async () => unused('setOrderPaymentStatus'),
    recomputeOrderStatus: async () => unused('recomputeOrderStatus'),
    insertOrderVoid: async () => unused('insertOrderVoid'),
    loadRecipeRequirements: async () => unused('loadRecipeRequirements'),
    loadInventoryItems: async () => unused('loadInventoryItems'),
    insertStockMovement: async () => unused('insertStockMovement'),
    insertStockOverrideClaim: async () => unused('insertStockOverrideClaim'),
    loadSaleDeductionsForOrderItems: async () => unused('loadSaleDeductionsForOrderItems'),
    loadItemsWithKitchenTicketFired: async () => unused('loadItemsWithKitchenTicketFired'),
    loadVoidRestorationKeys: async () => unused('loadVoidRestorationKeys'),
  };
}

function storeRunning(scope: OrdersTxScope): OrdersStore {
  return { run: async (_tenantId, fn) => fn(scope) };
}

describe('F-D/DD-003 transition engine authorization', () => {
  it('gates branch-aware after read-only loads but before bumpOrderRevision', async () => {
    const authorization = rejectingAuth();
    const scope = fakeScope({ loadOrderItem: async () => orderItemFixture(), lockOrder: async () => orderFixture() });
    const engine = new WorkflowTransitionEngine({ store: storeRunning(scope), authorization });

    await expect(engine.transitionItem(TENANT, {
      orderItemId: ITEM_ID, toWorkflowStateId: 'state-2', actorUserId: ACTOR, tokenSecV: SEC_V,
    })).rejects.toBeInstanceOf(ForbiddenError);

    expect(authorization.check).toHaveBeenCalledTimes(1);
    expect(authorization.check).toHaveBeenCalledWith({
      tenantId: TENANT,
      userId: ACTOR,
      permissionKey: 'order:item:transition',
      tokenSecV: SEC_V,
      context: { hasResource: true, actorBranchId: BRANCH_ID, resourceBranchId: BRANCH_ID, isSensitivePermission: false },
    });
  });

  it('does not disclose a missing item without a tenant-wide grant', async () => {
    const authorization = rejectingAuth();
    const scope = fakeScope({ loadOrderItem: async () => null, lockOrder: async () => unused('lockOrder') });
    const engine = new WorkflowTransitionEngine({ store: storeRunning(scope), authorization });

    await expect(engine.transitionItem(TENANT, {
      orderItemId: 'missing-item', toWorkflowStateId: 'state-2', actorUserId: ACTOR, tokenSecV: SEC_V,
    })).rejects.toBeInstanceOf(ForbiddenError);
    expect(authorization.check).toHaveBeenCalledWith({
      tenantId: TENANT, userId: ACTOR, permissionKey: 'order:item:transition', tokenSecV: SEC_V,
      context: { hasResource: false, actorBranchId: null, isSensitivePermission: false },
    });
  });

  it('returns NotFoundError for a missing item after a successful tenant-wide probe', async () => {
    const authorization = allowingAuth();
    const scope = fakeScope({ loadOrderItem: async () => null, lockOrder: async () => unused('lockOrder') });
    const engine = new WorkflowTransitionEngine({ store: storeRunning(scope), authorization });

    await expect(engine.transitionItem(TENANT, {
      orderItemId: 'missing-item', toWorkflowStateId: 'state-2', actorUserId: ACTOR, tokenSecV: SEC_V,
    })).rejects.toBeInstanceOf(NotFoundError);
  });

  it('does not disclose an order that cannot be locked without a tenant-wide grant', async () => {
    const authorization = rejectingAuth();
    const scope = fakeScope({ loadOrderItem: async () => orderItemFixture(), lockOrder: async () => null });
    const engine = new WorkflowTransitionEngine({ store: storeRunning(scope), authorization });

    await expect(engine.transitionItem(TENANT, {
      orderItemId: ITEM_ID, toWorkflowStateId: 'state-2', actorUserId: ACTOR, tokenSecV: SEC_V,
    })).rejects.toBeInstanceOf(ForbiddenError);
    expect(authorization.check).toHaveBeenCalledWith({
      tenantId: TENANT, userId: ACTOR, permissionKey: 'order:item:transition', tokenSecV: SEC_V,
      context: { hasResource: false, actorBranchId: null, isSensitivePermission: false },
    });
  });
});

describe('F-D workflow-admin engine authorization', () => {
  it('addState checks order:workflow:admin (sensitive) BEFORE any store call', async () => {
    const authorization = rejectingAuth();
    const store = unreachedStore();
    const engine = new WorkflowAdminEngine({ store, authorization });

    await expect(engine.addState(TENANT, ACTOR, SEC_V, {
      kindCode: 'deliberately-bogus-kind', parentKindCode: null, position: 1, label: { ar: 'x' },
    })).rejects.toBeInstanceOf(ForbiddenError);

    expect(authorization.check).toHaveBeenCalledWith({
      tenantId: TENANT,
      userId: ACTOR,
      permissionKey: 'order:workflow:admin',
      tokenSecV: SEC_V,
      context: { hasResource: false, actorBranchId: null, isSensitivePermission: true },
    });
    expect(store.run).not.toHaveBeenCalled();
  });

  it('disableState checks order:workflow:admin (sensitive) BEFORE any store call', async () => {
    const authorization = rejectingAuth();
    const store = unreachedStore();
    const engine = new WorkflowAdminEngine({ store, authorization });

    await expect(engine.disableState(TENANT, ACTOR, SEC_V, 'bogus-state-id')).rejects.toBeInstanceOf(ForbiddenError);

    expect(authorization.check).toHaveBeenCalledWith({
      tenantId: TENANT,
      userId: ACTOR,
      permissionKey: 'order:workflow:admin',
      tokenSecV: SEC_V,
      context: { hasResource: false, actorBranchId: null, isSensitivePermission: true },
    });
    expect(store.run).not.toHaveBeenCalled();
  });

  it('enableState checks order:workflow:admin (sensitive) BEFORE any store call', async () => {
    const authorization = rejectingAuth();
    const store = unreachedStore();
    const engine = new WorkflowAdminEngine({ store, authorization });

    await expect(engine.enableState(TENANT, ACTOR, SEC_V, 'bogus-state-id')).rejects.toBeInstanceOf(ForbiddenError);

    expect(authorization.check).toHaveBeenCalledWith({
      tenantId: TENANT,
      userId: ACTOR,
      permissionKey: 'order:workflow:admin',
      tokenSecV: SEC_V,
      context: { hasResource: false, actorBranchId: null, isSensitivePermission: true },
    });
    expect(store.run).not.toHaveBeenCalled();
  });

  it('reorderState checks order:workflow:admin (sensitive) BEFORE any store call', async () => {
    const authorization = rejectingAuth();
    const store = unreachedStore();
    const engine = new WorkflowAdminEngine({ store, authorization });

    await expect(engine.reorderState(TENANT, ACTOR, SEC_V, 'bogus-state-id', 99)).rejects.toBeInstanceOf(ForbiddenError);

    expect(authorization.check).toHaveBeenCalledWith({
      tenantId: TENANT,
      userId: ACTOR,
      permissionKey: 'order:workflow:admin',
      tokenSecV: SEC_V,
      context: { hasResource: false, actorBranchId: null, isSensitivePermission: true },
    });
    expect(store.run).not.toHaveBeenCalled();
  });

  it('deleteState checks order:workflow:admin (sensitive) BEFORE any store call', async () => {
    const authorization = rejectingAuth();
    const store = unreachedStore();
    const engine = new WorkflowAdminEngine({ store, authorization });

    await expect(engine.deleteState(TENANT, ACTOR, SEC_V, 'bogus-state-id')).rejects.toBeInstanceOf(ForbiddenError);

    expect(authorization.check).toHaveBeenCalledWith({
      tenantId: TENANT,
      userId: ACTOR,
      permissionKey: 'order:workflow:admin',
      tokenSecV: SEC_V,
      context: { hasResource: false, actorBranchId: null, isSensitivePermission: true },
    });
    expect(store.run).not.toHaveBeenCalled();
  });
});
