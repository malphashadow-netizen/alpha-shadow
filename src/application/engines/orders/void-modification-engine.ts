/**
 * Void / modification engine (Phase 7, spec 2.4).
 *
 * Graded 3-level permissions (server / shift_supervisor / manager) read from
 * the existing permissions_registry through the existing authorization engine
 * — never a binary flag. Every void requires:
 *   (a) an ENABLED tenant_void_reason (its platform kind must not be disabled
 *       for the tenant — disabling keeps history but blocks new use);
 *   (b) if the actor's tier is below the reason's required tier, a
 *       MANAGER OVERRIDE verified by a LIVE PIN CHALLENGE at the exact moment
 *       of the void — a name picked from a list is never accepted. The
 *       approving manager must personally hold order:void:manager and the
 *       challenge timestamp is stored as override_authenticated_at evidence;
 *   (c) an 'open' payment status — a paid/refund_pending/refunded order is
 *       ALWAYS refused with PaymentReversalRequiredError (payments engine is
 *       a future phase; fail-closed, never an implicit allow);
 *   (d) the optional tenant void time limit (from the ITEM's created_at, not
 *       the order's placed_at) — after it, even a full-permission void is
 *       refused.
 *
 * The immutable order_voids row is written in the same transaction as the
 * item voiding, the outbox evidence and the order-status recompute.
 */
import { randomUUID } from 'node:crypto';
import type {
  ManagerOverrideAuthenticator,
  ManagerOverrideChallenge,
  OrderRecord,
  OrdersStore,
  OrdersTxScope,
  OrderVoidAuditRecord,
  VoidActor,
  VoidOrderInput,
  VoidOrderItemInput,
} from '../../../domain/contracts/orders.ts';
import { ORDER_VOID_PERMISSION_KEYS, VOID_PERMISSION_TIER_RANK } from '../../../domain/contracts/orders.ts';
import type { AuthorizationEngine } from '../rbac/authorization-engine.ts';
import {
  ManagerOverrideAuthenticationError,
  ManagerOverrideRequiredError,
  NotFoundError,
  ValidationError,
  VoidReasonUnavailableError,
  VoidTimeLimitExceededError,
} from '../../../shared/errors.ts';
import { assertVoidAllowedUnderPaymentStatus } from '../payments/index.ts';

export interface VoidModificationEngineDependencies {
  readonly store: OrdersStore;
  readonly authorization: Pick<AuthorizationEngine, 'check'>;
  /** The live manager-override PIN challenge port (never a name list). */
  readonly managerAuthenticator: ManagerOverrideAuthenticator;
}

interface VoidTarget {
  order: OrderRecord;
  orderItemId: string | null;
  itemCreatedAt: Date | null;
}

export class VoidModificationEngine {
  private readonly dependencies: VoidModificationEngineDependencies;

  constructor(dependencies: VoidModificationEngineDependencies) {
    this.dependencies = dependencies;
  }

  async voidOrderItem(tenantId: string, actor: VoidActor, input: VoidOrderItemInput): Promise<OrderVoidAuditRecord> {
    return this.voidWithinTenant(tenantId, actor, {
      resolveTarget: async (scope): Promise<VoidTarget> => {
        const item = await scope.loadOrderItem(tenantId, input.orderItemId);
        if (item === null) throw new NotFoundError(`Order item ${input.orderItemId} not found`);
        if (item.isVoided) throw new ValidationError(`Order item ${input.orderItemId} is already voided`);
        const order = await scope.loadOrder(tenantId, item.orderId);
        if (order === null) throw new NotFoundError(`Order ${item.orderId} not found`);
        return { order, orderItemId: item.id, itemCreatedAt: item.createdAt };
      },
      voidReasonId: input.voidReasonId,
      managerOverride: input.managerOverride,
      notes: input.notes,
    });
  }

  async voidOrder(tenantId: string, actor: VoidActor, input: VoidOrderInput): Promise<OrderVoidAuditRecord> {
    return this.voidWithinTenant(tenantId, actor, {
      resolveTarget: async (scope): Promise<VoidTarget> => {
        const order = await scope.loadOrder(tenantId, input.orderId);
        if (order === null) throw new NotFoundError(`Order ${input.orderId} not found`);
        return { order, orderItemId: null, itemCreatedAt: null };
      },
      voidReasonId: input.voidReasonId,
      managerOverride: input.managerOverride,
      notes: input.notes,
    });
  }

