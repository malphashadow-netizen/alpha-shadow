/**
 * PostgreSQL adapter for the Phase-8 shifts ports
 * (domain/contracts/payments.ts — ShiftsStore).
 *
 * Every use case runs in ONE withTenantContext() transaction (repeatable
 * read, tenant existence verified): the atomic open (shift row + open count
 * details) and the Z-Report close (close count details + the single close
 * UPDATE) each commit or roll back together. This class never imports pg; it
 * only receives the transaction-scoped TenantQuery.
 */
import type {
  CashCountDetailRecord,
  CashCountLineInput,
  CashCountType,
  CloseShiftInput,
  OpenShiftInput,
  ShiftRecord,
  ShiftsStore,
  ShiftsTxScope,
  VarianceType,
} from '../../../domain/contracts/payments.ts';
import type { WithTenantContext, TenantQuery } from '../tenant-context.ts';

interface ShiftRow {
  id: string;
  tenant_id: string;
  branch_id: string;
  cashier_id: string;
  opened_by_id: string;
  open_verified_by_id: string;
  opened_at: Date;
  starting_float: string;
  status: 'open' | 'closed';
  closed_by_id: string | null;
  close_verified_by_id: string | null;
  closed_at: Date | null;
  counted_cash: string | null;
  recorded_cash_sales: string | null;
  variance: string | null;
  variance_type: VarianceType | null;
  notes: string | null;
  created_at: Date;
}

interface CashCountRow {
  id: string;
  tenant_id: string;
  shift_reconciliation_id: string;
  count_type: CashCountType;
  denomination_value: string;
  quantity: number;
  subtotal: string;
  created_at: Date;
}

function mapShift(r: ShiftRow): ShiftRecord {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    branchId: r.branch_id,
    cashierId: r.cashier_id,
    openedById: r.opened_by_id,
    openVerifiedById: r.open_verified_by_id,
    openedAt: r.opened_at,
    startingFloat: r.starting_float,
    status: r.status,
    closedById: r.closed_by_id,
    closeVerifiedById: r.close_verified_by_id,
    closedAt: r.closed_at,
    countedCash: r.counted_cash,
    recordedCashSales: r.recorded_cash_sales,
    variance: r.variance,
    varianceType: r.variance_type,
    notes: r.notes,
    createdAt: r.created_at,
  };
}

function mapCount(r: CashCountRow): CashCountDetailRecord {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    shiftReconciliationId: r.shift_reconciliation_id,
    countType: r.count_type,
    denominationValue: r.denomination_value,
    quantity: r.quantity,
    subtotal: r.subtotal,
    createdAt: r.created_at,
  };
}

export interface PostgresShiftsStoreDependencies {
  readonly withTenantContext: WithTenantContext;
}

export class PostgresShiftsStore implements ShiftsStore {
  private readonly dependencies: PostgresShiftsStoreDependencies;

  constructor(dependencies: PostgresShiftsStoreDependencies) {
    this.dependencies = dependencies;
  }

  run<T>(tenantId: string, fn: (scope: ShiftsTxScope) => Promise<T>): Promise<T> {
    return this.dependencies.withTenantContext(
      tenantId,
      async (q) => fn(buildScope(q)),
      { isolationLevel: 'repeatable read', verifyTenantExists: true },
    );
  }
}

