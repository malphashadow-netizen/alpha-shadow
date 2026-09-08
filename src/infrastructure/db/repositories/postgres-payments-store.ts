/**
 * PostgreSQL adapter for the Phase-8 payments ports
 * (domain/contracts/payments.ts — PaymentsStore).
 *
 * Every use case runs in ONE withTenantContext() transaction (repeatable
 * read, tenant existence verified): a payment, its evidence and the order's
 * payment_status move commit or roll back together. This class never imports
 * pg; it only receives the transaction-scoped TenantQuery.
 *
 * NUMERIC columns are read/written as exact canonical text; conversion to
 * BigInt minor units happens once, in the application engines, with the
 * currency scale stated explicitly.
 */
import type {
  AuditEvidenceInput,
  CouponRecord,
  InsertOrderDiscountInput,
  InsertPaymentInput,
  NewPaymentMethodInput,
  OrderDiscountRecord,
  OrderFinancialSnapshot,
  OrderLineForTotals,
  OrderLineTaxPlanLine,
  OrderRoundingStrategy,
  PaymentMethodRecord,
  PaymentMethodType,
  PaymentRecord,
  PaymentStatus,
  PaymentsStore,
  PaymentsTxScope,
  ShiftRecord,
  UpdatePaymentMethodInput,
  UserDiscountCaps,
} from '../../../domain/contracts/payments.ts';
import type {
  InsertStockMovementInput,
  SaleDeductionAggregate,
  StockMovementRecord,
  WasteRefundKey,
} from '../../../domain/contracts/inventory.ts';
import type { WithTenantContext, TenantQuery } from '../tenant-context.ts';
import { insertStockMovementRow } from './stock-ledger-rows.ts';
import { decimalTextToMinor, storageMinorUnitDigits } from '../../../shared/decimal-text.ts';
import { currencyCode } from '../../../shared/money.ts';

interface PaymentMethodRow {
  id: string;
  tenant_id: string;
  branch_id: string | null;
  name: string;
  type: PaymentMethodType;
  currency_code: string | null;
  fixed_exchange_rate: string | null;
  is_active: boolean;
}

interface PaymentRow {
  id: string;
  tenant_id: string;
  order_id: string;
  payment_method_id: string;
  amount: string;
  amount_in_base_currency: string;
  exchange_rate_snapshot: string | null;
  change_given_amount: string | null;
  status: PaymentStatus;
  shift_id: string;
  created_by: string;
  voided_by: string | null;
  voided_at: Date | null;
  void_reason: string | null;
  created_at: Date;
}

interface CouponRow {
  id: string;
  tenant_id: string;
  code: string;
  discount_kind: 'percentage' | 'fixed_amount';
  discount_value: string;
  min_order_amount: string | null;
  max_uses: number | null;
  uses_count: number;
  expires_at: Date | null;
  is_active: boolean;
}

interface OrderDiscountRow {
  id: string;
  tenant_id: string;
  order_id: string;
  mechanism: 'coupon' | 'manual' | 'points';
  coupon_id: string | null;
  discount_kind: 'percentage' | 'fixed_amount';
  discount_value: string;
  discount_amount_applied: string;
  required_manager_override: boolean;
  manager_override_attempt_id: string | null;
  applied_by: string;
  created_at: Date;
}

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
  variance_type: 'overage' | 'shortage' | 'exact' | null;
  notes: string | null;
  created_at: Date;
}

function mapMethod(r: PaymentMethodRow): PaymentMethodRecord {
  return {
    id: r.id, tenantId: r.tenant_id, branchId: r.branch_id, name: r.name, type: r.type,
    currencyCode: r.currency_code, fixedExchangeRate: r.fixed_exchange_rate, isActive: r.is_active,
  };
}

function mapPayment(r: PaymentRow): PaymentRecord {
  return {
    id: r.id, tenantId: r.tenant_id, orderId: r.order_id, paymentMethodId: r.payment_method_id,
    amount: r.amount, amountInBaseCurrency: r.amount_in_base_currency,
    exchangeRateSnapshot: r.exchange_rate_snapshot, changeGivenAmount: r.change_given_amount,
    status: r.status, shiftId: r.shift_id, createdBy: r.created_by,
    voidedById: r.voided_by, voidedAt: r.voided_at, voidReason: r.void_reason, createdAt: r.created_at,
  };
}

