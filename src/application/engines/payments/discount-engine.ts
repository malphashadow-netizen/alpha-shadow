/**
 * Discount engine (Phase 8) — applies ONE order_discounts row per call.
 *
 * The binding pseudocode (steps 2–4) runs against the CURRENT remaining
 * subtotal (subtotal − Σ already-applied discounts), so stacked applications
 * naturally follow the mandated coupon → manual → points order: each call
 * re-runs 2–4 against what is left.
 *
 * Authority model (fail-closed):
 *   1. The actor must hold the atomic key order:discount:apply through the
 *      standard three-stage authorization engine (roles; sensitive ⇒ never
 *      cached).
 *   2. The actor's per-user dynamic caps (user_discount_limits) must grant
 *      the REQUESTED KIND: a NULL cap dimension is NOT granted and NOT
 *      overridable (NULL + NULL = no discount authority at all).
 *   3. A discount that zeroes out the remaining subtotal ALWAYS requires a
 *      manager override; so does a requested value above the actor's cap.
 *      The override is the Phase-7b LIVE PIN challenge, UNMODIFIED — the
 *      approving manager must personally hold order:discount:apply and pass
 *      their own PIN right now; the successful attempt id (bound to this
 *      actor and order) is recorded on the row and re-verified by the DB
 *      trigger.
 *
 * Loyalty points: the 'points' mechanism is reserved vocabulary; the loyalty
 * engine itself is a deliberately deferred phase — applying one is the
 * explicit LoyaltyPointsDeferredError, never a silent zero.
 */

import { randomUUID } from 'node:crypto';
import type {
  CouponRecord,
  DiscountKind,
  DiscountMechanism,
  ManagerOverrideChallengeInput,
  OrderDiscountRecord,
  PaymentActor,
  PaymentsStore,
} from '../../../domain/contracts/payments.ts';
import type { ManagerOverrideAuthenticator } from '../../../domain/contracts/orders.ts';
import type { AuthorizationEngine } from '../rbac/authorization-engine.ts';
import {
  dbpsToPercentText,
  minorToDecimalText,
  nonNegativeDecimalTextToMinor,
  percentTextToDbps,
} from '../../../shared/decimal-text.ts';
import {
  CouponUnavailableError,
  DiscountAuthorityMissingError,
  DiscountOverrideRequiredError,
  LoyaltyPointsDeferredError,
  ManagerOverrideAuthenticationError,
  NotFoundError,
  ValidationError,
} from '../../../shared/errors.ts';
import { currencyCode, minorUnitScale } from '../../../shared/money.ts';
import { computeDiscountStage, discountOverrideRequirement, parseDiscountCaps, parseDiscountRequest } from './discount-math.ts';
import { computeOrderTotals } from './order-totals.ts';

const DISCOUNT_PERMISSION_KEY = 'order:discount:apply';

export interface DiscountEngineDependencies {
  readonly store: PaymentsStore;
  readonly authorization: Pick<AuthorizationEngine, 'check'>;
  /** The Phase-7b live manager-override PIN challenge port (unmodified). */
  readonly managerAuthenticator: ManagerOverrideAuthenticator;
}

export interface ApplyDiscountInput {
  readonly orderId: string;
  readonly mechanism: DiscountMechanism;
  readonly discountKind: DiscountKind;
  /** NUMERIC(18,4) text: percent for 'percentage', base-currency amount for 'fixed_amount'. */
  readonly discountValueText: string;
  /** Required for mechanism='coupon' (the code as typed at the terminal). */
  readonly couponCode?: string;
  /** The live manager override (required when the pseudocode demands escalation). */
  readonly managerOverride?: ManagerOverrideChallengeInput;
}

export class DiscountEngine {
  private readonly dependencies: DiscountEngineDependencies;

  constructor(dependencies: DiscountEngineDependencies) {
    this.dependencies = dependencies;
  }

