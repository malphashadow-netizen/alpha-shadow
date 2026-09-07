/**
 * Repository implementations.
 *
 * InMemory  — unit tests only; a runtime guard refuses them under
 *             NODE_ENV=production.
 * Postgres  — the production adapters; they receive `withTenantContext` via
 *             dependency injection and never touch pg.Pool directly.
 */

export {
  InMemoryPermissionReadRepository,
  InMemoryPermissionStore,
  InMemoryPermissionWriteRepository,
  type InMemoryPermissionRecord,
  type InMemoryRolePermissionRecord,
  type InMemoryRoleRecord,
  type InMemoryTenantRecord,
  type InMemoryUserRecord,
  type InMemoryUserRoleRecord,
} from './in-memory-permission-repository.ts';
export {
  PostgresPermissionReadRepository,
  PostgresPermissionWriteRepository,
  type PostgresPermissionRepositoryDependencies,
} from './postgres-permission-repository.ts';
export {
  PostgresAuditLogRepository,
  type PostgresAuditLogRepositoryDependencies,
} from './postgres-audit-log-repository.ts';
export {
  PostgresCurrencyRepository,
  PostgresExchangeRateRepository,
  PostgresReportingCurrencyRepository,
  type PostgresMultiCurrencyRepositoryDependencies,
} from './postgres-multi-currency-repositories.ts';
export {
  PostgresCatalogRepository,
  type PostgresCatalogRepositoryDependencies,
} from './postgres-catalog-repository.ts';
export { InMemoryCatalogRepository, InMemoryCatalogStore } from './in-memory-catalog-repository.ts';
export { PostgresTaxResolutionTransaction } from './postgres-tax-resolution-transaction.ts';
export { PostgresTaxSnapshotReader } from './postgres-tax-snapshot-reader.ts';
export { PostgresOrderTaxUnitOfWork, type PostgresOrderTaxDependencies, type TransactionalOrderLineWriter } from './postgres-order-tax-unit-of-work.ts';
export { PostgresTenantTaxAdminRepository } from './postgres-tenant-tax-admin-repository.ts';
// Platform adapter intentionally imported directly by the isolated platform
// composition root, not exported from the tenant-facing repository barrel.