function mapCoupon(r: CouponRow): CouponRecord {
  return {
    id: r.id, tenantId: r.tenant_id, code: r.code, discountKind: r.discount_kind, discountValue: r.discount_value,
    minOrderAmount: r.min_order_amount, maxUses: r.max_uses, usesCount: r.uses_count,
    expiresAt: r.expires_at, isActive: r.is_active,
  };
}

function mapDiscount(r: OrderDiscountRow): OrderDiscountRecord {
  return {
    id: r.id, tenantId: r.tenant_id, orderId: r.order_id, mechanism: r.mechanism, couponId: r.coupon_id,
    discountKind: r.discount_kind, discountValue: r.discount_value, discountAmountApplied: r.discount_amount_applied,
    requiredManagerOverride: r.required_manager_override, managerOverrideAttemptId: r.manager_override_attempt_id,
    appliedBy: r.applied_by, createdAt: r.created_at,
  };
}

function mapShift(r: ShiftRow): ShiftRecord {
  return {
    id: r.id, tenantId: r.tenant_id, branchId: r.branch_id, cashierId: r.cashier_id,
    openedById: r.opened_by_id, openVerifiedById: r.open_verified_by_id, openedAt: r.opened_at,
    startingFloat: r.starting_float, status: r.status, closedById: r.closed_by_id,
    closeVerifiedById: r.close_verified_by_id, closedAt: r.closed_at, countedCash: r.counted_cash,
    recordedCashSales: r.recorded_cash_sales, variance: r.variance, varianceType: r.variance_type,
    notes: r.notes, createdAt: r.created_at,
  };
}

export interface PostgresPaymentsStoreDependencies {
  readonly withTenantContext: WithTenantContext;
}

export class PostgresPaymentsStore implements PaymentsStore {
  private readonly dependencies: PostgresPaymentsStoreDependencies;

  constructor(dependencies: PostgresPaymentsStoreDependencies) {
    this.dependencies = dependencies;
  }

  run<T>(tenantId: string, fn: (scope: PaymentsTxScope) => Promise<T>): Promise<T> {
    return this.dependencies.withTenantContext(
      tenantId,
      async (q) => fn(buildScope(q)),
      { isolationLevel: 'repeatable read', verifyTenantExists: true },
    );
  }
}

interface TaxPlanQueryRow {
  order_line_id: string;
  tax_rate_id: string;
  tax_family: 'vat' | 'excise';
  rate_bps_snapshot: number;
  is_price_inclusive_snapshot: boolean;
  cascade_priority: number;
  rounding_strategy: OrderRoundingStrategy;
}

interface PaymentStatusRow {
  status: PaymentStatus;
  amount_in_base_currency: string;
}