  async applyDiscount(tenantId: string, actor: PaymentActor, input: ApplyDiscountInput): Promise<OrderDiscountRecord> {
    if (input.mechanism === 'points') {
      // Reserved vocabulary, deliberately deferred — fail closed, loudly.
      throw new LoyaltyPointsDeferredError();
    }

    // Stage 1 — the atomic permission key (sensitive: never cached).
    await this.dependencies.authorization.check({
      tenantId,
      userId: actor.userId,
      permissionKey: DISCOUNT_PERMISSION_KEY,
      tokenSecV: actor.tokenSecV,
      context: { hasResource: false, actorBranchId: null, isSensitivePermission: true },
    });

    // Pre-computation read pass: decide whether an override is needed BEFORE
    // the live challenge (the challenge commits its own transaction, so it
    // must happen before the write transaction's snapshot is taken).
    const pre = await this.dependencies.store.run(tenantId, async (scope) => {
      const snapshot = await scope.loadOrderFinancialSnapshot(tenantId, input.orderId);
      if (snapshot === null) throw new NotFoundError(`Order ${input.orderId} not found`);
      const baseDigits = minorUnitScale(currencyCode(snapshot.baseCurrencyCode));
      const totals = computeOrderTotals(snapshot);
      const remainingSubtotal = totals.subtotalMinor - totals.discountTotalMinor;
      const request = parseDiscountRequest(input.discountKind, input.discountValueText, baseDigits);
      const capsRow = await scope.loadUserDiscountCaps(tenantId, actor.userId);
      const caps = parseDiscountCaps(capsRow?.maxDiscountPercentage ?? null, capsRow?.maxDiscountFixedAmount ?? null, baseDigits);
      assertKindGranted(input.discountKind, caps);
      const stage = computeDiscountStage(remainingSubtotal, request);
      const requirement = discountOverrideRequirement(stage, request, caps);
      const coupon = input.mechanism === 'coupon' ? await scope.loadCouponByCode(tenantId, mustCouponCode(input)) : null;
      return { baseDigits, caps, requirement, coupon };
    });

    // Escalation (step 4): the live Phase-7b challenge, when demanded.
    let challenged = false;
    if (pre.requirement.required) {
      const challenge = input.managerOverride;
      if (challenge === undefined) {
        throw new DiscountOverrideRequiredError(pre.requirement.reason ?? 'zeroes_out_subtotal');
      }
      // The approving manager must personally hold the discount permission —
      // a live PIN alone is an authentication, not an authorization.
      try {
        await this.dependencies.authorization.check({
          tenantId,
          userId: challenge.managerUserId,
          permissionKey: DISCOUNT_PERMISSION_KEY,
          context: { hasResource: false, actorBranchId: null, isSensitivePermission: true },
        });
      } catch (error: unknown) {
        throw new ManagerOverrideAuthenticationError(
          'Manager override rejected: the approving manager does not hold the order:discount:apply permission',
          { cause: error instanceof Error ? error : undefined },
        );
      }
      await this.dependencies.managerAuthenticator.verifyLiveChallenge(
        tenantId,
        challenge.managerUserId,
        challenge.managerOverridePin,
        actor.userId,
        input.orderId,
      );
      challenged = true;
    }

    return this.dependencies.store.run(tenantId, async (scope) => {
      // FRESH re-computation (the write transaction's own snapshot): the
      // order may have changed since the pre-pass.
      const snapshot = await scope.loadOrderFinancialSnapshot(tenantId, input.orderId);
      if (snapshot === null) throw new NotFoundError(`Order ${input.orderId} not found`);
      const totals = computeOrderTotals(snapshot);
      const remainingSubtotal = totals.subtotalMinor - totals.discountTotalMinor;
      const request = parseDiscountRequest(input.discountKind, input.discountValueText, pre.baseDigits);
      const stage = computeDiscountStage(remainingSubtotal, request);
      const requirement = discountOverrideRequirement(stage, request, pre.caps);
      if (requirement.required && !challenged) {
        // The order grew since the pre-pass and now demands escalation that
        // was never challenged — fail closed.
        throw new DiscountOverrideRequiredError(requirement.reason ?? 'zeroes_out_subtotal');
      }

      let couponId: string | null = null;
      if (input.mechanism === 'coupon') {
        const coupon = await scope.loadCouponByCode(tenantId, mustCouponCode(input));
        if (coupon === null) throw new CouponUnavailableError(mustCouponCode(input), 'unknown code');
        assertCouponUsable(coupon, totals.subtotalMinor, pre.baseDigits);
        couponId = coupon.id;
      }

      let managerOverrideAttemptId: string | null = null;
      if (requirement.required) {
        const challenge = input.managerOverride;
        if (challenge === undefined) throw new DiscountOverrideRequiredError(requirement.reason ?? 'zeroes_out_subtotal');
        managerOverrideAttemptId = await scope.findSuccessfulOverrideAttemptId(tenantId, {
          actorUserId: actor.userId,
          managerUserId: challenge.managerUserId,
          orderId: input.orderId,
        });
        if (managerOverrideAttemptId === null) {
          throw new ValidationError('The manager override succeeded but its attempt evidence could not be found (fail closed)');
        }
      }

      const record = await scope.insertOrderDiscount(tenantId, {
        id: randomUUID(),
        orderId: input.orderId,
        mechanism: input.mechanism,
        couponId,
        discountKind: input.discountKind,
        discountValue: canonicalValueText(input.discountKind, input.discountValueText),
        discountAmountApplied: minorToDecimalText(stage.appliedMinor, 2),
        requiredManagerOverride: requirement.required,
        managerOverrideAttemptId,
        appliedBy: actor.userId,
      });
      if (couponId !== null) {
        await scope.incrementCouponUses(tenantId, couponId);
      }
      return record;
    });
  }
}

