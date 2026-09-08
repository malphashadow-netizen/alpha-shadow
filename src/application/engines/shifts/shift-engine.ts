/**
 * Shift engine (Phase 8) — open, Z-Report close, X-Report read.
 *
 * openShift — THE atomic open: the open cash count AND the dual verification
 * must BOTH be complete before anything is written; one transaction then
 * inserts the shift row (directly as status='open') together with its 'open'
 * cash_count_details rows. starting_float is computed from the count and the
 * deferred DB trigger re-verifies the sum at commit. One person can never
 * hold both the opener and the verifier role (DB CHECK + engine validation),
 * and a cashier can never hold two open shifts (partial unique index).
 *
 * closeShift — THE Z Report, the only official close and the only writer of
 * the close columns: counted_cash from the close count, recorded_cash_sales
 * from the completed cash payments on the shift (verified structurally by the
 * upgraded validate_shift_reconciliation trigger), variance as the generated
 * column counted − float − recorded, variance_type derived from its sign.
 * After the close the row is immutable (DB trigger). Rejects a close where
 * closer and verifier are the same person.
 *
 * xReport — READ ONLY: no writes, no resets. Returns the live shift row, its
 * counts and the live cash-sales figure; the stored close columns stay NULL
 * until the Z Report.
 */

import { randomUUID } from 'node:crypto';
import type {
  CashCountLineInput,
  CloseShiftInput,
  OpenShiftInput,
  ShiftRecord,
  ShiftsStore,
  VarianceType,
} from '../../../domain/contracts/payments.ts';
import { nonNegativeDecimalTextToMinor, decimalTextToMinor, minorToDecimalText, storageMinorUnitDigits } from '../../../shared/decimal-text.ts';
import { ConflictError, NotFoundError, ShiftNotOpenError, ValidationError } from '../../../shared/errors.ts';
import { currencyCode } from '../../../shared/money.ts';

export interface XReport {
  readonly shift: ShiftRecord;
  readonly counts: readonly {
    readonly countType: 'open' | 'close';
    readonly denominationValue: string;
    readonly quantity: number;
    readonly subtotal: string;
  }[];
  /** Live figure (NULL on the row until the Z Report): completed cash sales so far. */
  readonly recordedCashSales: string;
  readonly computedVariance: string | null;
  readonly computedVarianceType: VarianceType | null;
}

/**
 * B1: cash counts are denominated in the branch base currency at `digits (its
 * ISO minor-unit scale). Denominations are discrete physical values stored
 * VERBATIM, so a fraction longer than the native scale is rejected outright —
 * never silently rounded (rounding a stored-verbatim value would desync the
 * deferred SUM trigger that re-verifies the float at commit).
 */
function assertNativeDenominationScale(text: string, digits: number): void {
  const dot = text.indexOf('.');
  const fractionDigits = dot === -1 ? 0 : text.length - dot - 1;
  if (fractionDigits > digits) {
    throw new ValidationError(
      `Cash denomination "${text}" carries more fraction digits than the branch currency's minor-unit scale (${String(digits)})`,
      'denominationValue',
    );
  }
}

function validateCounts(lines: readonly CashCountLineInput[], digits: number): bigint {
  let totalMinor = 0n;
  for (const line of lines) {
    if (!Number.isInteger(line.quantity) || line.quantity < 0) {
      throw new ValidationError('Cash count quantity must be a non-negative integer', 'quantity');
    }
    assertNativeDenominationScale(line.denominationValue, digits);
    const valueMinor = nonNegativeDecimalTextToMinor(line.denominationValue, digits, 'denominationValue');
    if (valueMinor <= 0n) throw new ValidationError('Denomination value must be greater than zero', 'denominationValue');
    totalMinor += valueMinor * BigInt(line.quantity);
  }
  return totalMinor;
}

export class ShiftEngine {
  private readonly dependencies: { readonly store: ShiftsStore };

  constructor(dependencies: { readonly store: ShiftsStore }) {
    this.dependencies = dependencies;
  }

  async openShift(tenantId: string, input: OpenShiftInput): Promise<ShiftRecord> {
    if (input.openedByUserId === input.openVerifiedByUserId) {
      throw new ValidationError('The shift opener and the open verifier must be two DIFFERENT people (dual verification)');
    }

    return this.dependencies.store.run(tenantId, async (scope) => {
      const branch = await scope.loadBranchForShift(tenantId, input.branchId);
      if (!branch?.isActive) {
        throw new NotFoundError(`Branch ${input.branchId} is not an active branch of tenant ${tenantId}`);
      }
      // B1: the count scale is the branch base currency's own ISO scale.
      const digits = storageMinorUnitDigits(currencyCode(branch.baseCurrencyCode));
      const floatMinor = validateCounts(input.openCounts, digits);
      for (const userId of [input.cashierUserId, input.openedByUserId, input.openVerifiedByUserId]) {
        if (!(await scope.userIsActiveMember(tenantId, userId))) {
          throw new ValidationError(`Shift participant ${userId} is not an active member of the tenant`);
        }
      }
      const existing = await scope.findAnyOpenShiftForCashier(tenantId, input.cashierUserId);
      if (existing !== null) {
        throw new ConflictError('The cashier already holds an open shift (parallel shifts are forbidden)');
      }
      const shift = await scope.insertShift(tenantId, {
        id: randomUUID(),
        branchId: input.branchId,
        cashierId: input.cashierUserId,
        openedById: input.openedByUserId,
        openVerifiedById: input.openVerifiedByUserId,
        openedAt: input.openedAt,
        startingFloat: minorToDecimalText(floatMinor, digits),
      });
      await scope.insertCashCountDetails(tenantId, shift.id, 'open', input.openCounts);
      return shift;
    });
  }

