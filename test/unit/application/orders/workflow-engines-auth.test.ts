/**
 * Audit F-D pin: the workflow engines gate HUMAN actors FIRST.
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
import type { OrdersStore } from '../../../../src/domain/contracts/orders.ts';
import { ForbiddenError } from '../../../../src/shared/errors.ts';

const TENANT = '0fd00000-0000-4000-8000-00000000000d';
const ACTOR = '0fd00000-0000-4000-8000-0000000000a1';
const SEC_V = 'test-sec-v-fresh';

function rejectingAuth() {
  return { check: vi.fn().mockRejectedValue(new ForbiddenError('missing permission test-key')) };
}

function unreachedStore() {
  return { run: vi.fn() } as unknown as OrdersStore;
}

describe('F-D transition engine authorization', () => {
  it('transitionItem checks order:item:transition (non-sensitive) BEFORE any store call', async () => {
    const authorization = rejectingAuth();
    const store = unreachedStore();
    const engine = new WorkflowTransitionEngine({ store, authorization });

    await expect(engine.transitionItem(TENANT, {
      orderItemId: 'item-1', toWorkflowStateId: 'state-1', actorUserId: ACTOR, tokenSecV: SEC_V,
    })).rejects.toBeInstanceOf(ForbiddenError);

    expect(authorization.check).toHaveBeenCalledTimes(1);
    expect(authorization.check).toHaveBeenCalledWith({
      tenantId: TENANT,
      userId: ACTOR,
      permissionKey: 'order:item:transition',
      tokenSecV: SEC_V,
      context: { hasResource: false, actorBranchId: null, isSensitivePermission: false },
    });
    expect(store.run).not.toHaveBeenCalled();
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