function buildScope(q: TenantQuery): ShiftsTxScope {
  return {
    async loadBranchForShift(tid, branchId) {
      const result = await q.query<{ id: string; base_currency: string; is_active: boolean }>(
        'SELECT id, base_currency, is_active FROM branches WHERE tenant_id = $1 AND id = $2',
        [tid, branchId],
      );
      const r = result.rows[0];
      return r === undefined ? null : { id: r.id, baseCurrencyCode: r.base_currency, isActive: r.is_active };
    },

    async userIsActiveMember(tid, userId) {
      const result = await q.query<{ exists: boolean }>(
        'SELECT EXISTS (SELECT 1 FROM users WHERE tenant_id = $1 AND id = $2 AND is_active) AS exists',
        [tid, userId],
      );
      return result.rows[0]?.exists === true;
    },

    async findOpenShiftForCashier(tid, cashierUserId, branchId) {
      const result = await q.query<ShiftRow>(
        `SELECT * FROM shift_reconciliations
          WHERE tenant_id = $1 AND cashier_id = $2 AND branch_id = $3 AND status = 'open'
          LIMIT 1`,
        [tid, cashierUserId, branchId],
      );
      return result.rows[0] === undefined ? null : mapShift(result.rows[0]);
    },

    async findAnyOpenShiftForCashier(tid, cashierUserId) {
      const result = await q.query<ShiftRow>(
        `SELECT * FROM shift_reconciliations
          WHERE tenant_id = $1 AND cashier_id = $2 AND status = 'open'
          LIMIT 1`,
        [tid, cashierUserId],
      );
      return result.rows[0] === undefined ? null : mapShift(result.rows[0]);
    },

    async loadShift(tid, shiftId) {
      const result = await q.query<ShiftRow>('SELECT * FROM shift_reconciliations WHERE tenant_id = $1 AND id = $2', [tid, shiftId]);
      return result.rows[0] === undefined ? null : mapShift(result.rows[0]);
    },

    async loadCashCounts(tid, shiftId) {
      const result = await q.query<CashCountRow>(
        'SELECT * FROM cash_count_details WHERE tenant_id = $1 AND shift_reconciliation_id = $2 ORDER BY created_at ASC, id ASC',
        [tid, shiftId],
      );
      return result.rows.map(mapCount);
    },

    async insertShift(tid, input: { id: string; branchId: string; cashierId: string; openedById: string; openVerifiedById: string; openedAt: Date; startingFloat: string }) {
      const result = await q.query<ShiftRow>(
        `INSERT INTO shift_reconciliations
           (id, tenant_id, branch_id, cashier_id, opened_by_id, open_verified_by_id, opened_at, starting_float, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'open')
         RETURNING *`,
        [input.id, tid, input.branchId, input.cashierId, input.openedById, input.openVerifiedById, input.openedAt, input.startingFloat],
      );
      const r = result.rows[0];
      if (r === undefined) throw new Error(`Shift ${input.id} could not be inserted`);
      return mapShift(r);
    },

    async insertCashCountDetails(tid, shiftId, countType: CashCountType, lines: readonly CashCountLineInput[]) {
      for (const line of lines) {
        await q.query(
          `INSERT INTO cash_count_details (id, tenant_id, shift_reconciliation_id, count_type, denomination_value, quantity)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)`,
          [tid, shiftId, countType, line.denominationValue, line.quantity],
        );
      }
    },

    async sumCompletedCashPaymentsText(tid, shiftId) {
      const result = await q.query<{ total: string }>(
        `SELECT COALESCE(SUM(p.amount_in_base_currency), 0)::text AS total
           FROM payments p
           JOIN payment_methods m ON m.id = p.payment_method_id AND m.tenant_id = p.tenant_id
          WHERE p.tenant_id = $1 AND p.shift_id = $2 AND p.status = 'completed'
            AND m.type IN ('cash', 'foreign_currency_cash')`,
        [tid, shiftId],
      );
      return result.rows[0]?.total ?? '0';
    },

    async closeShiftRow(tid, shiftId, close: { closedById: string; closeVerifiedById: string; closedAt: Date; countedCash: string; recordedCashSales: string; varianceType: VarianceType; notes: string | null }) {
      const result = await q.query<ShiftRow>(
        `UPDATE shift_reconciliations SET
           status = 'closed', closed_by_id = $3, close_verified_by_id = $4, closed_at = $5,
           counted_cash = $6, recorded_cash_sales = $7, variance_type = $8, notes = $9
         WHERE tenant_id = $1 AND id = $2
         RETURNING *`,
        [tid, shiftId, close.closedById, close.closeVerifiedById, close.closedAt, close.countedCash, close.recordedCashSales, close.varianceType, close.notes],
      );
      const r = result.rows[0];
      if (r === undefined) throw new Error(`Shift ${shiftId} could not be closed`);
      return mapShift(r);
    },
  };
}

export type { CloseShiftInput, OpenShiftInput };
