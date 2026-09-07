/**
 * Permission repository implementations (Phase 2).
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