function mustCouponCode(input: ApplyDiscountInput): string {
  const code = input.couponCode;
  if (code === undefined || code.trim() === '') {
    throw new ValidationError('A coupon discount requires the coupon code', 'couponCode');
  }
  return code.trim();
}

function assertKindGranted(kind: DiscountKind, caps: { maxPercentDbps: bigint | null; maxFixedAmountMinor: bigint | null }): void {
  if (kind === 'percentage' && caps.maxPercentDbps === null) throw new DiscountAuthorityMissingError('percentage');
  if (kind === 'fixed_amount' && caps.maxFixedAmountMinor === null) throw new DiscountAuthorityMissingError('fixed_amount');
}

function assertCouponUsable(coupon: CouponRecord, subtotalMinor: bigint, baseDigits: number): void {
  if (!coupon.isActive) throw new CouponUnavailableError(coupon.code, 'inactive');
  if (coupon.expiresAt !== null && coupon.expiresAt.getTime() <= Date.now()) throw new CouponUnavailableError(coupon.code, 'expired');
  if (coupon.maxUses !== null && coupon.usesCount >= coupon.maxUses) throw new CouponUnavailableError(coupon.code, 'maximum uses reached');
  if (coupon.minOrderAmount !== null) {
    const minMinor = nonNegativeDecimalTextToMinor(coupon.minOrderAmount, baseDigits, 'minOrderAmount');
    if (subtotalMinor < minMinor) throw new CouponUnavailableError(coupon.code, 'order subtotal is below the coupon minimum');
  }
}

/** NUMERIC(18,4) canonical text for the stored requested value. */
function canonicalValueText(kind: DiscountKind, valueText: string): string {
  if (kind === 'percentage') {
    return dbpsToPercentText(percentTextToDbps(valueText));
  }
  return minorToDecimalText(nonNegativeDecimalTextToMinor(valueText, 4, 'discountValue'), 4);
}
