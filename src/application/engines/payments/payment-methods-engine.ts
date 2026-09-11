/**
 * Payment-method administration (Phase 8; B7: gated by payments:methods_admin).
 *
 * Tenant configuration — the engine enforces the STRUCTURAL rules:
 *   * the fixed type vocabulary,
 *   * foreign currency is cash-only: a foreign_currency_cash method REQUIRES
 *     a currency and a positive manual fixed rate; every other type carries
 *     NEITHER (the DB fx_shape CHECK re-verifies),
 *   * every provisioning/change of the manual rate is appended to the
 *     tenant's exchange_rates ledger by the DB trigger (migration 0033) —
 *     this engine just writes the row.
 *
 * B7: BOTH mutations require the payments:methods_admin key (sensitive —
 * structural tender configuration, tax:configure parity). The actor is
 * AUTH-ONLY (no actor column on the row), so it travels as a positional
 * `actorUserId` parameter — the same convention as the catalog engine's
 * mutating methods (actor-inside-input is reserved for actors that are also
 * stored domain data, e.g. recordPayment's cashierUserId).
 */

import type { NewPaymentMethodInput, PaymentMethodRecord, PaymentsStore, PaymentMethodType, UpdatePaymentMethodInput } from '../../../domain/contracts/payments.ts';
import type { AuthorizationEngine } from '../rbac/authorization-engine.ts';
import { NotFoundError, ValidationError } from '../../../shared/errors.ts';
import { isCurrencyCode } from '../../../shared/money.ts';

const METHOD_TYPES: readonly PaymentMethodType[] = ['cash', 'card', 'wallet', 'foreign_currency_cash', 'other'];

const PAYMENT_METHODS_ADMIN_PERMISSION_KEY = 'payments:methods_admin';

function administrationContext(branchId: string | null) {
  return branchId === null
    ? { hasResource: false as const, actorBranchId: null, isSensitivePermission: true }
    : { hasResource: true as const, actorBranchId: branchId, resourceBranchId: branchId, isSensitivePermission: true };
}

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
  private readonly dependencies: { readonly store: PaymentsStore; readonly authorization: Pick<AuthorizationEngine, 'check'> };

  constructor(dependencies: { readonly store: PaymentsStore; readonly authorization: Pick<AuthorizationEngine, 'check'> }) {
    this.dependencies = dependencies;
  }

  async create(tenantId: string, actorUserId: string, input: NewPaymentMethodInput): Promise<PaymentMethodRecord> {
    await this.dependencies.authorization.check({
      tenantId,
      userId: actorUserId,
      permissionKey: PAYMENT_METHODS_ADMIN_PERMISSION_KEY,
      context: administrationContext(input.branchId),
    });
    if (input.name.trim() === '') throw new ValidationError('A payment method requires a name', 'name');
    assertTypeShape(input);
    return this.dependencies.store.run(tenantId, (scope) => scope.insertPaymentMethod(tenantId, input));
  }

  async update(tenantId: string, actorUserId: string, paymentMethodId: string, input: UpdatePaymentMethodInput): Promise<PaymentMethodRecord> {
    return this.dependencies.store.run(tenantId, async (scope) => {
      const existing = await scope.loadPaymentMethod(tenantId, paymentMethodId);
      if (existing === null) {
        await this.dependencies.authorization.check({
          tenantId,
          userId: actorUserId,
          permissionKey: PAYMENT_METHODS_ADMIN_PERMISSION_KEY,
          context: administrationContext(null),
        });
        throw new NotFoundError(`Payment method ${paymentMethodId} not found`);
      }
      await this.dependencies.authorization.check({
        tenantId,
        userId: actorUserId,
        permissionKey: PAYMENT_METHODS_ADMIN_PERMISSION_KEY,
        context: administrationContext(existing.branchId),
      });
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
