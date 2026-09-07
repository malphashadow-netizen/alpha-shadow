import type { OrderLineTaxContext, StoredTaxLine, TaxFamily, TaxLiableParty, TaxRoundingStrategy, TaxSnapshotReader } from '../../../domain/contracts/tax.ts';
import { minorUnitsFromDb } from '../../../shared/money.ts';
import type { WithTenantContext } from '../tenant-context.ts';

/** Read ONLY. ZATCA/reporting must consume this evidence without recomputing it. */
export class PostgresTaxSnapshotReader implements TaxSnapshotReader {
  private readonly withTenantContext: WithTenantContext;
  constructor(withTenantContext: WithTenantContext) { this.withTenantContext = withTenantContext; }
  async readContext(tenantId: string, orderLineId: string): Promise<OrderLineTaxContext | null> {
    return this.withTenantContext(tenantId, async (q) => {
      const r = await q.query<{
        order_line_id: string; branch_id: string; menu_item_id: string; customer_amount_minor: string; currency_code: string;
        sales_channel_code: string; delivery_platform_id: string | null; liability_rule_id: string;
        liable_party: TaxLiableParty; rounding_strategy: TaxRoundingStrategy; occurred_at: Date;
      }>('SELECT * FROM order_line_tax_contexts WHERE tenant_id = $1 AND order_line_id = $2', [tenantId, orderLineId]);
      const row = r.rows[0];
      return row === undefined ? null : Object.freeze({ orderLineId: row.order_line_id, branchId: row.branch_id,
        menuItemId: row.menu_item_id, grossOrNetAmountMinor: minorUnitsFromDb(row.customer_amount_minor), currencyCode: row.currency_code,
        at: row.occurred_at, salesChannel: row.sales_channel_code, deliveryPlatformId: row.delivery_platform_id,
        liabilityRuleId: row.liability_rule_id, liableParty: row.liable_party, roundingStrategy: row.rounding_strategy });
    });
  }
  async readSnapshots(tenantId: string, orderLineId: string): Promise<readonly StoredTaxLine[]> {
    return this.withTenantContext(tenantId, async (q) => {
      const r = await q.query<{
        order_line_id: string; tax_rate_id: string; tax_family: TaxFamily; computation_sequence: number;
        liable_party: TaxLiableParty; rate_bps_snapshot: number; is_price_inclusive_snapshot: boolean;
        taxable_amount_minor: string; tax_amount_minor: string; currency_code: string;
      }>('SELECT * FROM order_line_tax_snapshots WHERE order_line_id = $1 ORDER BY computation_sequence', [orderLineId]);
      return Object.freeze(r.rows.map((row) => Object.freeze({ orderLineId: row.order_line_id, taxRateId: row.tax_rate_id,
        taxFamily: row.tax_family, computationSequence: row.computation_sequence, liableParty: row.liable_party,
        rateBps: row.rate_bps_snapshot, isPriceInclusive: row.is_price_inclusive_snapshot,
        taxableAmountMinor: minorUnitsFromDb(row.taxable_amount_minor), taxAmountMinor: minorUnitsFromDb(row.tax_amount_minor), currencyCode: row.currency_code })));
    });
  }
}
