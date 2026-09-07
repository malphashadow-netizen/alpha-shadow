/**
 * RBAC/ABAC engine — Phase 2.
 *
 *   AuthorizationEngine  three strict stages: Tenant Guard → Permission Check
 *                        → ABAC, with sec_v token verification and the L1 cache
 *                        that never stores sensitive permissions.
 *   L1PermissionCache    LRU + 1-minute TTL.
 */

export {
  AuthorizationEngine,
  type AuthorizationDecision,
  type AuthorizationEngineDependencies,
  type CheckPermissionInput,
} from './authorization-engine.ts';
export { L1PermissionCache, type L1PermissionCacheOptions } from './l1-permission-cache.ts';