function buildScope(q: TenantQuery): PaymentsTxScope {
  return {
    async loadOrderFinancialSnapshot(tid, orderId): Promise<OrderFinancialSnapshot | null> {
      const header = await q.query<{ branch_id: string; payment_status: OrderFinancialSnapshot['paymentStatus']; base_currency: string }>(
        `SELECT o.branch_id, o.payment_status, b.base_currency
           FROM orders o JOIN branches b ON b.id = o.branch_id AND b.tenant_id = o.tenant_id
          WHERE o.tenant_id = $1 AND o.id = $2`,
        [tid, orderId],
      );
      const h = header.rows[0];
      if (h === undefined) return null;
      const baseDigits = storageMinorUnitDigits(currencyCode(h.base_currency));

      const items = await q.query<{ id: string; unit_price_minor: string; quantity: number }>(
        `SELECT id, unit_price_minor, quantity FROM order_items
          WHERE tenant_id = $1 AND order_id = $2 AND NOT is_voided
          ORDER BY created_at ASC, id ASC`,
        [tid, orderId],
      );

      const taxRows = await q.query<TaxPlanQueryRow>(
        `SELECT s.order_line_id, s.tax_rate_id, s.tax_family, s.rate_bps_snapshot,
                s.is_price_inclusive_snapshot, k.cascade_priority, c.rounding_strategy
           FROM order_line_tax_snapshots s
           JOIN order_line_tax_contexts c ON c.order_line_id = s.order_line_id AND c.tenant_id = $1
           JOIN tax_rates r ON r.id = s.tax_rate_id
           JOIN tax_categories k ON k.id = r.tax_category_id
          WHERE s.order_line_id IN (
                SELECT i.id FROM order_items i
                 WHERE i.tenant_id = $1 AND i.order_id = $2 AND NOT i.is_voided)
            AND c.liable_party = 'restaurant'
          ORDER BY s.order_line_id, s.computation_sequence`,
        [tid, orderId],
      );
      const plansByLine = new Map<string, OrderLineTaxPlanLine[]>();
      let roundingStrategy: OrderRoundingStrategy | null = null;
      for (const row of taxRows.rows) {
        const list = plansByLine.get(row.order_line_id) ?? [];
        list.push({
          taxRateId: row.tax_rate_id,
          taxFamily: row.tax_family,
          cascadePriority: row.cascade_priority,
          rateBps: row.rate_bps_snapshot,
          isPriceInclusive: row.is_price_inclusive_snapshot,
        });
        plansByLine.set(row.order_line_id, list);
        roundingStrategy = row.rounding_strategy;
      }

      const discounts = await q.query<OrderDiscountRow>(
        'SELECT * FROM order_discounts WHERE tenant_id = $1 AND order_id = $2 ORDER BY created_at ASC, id ASC',
        [tid, orderId],
      );

      const payments = await q.query<PaymentStatusRow>(
        'SELECT status, amount_in_base_currency FROM payments WHERE tenant_id = $1 AND order_id = $2',
        [tid, orderId],
      );
      let completedMinor = 0n;
      const paymentStatuses: PaymentStatus[] = [];
      for (const p of payments.rows) {
        paymentStatuses.push(p.status);
        if (p.status === 'completed') {
          completedMinor += decimalTextToMinor(p.amount_in_base_currency, baseDigits, 'amountInBaseCurrency');
        }
      }

      const lines: OrderLineForTotals[] = items.rows.map((item) => ({
        orderItemId: item.id,
        lineAmountMinor: BigInt(item.unit_price_minor) * BigInt(item.quantity),
        taxPlan: plansByLine.get(item.id) ?? [],
      }));

      return {
        orderId,
        branchId: h.branch_id,
        baseCurrencyCode: h.base_currency,
        paymentStatus: h.payment_status,
        roundingStrategy,
        lines,
        discounts: discounts.rows.map(mapDiscount),
        completedPaymentsMinor: completedMinor,
        paymentStatuses,
      };
    },

    async loadPaymentMethod(tid, paymentMethodId) {
      const result = await q.query<PaymentMethodRow>('SELECT * FROM payment_methods WHERE tenant_id = $1 AND id = $2', [tid, paymentMethodId]);
      return result.rows[0] === undefined ? null : mapMethod(result.rows[0]);
    },

    async findOpenShiftForCashier(tid, cashierUserId, branchId) {
      const result = await q.query<ShiftRow>(
        `SELECT * FROM shift_reconciliations
          WHERE tenant_id = $1 AND cashier_id = $2 AND branch_id = $3 AND status = 'open' LIMIT 1`,
        [tid, cashierUserId, branchId],
      );
      return result.rows[0] === undefined ? null : mapShift(result.rows[0]);
    },

    async loadPayment(tid, paymentId) {
      const result = await q.query<PaymentRow>('SELECT * FROM payments WHERE tenant_id = $1 AND id = $2', [tid, paymentId]);
      return result.rows[0] === undefined ? null : mapPayment(result.rows[0]);
    },

    async loadUserDiscountCaps(tid, userId): Promise<UserDiscountCaps | null> {
      const result = await q.query<{ max_discount_percentage: string | null; max_discount_fixed_amount: string | null }>(
        `SELECT max_discount_percentage::text, max_discount_fixed_amount::text
           FROM user_discount_limits
          WHERE tenant_id = $1 AND user_id = $2 AND permission_key = 'order:discount:apply'`,
        [tid, userId],
      );
      const r = result.rows[0];
      return r === undefined ? null : { maxDiscountPercentage: r.max_discount_percentage, maxDiscountFixedAmount: r.max_discount_fixed_amount };
    },

    async loadCouponByCode(tid, code) {
      const result = await q.query<CouponRow>('SELECT * FROM coupons WHERE tenant_id = $1 AND code = $2', [tid, code]);
      return result.rows[0] === undefined ? null : mapCoupon(result.rows[0]);
    },

    async insertPayment(tid, payment: InsertPaymentInput) {
      const result = await q.query<PaymentRow>(
        `INSERT INTO payments
           (id, tenant_id, order_id, payment_method_id, amount, amount_in_base_currency,
            exchange_rate_snapshot, change_given_amount, shift_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING *`,
        [
          payment.id, tid, payment.orderId, payment.paymentMethodId, payment.amount, payment.amountInBaseCurrency,
          payment.exchangeRateSnapshot, payment.changeGivenAmount, payment.shiftId, payment.createdBy,
        ],
      );
      const r = result.rows[0];
      if (r === undefined) throw new Error(`Payment ${payment.id} could not be inserted`);
      return mapPayment(r);
    },

    async voidPayment(tid, paymentId, evidence) {
      const result = await q.query<PaymentRow>(
        `UPDATE payments SET status = 'voided', voided_by = $3, voided_at = $4, void_reason = $5
          WHERE tenant_id = $1 AND id = $2 RETURNING *`,
        [tid, paymentId, evidence.voidedById, evidence.voidedAt, evidence.voidReason],
      );
      const r = result.rows[0];
      if (r === undefined) throw new Error(`Payment ${paymentId} could not be voided`);
      return mapPayment(r);
    },

    async refundPayment(tid, paymentId) {
      const result = await q.query<PaymentRow>(
        `UPDATE payments SET status = 'refunded'
          WHERE tenant_id = $1 AND id = $2 RETURNING *`,
        [tid, paymentId],
      );
      const r = result.rows[0];
      if (r === undefined) throw new Error(`Payment ${paymentId} could not be refunded`);
      return mapPayment(r);
    },

    async setOrderPaymentStatus(tid, orderId, paymentStatus) {
      await q.query('UPDATE orders SET payment_status = $3 WHERE tenant_id = $1 AND id = $2', [tid, orderId, paymentStatus]);
    },

    async appendAuditEvidence(tid, evidence: AuditEvidenceInput) {
      await q.query(
        `INSERT INTO audit_log (tenant_id, user_id, action, resource, before, after)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
        [tid, evidence.userId, evidence.action, evidence.resource, JSON.stringify(evidence.before), JSON.stringify(evidence.after)],
      );
    },

    async insertOrderDiscount(tid, discount: InsertOrderDiscountInput) {
      const result = await q.query<OrderDiscountRow>(
        `INSERT INTO order_discounts
           (id, tenant_id, order_id, mechanism, coupon_id, discount_kind, discount_value,
            discount_amount_applied, required_manager_override, manager_override_attempt_id, applied_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING *`,
        [
          discount.id, tid, discount.orderId, discount.mechanism, discount.couponId, discount.discountKind,
          discount.discountValue, discount.discountAmountApplied, discount.requiredManagerOverride,
          discount.managerOverrideAttemptId, discount.appliedBy,
        ],
      );
      const r = result.rows[0];
      if (r === undefined) throw new Error(`Order discount ${discount.id} could not be inserted`);
      return mapDiscount(r);
    },

    async incrementCouponUses(tid, couponId) {
      await q.query('UPDATE coupons SET uses_count = uses_count + 1, updated_at = now() WHERE tenant_id = $1 AND id = $2', [tid, couponId]);
    },

    async findSuccessfulOverrideAttemptId(tid, evidence) {
      const result = await q.query<{ id: string }>(
        `SELECT id FROM manager_override_attempts
          WHERE tenant_id = $1 AND initiating_actor_user_id = $2 AND target_manager_user_id = $3
            AND order_id = $4 AND outcome = 'succeeded' AND context_type = $5
          ORDER BY created_at DESC LIMIT 1`,
        [tid, evidence.actorUserId, evidence.managerUserId, evidence.orderId, evidence.contextType],
      );
      return result.rows[0]?.id ?? null;
    },

    async insertPaymentMethod(tid, input: NewPaymentMethodInput) {
      const result = await q.query<PaymentMethodRow>(
        `INSERT INTO payment_methods (id, tenant_id, branch_id, name, type, currency_code, fixed_exchange_rate, is_active)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [tid, input.branchId, input.name, input.type, input.currencyCode, input.fixedExchangeRate, input.isActive],
      );
      const r = result.rows[0];
      if (r === undefined) throw new Error('Payment method could not be inserted');
      return mapMethod(r);
    },

    async updatePaymentMethod(tid, paymentMethodId, input: UpdatePaymentMethodInput) {
      const result = await q.query<PaymentMethodRow>(
        `UPDATE payment_methods SET
           name = COALESCE($3, name),
           is_active = COALESCE($4, is_active),
           fixed_exchange_rate = COALESCE($5, fixed_exchange_rate),
           updated_at = now()
         WHERE tenant_id = $1 AND id = $2 RETURNING *`,
        [tid, paymentMethodId, input.name ?? null, input.isActive ?? null, input.fixedExchangeRate ?? null],
      );
      const r = result.rows[0];
      if (r === undefined) throw new Error(`Payment method ${paymentMethodId} could not be updated`);
      return mapMethod(r);
    },

    async loadNonVoidedOrderItemIds(tid, orderId): Promise<readonly string[]> {
      // Refund waste covers the live lines only: voided lines were already
      // restored-or-wasted by the void path (never double-counted).
      const result = await q.query<{ id: string }>(
        'SELECT id FROM order_items WHERE tenant_id = $1 AND order_id = $2 AND NOT is_voided ORDER BY created_at ASC, id ASC',
        [tid, orderId],
      );
      return result.rows.map((r) => r.id);
    },

    async loadSaleDeductionsForOrderItems(tid, orderItemIds): Promise<readonly SaleDeductionAggregate[]> {
      if (orderItemIds.length === 0) return [];
      const result = await q.query<{ order_item_id: string; inventory_item_id: string; total_deducted: string }>(
        `SELECT order_item_id, inventory_item_id, SUM(quantity_delta) AS total_deducted
           FROM stock_movements
          WHERE tenant_id = $1 AND order_item_id = ANY($2::uuid[]) AND movement_type = 'sale_deduction'
          GROUP BY order_item_id, inventory_item_id`,
        [tid, orderItemIds],
      );
      return result.rows.map((r) => ({
        orderItemId: r.order_item_id,
        inventoryItemId: r.inventory_item_id,
        totalDeducted: r.total_deducted,
      }));
    },

    async loadWasteRefundKeys(tid, orderId): Promise<readonly WasteRefundKey[]> {
      const result = await q.query<{ order_item_id: string; inventory_item_id: string }>(
        `SELECT order_item_id, inventory_item_id FROM stock_movements
          WHERE tenant_id = $1 AND order_id = $2 AND movement_type = 'waste_refund'`,
        [tid, orderId],
      );
      return result.rows.map((r) => ({ orderItemId: r.order_item_id, inventoryItemId: r.inventory_item_id }));
    },

    async insertStockMovement(tid, movement: InsertStockMovementInput): Promise<StockMovementRecord> {
      // Waste rows carry a ZERO delta and can never trip the sale-only
      // shortage gate — plain insert, no error mapping.
      return insertStockMovementRow(q, tid, movement);
    },
  };
}