  private async voidWithinTenant(
    tenantId: string,
    actor: VoidActor,
    target: {
      resolveTarget: (scope: OrdersTxScope) => Promise<VoidTarget>;
      voidReasonId: string;
      managerOverride?: ManagerOverrideChallenge | undefined;
      notes?: string | undefined;
    },
  ): Promise<OrderVoidAuditRecord> {
    // Stage 1: the ACTOR must hold the base void permission through the full
    // three-stage engine (tenant guard, sec_v freshness, sensitive = no L1
    // cache). An override can raise the TIER, never replace the permission.
    await this.dependencies.authorization.check({
      tenantId,
      userId: actor.userId,
      permissionKey: ORDER_VOID_PERMISSION_KEYS.server,
      tokenSecV: actor.tokenSecV,
      context: { hasResource: false, actorBranchId: null, isSensitivePermission: true },
    });

    return this.dependencies.store.run(tenantId, async (scope) => {
      const { order, orderItemId, itemCreatedAt } = await target.resolveTarget(scope);

      // CRITICAL BRANCH — fail-closed payments placeholder: any void on a
      // non-open order is refused with the explicit PaymentReversalRequiredError
      // (the order_voids DB trigger enforces the same policy structurally).
      assertVoidAllowedUnderPaymentStatus(order.paymentStatus);

      const reason = await scope.loadVoidReason(tenantId, target.voidReasonId);
      if (reason === null || !reason.isEnabled || !reason.kindSettingEnabled) {
        throw new VoidReasonUnavailableError(target.voidReasonId);
      }

      // Optional time limit — counted from the ITEM's created_at (for an
      // order-level void the OLDEST active item governs: fail-closed).
      const limitMinutes = await scope.loadVoidTimeLimitMinutes(tenantId);
      if (limitMinutes !== null) {
        let governingCreatedAt: Date | null = itemCreatedAt;
        if (orderItemId === null) {
          const activeItems = await scope.loadActiveOrderItems(tenantId, order.id);
          let oldest: Date | null = null;
          for (const active of activeItems) {
            if (oldest === null || active.createdAt < oldest) oldest = active.createdAt;
          }
          governingCreatedAt = oldest;
        }
        if (governingCreatedAt !== null && Date.now() - governingCreatedAt.getTime() > limitMinutes * 60_000) {
          throw new VoidTimeLimitExceededError(governingCreatedAt, limitMinutes);
        }
      }

      // Graded tier check: the actor's tier comes from the held atomic keys.
      const actorTier = await scope.resolveVoidPermissionTier(tenantId, actor.userId);
      if (actorTier === null) {
        // Defensive: the authorization check above passed, so the grant
        // vanished mid-transaction — fail closed either way.
        throw new ManagerOverrideRequiredError(reason.requiredPermissionTier);
      }
      const requiredManagerOverride =
        VOID_PERMISSION_TIER_RANK[actorTier] < VOID_PERMISSION_TIER_RANK[reason.requiredPermissionTier];
      let managerUserId: string | null = null;
      let overrideAuthenticatedAt: Date | null = null;
      if (requiredManagerOverride) {
        const challenge = target.managerOverride;
        if (challenge === undefined) {
          throw new ManagerOverrideRequiredError(reason.requiredPermissionTier);
        }
        // LIVE CHALLENGE — never a name from a list: the approving manager
        // must be an active member, personally hold order:void:manager, and
        // pass their own separate PIN right now, at the moment of the void.
        if (!(await scope.userIsActiveMember(tenantId, challenge.managerUserId))) {
          throw new ManagerOverrideAuthenticationError('Manager override rejected: the approving manager is not an active member of the tenant');
        }
        const managerTier = await scope.resolveVoidPermissionTier(tenantId, challenge.managerUserId);
        if (managerTier !== 'manager') {
          throw new ManagerOverrideAuthenticationError('Manager override rejected: the approving manager does not hold the order:void:manager permission');
        }
        overrideAuthenticatedAt = await this.dependencies.managerAuthenticator.verifyLiveChallenge(
          tenantId,
          challenge.managerUserId,
          challenge.managerOverridePin,
        );
        managerUserId = challenge.managerUserId;
      }

      const record = await scope.insertOrderVoid(tenantId, {
        id: randomUUID(),
        orderId: order.id,
        orderItemId,
        actorUserId: actor.userId,
        actorPermissionTier: actorTier,
        voidReasonId: reason.id,
        requiredManagerOverride,
        managerUserId,
        overrideAuthenticatedAt,
        orderPaymentStatusAtVoidTime: order.paymentStatus,
        notes: target.notes ?? null,
      });

      // Void lifecycle + outbox evidence + derived order-status recompute —
      // all in this same transaction.
      const voidedItemIds: string[] = [];
      if (orderItemId !== null) {
        voidedItemIds.push(orderItemId);
      } else {
        for (const item of await scope.loadActiveOrderItems(tenantId, order.id)) voidedItemIds.push(item.id);
      }
      await scope.markOrderItemsVoided(tenantId, voidedItemIds);
      for (const itemId of voidedItemIds) {
        await scope.appendEvent(tenantId, order.branchId, 'order_item.voided', {
          order_id: order.id,
          order_item_id: itemId,
          void_record_id: record.id,
          actor_user_id: actor.userId,
        });
      }
      if (orderItemId === null) {
        await scope.appendEvent(tenantId, order.branchId, 'order.voided', {
          order_id: order.id,
          void_record_id: record.id,
          actor_user_id: actor.userId,
        });
      }
      await scope.recomputeOrderStatus(tenantId, order.id);

      return record;
    });
  }
}
