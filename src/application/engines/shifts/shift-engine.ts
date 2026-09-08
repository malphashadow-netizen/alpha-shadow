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
import { nonNegativeDecimalTextToMinor, decimalTextToMinor, minorToDecimalText } from '../../../shared/decimal-text.ts';
import { ConflictError, NotFoundError, ShiftNotOpenError, ValidationError } from '../../../shared/errors.ts';

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

function validateCounts(lines: readonly CashCountLineInput[]): bigint {
  let totalMinor = 0n;
  for (const line of lines) {
    if (!Number.isInteger(line.quantity) || line.quantity < 0) {
      throw new ValidationError('Cash count quantity must be a non-negative integer', 'quantity');
    }
    const valueMinor = nonNegativeDecimalTextToMinor(line.denominationValue, 2, 'denominationValue');
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
    const floatMinor = validateCounts(input.openCounts);

    return this.dependencies.store.run(tenantId, async (scope) => {
      const branch = await scope.loadBranchForShift(tenantId, input.branchId);
      if (!branch?.isActive) {
        throw new NotFoundError(`Branch ${input.branchId} is not an active branch of tenant ${tenantId}`);
      }
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
        startingFloat: minorToDecimalText(floatMinor, 2),
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
    const countedMinor = validateCounts(input.closeCounts);

    return this.dependencies.store.run(tenantId, async (scope) => {
      const shift = await scope.loadShift(tenantId, input.shiftId);
      if (shift === null) throw new NotFoundError(`Shift ${input.shiftId} not found`);
      if (shift.status !== 'open') throw new ShiftNotOpenError(input.shiftId);
      for (const userId of [input.closedByUserId, input.closeVerifiedByUserId]) {
        if (!(await scope.userIsActiveMember(tenantId, userId))) {
          throw new ValidationError(`Shift close participant ${userId} is not an active member of the tenant`);
        }
      }
      const recordedCashSales = await scope.sumCompletedCashPaymentsText(tenantId, input.shiftId);
      const varianceMinor =
        countedMinor - nonNegativeDecimalTextToMinor(shift.startingFloat, 2, 'startingFloat') - decimalTextToMinor(recordedCashSales, 2, 'recordedCashSales');
      const varianceType: VarianceType = varianceMinor > 0n ? 'overage' : varianceMinor < 0n ? 'shortage' : 'exact';

      await scope.insertCashCountDetails(tenantId, input.shiftId, 'close', input.closeCounts);
      return scope.closeShiftRow(tenantId, input.shiftId, {
        closedById: input.closedByUserId,
        closeVerifiedById: input.closeVerifiedByUserId,
        closedAt: input.closedAt,
        countedCash: minorToDecimalText(countedMinor, 2),
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
      const counts = await scope.loadCashCounts(tenantId, shiftId);
      const recordedCashSales = await scope.sumCompletedCashPaymentsText(tenantId, shiftId);
      const recordedMinor = decimalTextToMinor(recordedCashSales, 2, 'recordedCashSales');
      const floatMinor = nonNegativeDecimalTextToMinor(shift.startingFloat, 2, 'startingFloat');
      const countedMinor =
        shift.countedCash === null
          ? counts.filter((c) => c.countType === 'close').reduce((sum, c) => sum + decimalTextToMinor(c.subtotal, 2, 'subtotal'), 0n)
          : nonNegativeDecimalTextToMinor(shift.countedCash, 2, 'countedCash');
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
        computedVariance: minorToDecimalText(varianceMinor, 2),
        computedVarianceType: varianceMinor > 0n ? 'overage' : varianceMinor < 0n ? 'shortage' : 'exact',
      };
    });
  }
}
