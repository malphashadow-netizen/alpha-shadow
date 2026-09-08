/**
 * Payment-method administration (Phase 8).
 *
 * Tenant configuration only — no permission key is mandated by the Phase-8
 * spec for this surface, so the engine enforces the STRUCTURAL rules and
 * leaves access control to the caller's admin surface:
 *   * the fixed type vocabulary,
 *   * foreign currency is cash-only: a foreign_currency_cash method REQUIRES
 *     a currency and a positive manual fixed rate; every other type carries
 *     NEITHER (the DB fx_shape CHECK re-verifies),
 *   * every provisioning/change of the manual rate is appended to the
 *     tenant's exchange_rates ledger by the DB trigger (migration 0033) —
 *     this engine just writes the row.
 */

import type { NewPaymentMethodInput, PaymentMethodRecord, PaymentsStore, PaymentMethodType, UpdatePaymentMethodInput } from '../../../domain/contracts/payments.ts';
import { NotFoundError, ValidationError } from '../../../shared/errors.ts';
import { isCurrencyCode } from '../../../shared/money.ts';

const METHOD_TYPES: readonly PaymentMethodType[] = ['cash', 'card', 'wallet', 'foreign_currency_cash', 'other'];

function assertTypeShape(input: { type: PaymentMethodType; currencyCode: string | null; fixedExchangeRate: string | null }): void {
  if (!METHOD_TYPES.includes(input.type)) {
    throw new ValidationError(`Unknown payment method type '${input.type}'`, 'type');
  }
  if (input.type === 'foreign_currency_cash') {
    if (input.currencyCode === null || !isCurrencyCode(input.currencyCode)) {
      throw new ValidationError('A foreign-currency cash method requires a valid ISO 4217 currency', 'currencyCode');
    }
    if (input.fixedExchangeRate === null || !/^(0|[1-9]\d*)(\.\d{1,8})?$/.test(input.fixedExchangeRate) || BigInt(input.fixedExchangeRate.replace('.', '').padEnd(1, '0')) <= 0n) {
      throw new ValidationError('A foreign-currency cash method requires a positive fixed exchange rate (≤ 8 decimals)', 'fixedExchangeRate');
    }
    return;
  }
  if (input.currencyCode !== null || input.fixedExchangeRate !== null) {
    throw new ValidationError('Foreign currency is cash-only: card/wallet/other methods carry neither a currency nor a rate', 'currencyCode');
  }
}

export class PaymentMethodsEngine {
  private readonly dependencies: { readonly store: PaymentsStore };

  constructor(dependencies: { readonly store: PaymentsStore }) {
    this.dependencies = dependencies;
  }

  async create(tenantId: string, input: NewPaymentMethodInput): Promise<PaymentMethodRecord> {
    if (input.name.trim() === '') throw new ValidationError('A payment method requires a name', 'name');
    assertTypeShape(input);
    return this.dependencies.store.run(tenantId, (scope) => scope.insertPaymentMethod(tenantId, input));
  }

  async update(tenantId: string, paymentMethodId: string, input: UpdatePaymentMethodInput): Promise<PaymentMethodRecord> {
    return this.dependencies.store.run(tenantId, async (scope) => {
      const existing = await scope.loadPaymentMethod(tenantId, paymentMethodId);
      if (existing === null) throw new NotFoundError(`Payment method ${paymentMethodId} not found`);
      // The type/currency pair is fixed at creation (the fx_shape CHECK would
      // reject a cross-type rewrite anyway); only name/active/rate change.
      assertTypeShape({
        type: existing.type,
        currencyCode: existing.currencyCode,
        fixedExchangeRate: input.fixedExchangeRate ?? existing.fixedExchangeRate,
      });
      return scope.updatePaymentMethod(tenantId, paymentMethodId, input);
    });
  }
}