  /** The Z Report — the ONLY official close. */
  async closeShift(tenantId: string, input: CloseShiftInput): Promise<ShiftRecord> {
    if (input.closedByUserId === input.closeVerifiedByUserId) {
      throw new ValidationError('The shift closer and the close verifier must be two DIFFERENT people (dual verification)');
    }

    return this.dependencies.store.run(tenantId, async (scope) => {
      // B2: lock FIRST, then decide. The shift lock + revision bump serialize
      // close-vs-close and close-vs-collect (uniform order: orders → shifts;
      // collect takes the order lock first, so no cycle is possible): exactly
      // one wins, the loser gets a 40001 serialization failure (retryable as
      // ConcurrencyRetryableError → 503), and the Z-Report SUM below can never
      // miss a concurrent payment.
      const shift = await scope.lockShift(tenantId, input.shiftId);
      if (shift === null) throw new NotFoundError(`Shift ${input.shiftId} not found`);
      await scope.bumpShiftRevision(tenantId, input.shiftId);
      if (shift.status !== 'open') throw new ShiftNotOpenError(input.shiftId);
      const branch = await scope.loadBranchForShift(tenantId, shift.branchId);
      if (branch === null) throw new NotFoundError(`Branch ${shift.branchId} is not a branch of tenant ${tenantId}`);
      // Digits only: a branch deactivated mid-shift still closes its open
      // shift (B1 preserves the close path; only the scale is derived here).
      const digits = storageMinorUnitDigits(currencyCode(branch.baseCurrencyCode));
      const countedMinor = validateCounts(input.closeCounts, digits);
      for (const userId of [input.closedByUserId, input.closeVerifiedByUserId]) {
        if (!(await scope.userIsActiveMember(tenantId, userId))) {
          throw new ValidationError(`Shift close participant ${userId} is not an active member of the tenant`);
        }
      }
      const recordedCashSales = await scope.sumCompletedCashPaymentsText(tenantId, input.shiftId);
      const varianceMinor =
        countedMinor - nonNegativeDecimalTextToMinor(shift.startingFloat, digits, 'startingFloat') - decimalTextToMinor(recordedCashSales, digits, 'recordedCashSales');
      const varianceType: VarianceType = varianceMinor > 0n ? 'overage' : varianceMinor < 0n ? 'shortage' : 'exact';

      await scope.insertCashCountDetails(tenantId, input.shiftId, 'close', input.closeCounts);
      return scope.closeShiftRow(tenantId, input.shiftId, {
        closedById: input.closedByUserId,
        closeVerifiedById: input.closeVerifiedByUserId,
        closedAt: input.closedAt,
        countedCash: minorToDecimalText(countedMinor, digits),
        recordedCashSales,
        varianceType,
        notes: input.notes,
      });
    });
  }

  /** The X Report — READ ONLY (no writes, no resets, ever). */
  async xReport(tenantId: string, shiftId: string): Promise<XReport> {
    return this.dependencies.store.run(tenantId, async (scope) => {
      const shift = await scope.loadShift(tenantId, shiftId);
      if (shift === null) throw new NotFoundError(`Shift ${shiftId} not found`);
      const branch = await scope.loadBranchForShift(tenantId, shift.branchId);
      if (branch === null) throw new NotFoundError(`Branch ${shift.branchId} is not a branch of tenant ${tenantId}`);
      const digits = storageMinorUnitDigits(currencyCode(branch.baseCurrencyCode));
      const counts = await scope.loadCashCounts(tenantId, shiftId);
      const recordedCashSales = await scope.sumCompletedCashPaymentsText(tenantId, shiftId);
      const recordedMinor = decimalTextToMinor(recordedCashSales, digits, 'recordedCashSales');
      const floatMinor = nonNegativeDecimalTextToMinor(shift.startingFloat, digits, 'startingFloat');
      const countedMinor =
        shift.countedCash === null
          ? counts.filter((c) => c.countType === 'close').reduce((sum, c) => sum + decimalTextToMinor(c.subtotal, digits, 'subtotal'), 0n)
          : nonNegativeDecimalTextToMinor(shift.countedCash, digits, 'countedCash');
      const varianceMinor = countedMinor - floatMinor - recordedMinor;
      return {
        shift,
        counts: counts.map((c) => ({
          countType: c.countType,
          denominationValue: c.denominationValue,
          quantity: c.quantity,
          subtotal: c.subtotal,
        })),
        recordedCashSales,
        computedVariance: minorToDecimalText(varianceMinor, digits),
        computedVarianceType: varianceMinor > 0n ? 'overage' : varianceMinor < 0n ? 'shortage' : 'exact',
      };
    });
  }
}
