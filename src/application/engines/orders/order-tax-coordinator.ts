/** Phase-6 integration seam only; order lifecycle/pricing/payments are later phases. */
import type { CreatedTaxableOrderLine, NewTaxableOrderLine, OrderTaxUnitOfWork, TaxedOrderLine } from '../../../domain/contracts/order-tax.ts';
import type { TaxLineRequest, TaxResolution } from '../../../domain/contracts/tax.ts';
import { TaxConfigurationError, ValidationError } from '../../../shared/errors.ts';
import { assertTaxAmount } from '../../../shared/tax-math.ts';
import { isExternalTaxLiability, resolveInvoiceAndSnapshot, TaxResolutionEngine } from '../tax/tax-resolution-engine.ts';

function assertCustomerBasis(input: NewTaxableOrderLine): void {
  assertTaxAmount(input.customerAmountMinor);
  if (input.amountBasis !== 'customer_price') {
    throw new ValidationError('Tax base must be the full customer price, never the platform settlement after commission', 'amountBasis');
  }
}
/**
 * NOTE (audit F-B): the pricing moment arrives as an explicit server-side
 * argument — this seam NEVER reads the caller-controlled (deprecated)
 * `input.at`, so the no-deprecated lint rule guards the property forever.
 */
function bindWrittenLine(input: NewTaxableOrderLine, created: CreatedTaxableOrderLine, serverAt: Date): TaxLineRequest {
  if (created.amountBasis !== 'customer_price' || created.amountMinor !== input.customerAmountMinor ||
    created.currencyCode !== input.currencyCode || created.branchId !== input.branchId || created.menuItemId !== input.menuItemId) {
    throw new ValidationError('Persisted order line must match the full customer-facing price and tenant branch context');
  }
  return { orderLineId: created.orderLineId, branchId: input.branchId, menuItemId: input.menuItemId,
    grossOrNetAmountMinor: input.customerAmountMinor, currencyCode: input.currencyCode,
    at: serverAt, salesChannel: input.salesChannel, deliveryPlatformId: input.deliveryPlatformId };
}
function resultFor(request: TaxLineRequest, taxes: TaxResolution): TaxedOrderLine {
  const external = isExternalTaxLiability(taxes);
  const exclusiveTax = external ? 0n : taxes.reduce((sum, t) => sum + (t.isPriceInclusive ? 0n : t.taxAmountMinor), 0n);
  const amountPayableMinor = request.grossOrNetAmountMinor + exclusiveTax;
  assertTaxAmount(amountPayableMinor);
  return Object.freeze({ orderLineId: request.orderLineId, taxes, restaurantTaxInvoiceAllowed: !external, amountPayableMinor });
}
export class OrderTaxCoordinator {
  private readonly unitOfWork: OrderTaxUnitOfWork;
  constructor(unitOfWork: OrderTaxUnitOfWork) { this.unitOfWork = unitOfWork; }

  async createLine(tenantId: string, input: NewTaxableOrderLine): Promise<TaxedOrderLine> {
    assertCustomerBasis(input);
    // Audit F-B: input.at is accepted (deprecated) but ALWAYS ignored — the
    // server clock prices the line; a caller-supplied date must never select
    // the tax rate or liability rule.
    const serverAt = new Date();
    const timed: NewTaxableOrderLine = { ...input, at: serverAt };
    return this.unitOfWork.run(tenantId, async (scope) => {
      const request = bindWrittenLine(timed, await scope.createOrderLine(timed), serverAt);
      const engine = new TaxResolutionEngine({ transaction: scope.tax, orderLineId: request.orderLineId });
      const taxes = await engine.resolveAndSnapshot(tenantId, request.branchId, request.menuItemId,
        request.grossOrNetAmountMinor, request.currencyCode, request.at, request.salesChannel, request.deliveryPlatformId);
      return resultFor(request, taxes);
    });
  }
  async createInvoice(tenantId: string, inputs: readonly NewTaxableOrderLine[]): Promise<readonly TaxedOrderLine[]> {
    if (inputs.length === 0) throw new ValidationError('An invoice must contain at least one line');
    inputs.forEach(assertCustomerBasis);
    // Audit F-B: input.at is accepted (deprecated) but ALWAYS ignored — one
    // server moment prices the whole invoice.
    const serverAt = new Date();
    return this.unitOfWork.run(tenantId, async (scope) => {
      const requests: TaxLineRequest[] = [];
      for (const input of inputs) {
        const timed: NewTaxableOrderLine = { ...input, at: serverAt };
        requests.push(bindWrittenLine(timed, await scope.createOrderLine(timed), serverAt));
      }
      const resolved = await resolveInvoiceAndSnapshot(scope.tax, tenantId, requests);
      return Object.freeze(requests.map((request) => {
        const taxes = resolved.get(request.orderLineId);
        if (taxes === undefined) throw new TaxConfigurationError('Missing invoice tax result');
        return resultFor(request, taxes);
      }));
    });
  }
}
