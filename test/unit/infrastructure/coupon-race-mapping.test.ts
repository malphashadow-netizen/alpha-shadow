/**
 * P2 coupon race: the store-layer classifier that turns a trigger-level
 * coupon-EXPIRY rejection (SQLSTATE 23514) into the cashier-safe 409
 * `CouponAvailabilityRaceError` must be *surgical* (D9 discipline): `23514`
 * alone is not enough, because the same state carries the sibling coupon
 * rejections (inactive, max uses, below minimum), the cap/authority gates,
 * and the order_discounts CHECKs. Only a `23514` whose message begins with
 * the trigger's pinned text may be translated; every other shape — including
 * an expiry-looking message on a *different* SQLSTATE — must pass through
 * untouched (fail-closed: siblings keep alarming as 500).
 *
 * This is a pure unit test: the classifier operates on synthetic
 * `{ code, message }` objects, no database is touched.
 */
import { describe, expect, it } from 'vitest';

import {
  COUPON_EXPIRED_MESSAGE_PREFIX,
  isCouponExpiredTriggerError,
} from '../../../src/infrastructure/db/repositories/postgres-payments-store.ts';

describe('P2 isCouponExpiredTriggerError classifier (unit)', () => {
  it('matches ONLY code 23514 + the stable 0034/0036 text', () => {
    expect(COUPON_EXPIRED_MESSAGE_PREFIX).toBe('coupon is expired');
    expect(isCouponExpiredTriggerError({ code: '23514', message: 'coupon is expired' })).toBe(true);
  });

  it('rejects the sibling coupon rejections (each keeps alarming as 500)', () => {
    expect(
      isCouponExpiredTriggerError({ code: '23514', message: 'coupon discount requires an active coupon of the same tenant' }),
    ).toBe(false);
    expect(isCouponExpiredTriggerError({ code: '23514', message: 'coupon has reached its maximum uses' })).toBe(false);
    expect(isCouponExpiredTriggerError({ code: '23514', message: 'order subtotal is below the coupon minimum' })).toBe(false);
    expect(
      isCouponExpiredTriggerError({ code: '23514', message: 'percentage discount exceeds the actor\'s cap and was not manager-approved' }),
    ).toBe(false);
  });

  it('rejects the same text on any other SQLSTATE', () => {
    expect(isCouponExpiredTriggerError({ code: '23505', message: 'coupon is expired' })).toBe(false);
    expect(isCouponExpiredTriggerError({ code: '40001', message: 'coupon is expired' })).toBe(false);
    expect(isCouponExpiredTriggerError({ code: '42501', message: 'coupon is expired' })).toBe(false);
  });

  it('fails closed on shapeless inputs', () => {
    expect(isCouponExpiredTriggerError({ code: '23514' })).toBe(false);
    expect(isCouponExpiredTriggerError(null)).toBe(false);
    expect(isCouponExpiredTriggerError('coupon is expired')).toBe(false);
  });
});
