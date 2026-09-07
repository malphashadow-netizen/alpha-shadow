import type { CreatedTaxableOrderLine, NewTaxableOrderLine, OrderTaxScope, OrderTaxUnitOfWork } from '../../../domain/contracts/order-tax.ts';
import { ConflictError } from '../../../shared/errors.ts';
import type { TenantQuery, WithTenantContext } from '../tenant-context.ts';
import { PostgresTaxResolutionTransaction } from './postgres-tax-resolution-transaction.ts';

/** The future orders adapter is passed the EXISTING transaction, never a pool. */
export type TransactionalOrderLineWriter = (q: TenantQuery, tenantId: string, input: NewTaxableOrderLine) => Promise<CreatedTaxableOrderLine>;
export interface PostgresOrderTaxDependencies {
  readonly withTenantContext: WithTenantContext;
  readonly writeOrderLine: TransactionalOrderLineWriter;
}
export class PostgresOrderTaxUnitOfWork implements OrderTaxUnitOfWork {
  private readonly dependencies: PostgresOrderTaxDependencies;
  constructor(dependencies: PostgresOrderTaxDependencies) { this.dependencies = dependencies; }
  async run<T>(tenantId: string, fn: (scope: OrderTaxScope) => Promise<T>): Promise<T> {
    return this.dependencies.withTenantContext(tenantId, async (q) => {
      const tax = new PostgresTaxResolutionTransaction(q, tenantId);
      let active = true;
      try {
        return await fn({ tax, createOrderLine: async (input) => {
          if (!active) throw new ConflictError('Order/tax transaction scope has ended');
          return this.dependencies.writeOrderLine(q, tenantId, input);
        } });
      } finally {
        active = false;
        tax.close();
      }
    }, { isolationLevel: 'repeatable read', verifyTenantExists: true });
  }
}
