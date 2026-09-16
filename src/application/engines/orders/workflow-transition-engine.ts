/**
 * Workflow-transition engine (Phase 7, spec 2.1).
 *
 * Loads the tenant's EFFECTIVE sequence (enabled tenant_order_workflow_states
 * of the active workflow only) and rejects every transition outside it —
 * fail-closed, never a free-form state machine. Validation happens at three
 * levels: this engine (sequence semantics), the database validation trigger
 * (event integrity + enabled target + same tenant) and the FK chain.
 *
 * Transition rules (documented, deterministic):
 *   * both from-state and to-state must be ENABLED states of the tenant's
 *     active workflow;
 *   * a FORWARD move (to.position > from.position) is allowed — KDS bump
 *     semantics, skipping forward inside the sequence is legal;
 *   * moves INSIDE one kind family are allowed (top-level state ↔ its
 *     sub-states, sub-state ↔ sub-state of the same parent kind) so an item
 *     can sit in "preparing – waiting for ingredient" and come back to plain
 *     "preparing" when the ingredient arrives;
 *   * everything else — backward jumps, cross-family moves, disabled or
 *     foreign states — is rejected.
 *
 * Behavior is bound to the PLATFORM kind of the target state: the engine
 * returns the kind's fixed behavior_flags (fires_kitchen_ticket /
 * opens_payment_collection / notifies_customer / is_terminal /
 * is_financial_close) and the outbox event payload carries them so the
 * side-effect worker derives its work from the kind, never from a label.
 */
import type {
  ItemStatusTransitionInput,
  ItemStatusTransitionResult,
  OrdersStore,
  OrdersTxScope,
  OrderBehaviorFlags,
  TenantWorkflowState,
} from '../../../domain/contracts/orders.ts';
import type { AuthorizationEngine } from '../rbac/authorization-engine.ts';
import { NotFoundError, WorkflowTransitionError } from '../../../shared/errors.ts';

/** Audit F-D: the human-actor key for item transitions (migration 0055). Non-sensitive → L1-cached. */
const ITEM_TRANSITION_PERMISSION_KEY = 'order:item:transition';

export interface WorkflowTransitionEngineDependencies {
  readonly store: OrdersStore;
  /** Audit F-D/DD-003: the authorization gate. `check` now runs branch-aware, after the read-only item/order load but strictly before the first write (bumpOrderRevision). */
  readonly authorization: Pick<AuthorizationEngine, 'check'>;
}

function isFamilyMove(from: TenantWorkflowState, to: TenantWorkflowState): boolean {
  if (from.parentKindCode === null && to.parentKindCode === null) return false;
  if (from.parentKindCode !== null && to.parentKindCode !== null) {
    return from.parentKindCode === to.parentKindCode;
  }
  // Top-level ↔ its own sub-state (a sub-state's kind IS its parent kind).
  if (from.parentKindCode === null) return to.parentKindCode === from.kindCode;
  return from.parentKindCode === to.kindCode;
}

/** Pure decision function (unit-testable): may the item move from → to? */
export function isTransitionAllowed(from: TenantWorkflowState, to: TenantWorkflowState): boolean {
  if (from.id === to.id) return false;
  if (!from.isEnabled || !to.isEnabled) return false;
  return to.position > from.position || isFamilyMove(from, to);
}

/**
 * Inserts the status event inside an OPEN scope and returns the exact outbox
 * sequence of the durable 'order_item.status_changed' row written by the
 * apply_order_item_status trigger in the SAME transaction (invariant: no
 * broadcast without a permanent record).
 */
export async function appendItemStatusEvent(
  scope: OrdersTxScope,
  tenantId: string,
  input: { orderItemId: string; orderId: string; branchId: string; fromWorkflowStateId: string | null; toWorkflowStateId: string; actorUserId: string | null; occurredAt: Date },
): Promise<number> {
  const before = await scope.lastOutboxSequence(tenantId, input.branchId);
  await scope.insertStatusEvent(tenantId, {
    orderItemId: input.orderItemId,
    orderId: input.orderId,
    fromWorkflowStateId: input.fromWorkflowStateId,
    toWorkflowStateId: input.toWorkflowStateId,
    actorUserId: input.actorUserId,
    occurredAt: input.occurredAt,
  });
  const fresh = await scope.readOutboxEvents(tenantId, input.branchId, before, 64);
  const evidence = fresh.find(
    (e) => e.eventType === 'order_item.status_changed' && e.payload['order_item_id'] === input.orderItemId,
  );
  if (evidence === undefined) {
    throw new WorkflowTransitionError('The status change did not materialize a durable outbox row in the same transaction');
  }
  return evidence.sequenceId;
}

/**
 * Audit F-D — DEVICE-PATH DEFERRAL CONTRACT (not implemented):
 * this engine gates HUMAN actors only, via `order:item:transition`. The KDS
 * device intent path (a screen bumping its own ticket) is a DIFFERENT
 * credential type and is deliberately NOT a registry key: RBAC grants are
 * user-anchored (`user_roles`) and cannot express device grants. When the
 * device path is built, the device NEVER merges with the human key —
 * verification happens INSIDE this engine through an injected
 * `KdsDeviceEngine.verifyDeviceToken` port, and the branch-equality rule
 * (`order.branchId == token.branchId`) is enforced at the exact place where
 * this engine learns the order's branch (right after `lockOrder` below).
 */
