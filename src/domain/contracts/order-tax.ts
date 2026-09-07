import type { TaxResolution, TaxResolutionTransaction } from './tax.ts';

export interface NewTaxableOrderLine {
  readonly branchId: string;
  readonly menuItemId: string;
  readonly customerAmountMinor: bigint;
  readonly currencyCode: string;
  readonly at: Date;
  readonly salesChannel: string;
  readonly deliveryPlatformId: string | null;
  /** The order adapter must take customer price, not net platform proceeds. */
  readonly amountBasis: 'customer_price' | 'platform_settlement';
}
export interface CreatedTaxableOrderLine {
  readonly orderLineId: string;
  readonly branchId: string;
  readonly menuItemId: string;
  readonly amountMinor: bigint;
  readonly currencyCode: string;
  readonly amountBasis: 'customer_price' | 'platform_settlement';
}
export interface TaxedOrderLine {
  readonly orderLineId: string;
  readonly taxes: TaxResolution;
  readonly restaurantTaxInvoiceAllowed: boolean;
  readonly amountPayableMinor: bigint;
}
export interface OrderTaxScope {
  readonly tax: TaxResolutionTransaction;
  createOrderLine(input: NewTaxableOrderLine): Promise<CreatedTaxableOrderLine>;
}
export interface OrderTaxUnitOfWork {
  run<T>(tenantId: string, fn: (scope: OrderTaxScope) => Promise<T>): Promise<T>;
}
