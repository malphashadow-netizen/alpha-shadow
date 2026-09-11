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
import { STOCK_QUANTITY_SCALE } from '../../../domain/contracts/inventory.ts';
import { decimalTextToMinor, minorToDecimalText } from '../../../shared/decimal-text.ts';

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
        // B9-a: an order-level void with no ACTIVE lines left is a repeat —
        // reject it (item-void parity: already-voided → ValidationError)
        // instead of writing an empty void record + a duplicate event.
        if ((await scope.loadActiveOrderItems(tenantId, order.id)).length === 0) {
          throw new ValidationError(`Order ${input.orderId} is already fully voided`);
        }
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
    return this.dependencies.store.run(tenantId, async (scope) => {
      const { order, orderItemId, itemCreatedAt } = await target.resolveTarget(scope);

      // Stage 1: the ACTOR must hold the base void permission through the full
      // three-stage engine (tenant guard, sec_v freshness, sensitive = no L1
      // cache). An override can raise the TIER, never replace the permission.
      await this.dependencies.authorization.check({
        tenantId,
        userId: actor.userId,
        permissionKey: ORDER_VOID_PERMISSION_KEYS.server,
        tokenSecV: actor.tokenSecV,
        context: { hasResource: true, actorBranchId: order.branchId, resourceBranchId: order.branchId, isSensitivePermission: true },
      });

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
      const actorTier = await scope.resolveVoidPermissionTier(tenantId, actor.userId, order.branchId);
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
        // The challenge is bound to the INITIATING ACTOR's identity (this
        // user, straight from the authorization check) so that repeated
        // guessing is counted and locked per employee, not per session.
        if (!(await scope.userIsActiveMember(tenantId, challenge.managerUserId))) {
          throw new ManagerOverrideAuthenticationError('Manager override rejected: the approving manager is not an active member of the tenant');
        }
        const managerTier = await scope.resolveVoidPermissionTier(tenantId, challenge.managerUserId, order.branchId);
        if (managerTier !== 'manager') {
          throw new ManagerOverrideAuthenticationError('Manager override rejected: the approving manager does not hold the order:void:manager permission');
        }
        overrideAuthenticatedAt = await this.dependencies.managerAuthenticator.verifyLiveChallenge(
          tenantId,
          challenge.managerUserId,
          challenge.managerOverridePin,
          actor.userId,
          'void',
          order.id,
        );
        managerUserId = challenge.managerUserId;
      }

      // B2: the order lock + revision bump serialize this void against every
      // concurrent mutation of the order (exactly one wins; the loser gets a
      // 40001 serialization failure (retryable: ConcurrencyRetryableError → 503). Positioned AFTER the
      // live challenge ON PURPOSE: the challenge runs in its own transaction
      // on a second connection, and its attempt row carries an FK to orders —
      // holding FOR UPDATE across it deadlocks the FK check in a way the
      // detector cannot see (this tx waits in JS, the challenge waits on the
      // lock) and hangs forever. Under REPEATABLE READ the late lock loses
      // nothing: any interleaved mutation bumped the row, so a stale void
      // still 40001s here, and the snapshot is identical before/after.
      const lockedOrder = await scope.lockOrder(tenantId, order.id);
      if (lockedOrder === null) throw new NotFoundError(`Order ${order.id} not found`);
      await scope.bumpOrderRevision(tenantId, order.id);

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
      // B11: no active lines left (a full order void, or the last line
      // falling to an item void) ⇒ the order is terminally 'voided' — never
      // 'open' ("re-collection required" would be a lie on a dead order).
      if ((await scope.loadActiveOrderItems(tenantId, order.id)).length === 0) {
        await scope.setOrderPaymentStatus(tenantId, order.id, 'voided');
      }
      // Phase-9 stock: restoration-or-waste per voided line, same transaction.
      await this.writeVoidStockMovements(scope, tenantId, order, voidedItemIds, actor.userId);
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

  /**
   * Phase-9 void stock: per voided line, restoration mirrors the RECORDED
   * sale deductions exactly (never recomputed from live recipes — immune to
   * recipe edits between sale and void) — but ONLY when the line never
   * entered a fires_kitchen_ticket state; a prepared line is waste (zero
   * delta, the consumed quantity stays consumed). Lines with no recorded
   * deductions (pre-Phase-9 orders, recipe-less lines) yield no rows at all.
   * Pairs already carrying a void_restoration row (a prior partial refund
   * came home first) are skipped: stock is restored exactly once per
   * (line, component), never twice.
   */
  private async writeVoidStockMovements(
    scope: OrdersTxScope,
    tenantId: string,
    order: OrderRecord,
    voidedItemIds: readonly string[],
    actorUserId: string,
  ): Promise<void> {
    if (voidedItemIds.length === 0) return;
    const deductions = await scope.loadSaleDeductionsForOrderItems(tenantId, voidedItemIds);
    if (deductions.length === 0) return;
    const fired = new Set(await scope.loadItemsWithKitchenTicketFired(tenantId, voidedItemIds));
    const restored = new Set(
      (await scope.loadVoidRestorationKeys(tenantId, voidedItemIds)).map((key) => `${key.orderItemId}:${key.inventoryItemId}`),
    );
    const occurredAt = new Date();
    for (const deduction of deductions) {
      if (restored.has(`${deduction.orderItemId}:${deduction.inventoryItemId}`)) continue;
      const restores = !fired.has(deduction.orderItemId);
      await scope.insertStockMovement(tenantId, {
        branchId: order.branchId,
        inventoryItemId: deduction.inventoryItemId,
        movementType: restores ? 'void_restoration' : 'waste_void',
        quantityDelta: restores
          ? minorToDecimalText(-decimalTextToMinor(deduction.totalDeducted, STOCK_QUANTITY_SCALE, 'totalDeducted'), STOCK_QUANTITY_SCALE)
          : minorToDecimalText(0n, STOCK_QUANTITY_SCALE),
        orderId: order.id,
        orderItemId: deduction.orderItemId,
        actorUserId,
        managerOverrideId: null,
        adjustmentReasonId: null,
        occurredAt,
      });
    }
  }
}