export class WorkflowTransitionEngine {
  private readonly dependencies: WorkflowTransitionEngineDependencies;

  constructor(dependencies: WorkflowTransitionEngineDependencies) {
    this.dependencies = dependencies;
  }

  async transitionItem(tenantId: string, input: ItemStatusTransitionInput): Promise<ItemStatusTransitionResult> {
    return this.dependencies.store.run(tenantId, async (scope) => {
      // B2: resolve the order id, then lock FIRST and re-read under the lock.
      // The order lock + revision bump serialize every concurrent mutation of
      // this order (exactly one wins; the loser gets a 40001 serialization
      // failure; retryable as ConcurrencyRetryableError → 503).
      //
      // Audit F-D/DD-003: the gate can no longer run before any store call —
      // the trusted resource branch is the ORDER's branch, only known after
      // loading the item and locking its order. Both reads below are
      // read-only and run BEFORE the gate; `bumpOrderRevision` (the first
      // actual write) runs strictly AFTER the gate passes. A missing
      // item/order is never disclosed to a branch-scoped caller who lacks
      // even a tenant-wide grant: the probe check reuses the SAME
      // tenant-wide (branchless) context, so the resulting ForbiddenError is
      // identical in shape to a genuine cross-branch denial (DD-003
      // non-disclosure requirement).
      const probe = await scope.loadOrderItem(tenantId, input.orderItemId);
      if (probe === null) {
        await this.dependencies.authorization.check({
          tenantId,
          userId: input.actorUserId,
          permissionKey: ITEM_TRANSITION_PERMISSION_KEY,
          tokenSecV: input.tokenSecV,
          context: { hasResource: false, actorBranchId: null, isSensitivePermission: false },
        });
        throw new NotFoundError(`Order item ${input.orderItemId} not found`);
      }
      const order = await scope.lockOrder(tenantId, probe.orderId);
      if (order === null) {
        await this.dependencies.authorization.check({
          tenantId,
          userId: input.actorUserId,
          permissionKey: ITEM_TRANSITION_PERMISSION_KEY,
          tokenSecV: input.tokenSecV,
          context: { hasResource: false, actorBranchId: null, isSensitivePermission: false },
        });
        throw new NotFoundError(`Order ${probe.orderId} not found`);
      }
      // Audit F-D/DD-003: branch-aware gate — the ORDER's own trusted branch
      // is both the actor's relevant branch and the resource branch. Runs
      // BEFORE the first write (bumpOrderRevision).
      await this.dependencies.authorization.check({
        tenantId,
        userId: input.actorUserId,
        permissionKey: ITEM_TRANSITION_PERMISSION_KEY,
        tokenSecV: input.tokenSecV,
        context: { hasResource: true, actorBranchId: order.branchId, resourceBranchId: order.branchId, isSensitivePermission: false },
      });
      await scope.bumpOrderRevision(tenantId, order.id);
      const item = await scope.loadOrderItem(tenantId, input.orderItemId);
      if (item === null) throw new NotFoundError(`Order item ${input.orderItemId} not found`);
      if (item.isVoided) {
        throw new WorkflowTransitionError(`Order item ${input.orderItemId} is voided; voided items no longer transition`);
      }

      const states = await scope.loadWorkflowStates(tenantId, true);
      const fromState = states.find((s) => s.id === item.currentStatusKindId);
      const toState = states.find((s) => s.id === input.toWorkflowStateId);
      if (toState === undefined) {
        // Covers: unknown id, another tenant's state (RLS hides it), a state
        // of an inactive workflow, and a DISABLED state — none of them are
        // part of the tenant's effective sequence.
        throw new WorkflowTransitionError(
          `Target state ${input.toWorkflowStateId} is not part of tenant ${tenantId}'s enabled workflow sequence`,
        );
      }
      if (fromState === undefined) {
        // The item sits on a state disabled after the fact — its history is
        // kept, but no NEW transition may depart from it.
        throw new WorkflowTransitionError(
          `Current state ${item.currentStatusKindId} of item ${input.orderItemId} is no longer enabled; no new transitions may depart from it`,
        );
      }
      if (!isTransitionAllowed(fromState, toState)) {
        throw new WorkflowTransitionError(
          `Transition ${fromState.kindCode}@${fromState.position} → ${toState.kindCode}@${toState.position} is outside the tenant's enabled workflow sequence`,
        );
      }

      const behaviorFlags: OrderBehaviorFlags = await scope.loadOrderStatusKindFlags(toState.kindCode);
      const outboxSequenceId = await appendItemStatusEvent(scope, tenantId, {
        orderItemId: item.id,
        orderId: order.id,
        branchId: order.branchId,
        fromWorkflowStateId: fromState.id,
        toWorkflowStateId: toState.id,
        actorUserId: input.actorUserId,
        // Audit F-B: input.occurredAt is ignored — the server clock stamps every transition.
        occurredAt: new Date(),
      });
      return {
        orderItemId: item.id,
        fromWorkflowStateId: fromState.id,
        toWorkflowStateId: toState.id,
        behaviorFlags,
        outboxSequenceId,
      };
    });
  }
}
