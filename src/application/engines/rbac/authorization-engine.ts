/**
 * RBAC/ABAC authorization engine — three strict stages in order:
 *
 *   Tenant Guard ← Permission Check ← ABAC
 *
 * Tenant Guard   — the actor must be an ACTIVE user of the tenant; when a
 *                  token `sec_v` is presented it must equal the freshly
 *                  derived value (a stale token is rejected).
 * Permission Check— does the actor hold the atomic permission key through an
 *                  active role whose scope covers the relevant branch? Results
 *                  are memoised in the L1 cache EXCEPT for sensitive
 *                  permissions, which are re-read from the store every time
 *                  (grant AND denial — both directions).
 * ABAC           — (a) branch match: when `hasResource`, actorBranchId must
 *                  equal resourceBranchId; (b) financial cap: the resource
 *                  amount must not exceed the role grant's
 *                  max_amount_minor_units (when a cap exists).
 *
 * The engine depends only on the domain contract (IPermissionReadRepository)
 * and shared errors — never on infrastructure.
 */

import { AuthorizationError, ForbiddenError } from '../../../shared/errors.ts';
import type { AbacContext } from '../../../domain/contracts/abac-context.ts';
import type {
  IPermissionReadRepository,
  PermissionCheckOutcome,
  PermissionGrant,
} from '../../../domain/contracts/permission-repository.ts';
import { deriveSecV, type SecVHash } from '../../../domain/contracts/sec-v.ts';
import type { L1PermissionCache } from './l1-permission-cache.ts';

export interface AuthorizationDecision {
  readonly allowed: true;
  readonly effectiveMaxAmountMinorUnits: bigint | null;
}

export interface CheckPermissionInput {
  readonly tenantId: string;
  readonly userId: string;
  readonly permissionKey: string;
  readonly context: AbacContext;
  /** Presented token sec_v; when provided it must match the current value. */
  readonly tokenSecV?: string;
}

export interface AuthorizationEngineDependencies {
  readonly read: IPermissionReadRepository;
  readonly hash: SecVHash;
  readonly cache?: L1PermissionCache;
}

function buildCacheKey(
  tenantId: string,
  userId: string,
  permissionKey: string,
  hasResource: boolean,
  relevantBranch: string | null,
): string {
  return JSON.stringify([tenantId, userId, permissionKey, hasResource, relevantBranch]);
}

function computeOutcome(grants: readonly PermissionGrant[]): PermissionCheckOutcome {
  if (grants.length === 0) {
    return { allowed: false, effectiveMaxAmountMinorUnits: null };
  }
  let anyUncapped = false;
  let maxCapped: bigint | null = null;
  for (const grant of grants) {
    if (grant.maxAmountMinorUnits === null) {
      anyUncapped = true;
    } else if (maxCapped === null || grant.maxAmountMinorUnits > maxCapped) {
      maxCapped = grant.maxAmountMinorUnits;
    }
  }
  return { allowed: true, effectiveMaxAmountMinorUnits: anyUncapped ? null : maxCapped };
}

export class AuthorizationEngine {
  private readonly read: IPermissionReadRepository;
  private readonly hash: SecVHash;
  private readonly cache: L1PermissionCache | undefined;

  constructor(dependencies: AuthorizationEngineDependencies) {
    this.read = dependencies.read;
    this.hash = dependencies.hash;
    this.cache = dependencies.cache;
  }

  /** Full three-stage check. Throws ForbiddenError/AuthorizationError on deny. */
  async check(input: CheckPermissionInput): Promise<AuthorizationDecision> {
    const { tenantId, userId, permissionKey, context } = input;

    // ── Stage 1: Tenant Guard ──────────────────────────────────────────────
    if (!(await this.read.isUserActive(tenantId, userId))) {
      throw new ForbiddenError('user is not an active member of the tenant');
    }

    if (input.tokenSecV !== undefined) {
      const roles = await this.read.listActiveUserRoles(tenantId, userId);
      const securityVersion = await this.read.getSecurityVersion(tenantId, userId);
      const derived = deriveSecV(roles, securityVersion, this.hash);
      if (derived !== input.tokenSecV) {
        throw new AuthorizationError('token sec_v does not match the current role set');
      }
    }

    // ── Stage 2: Permission Check (L1 cache, sensitive bypass) ─────────────
    const outcome = await this.permissionCheck(tenantId, userId, permissionKey, context);
    if (!outcome.allowed) {
      throw new ForbiddenError(`missing permission ${permissionKey}`);
    }

    // ── Stage 3: ABAC (never cached) ───────────────────────────────────────
    // (a) branch match.
    if (context.hasResource && context.actorBranchId !== context.resourceBranchId) {
      throw new ForbiddenError('actor branch does not match the resource branch');
    }

    // (b) financial cap.
    if (
      context.hasResource &&
      context.resourceAmountMinorUnits !== undefined &&
      outcome.effectiveMaxAmountMinorUnits !== null &&
      context.resourceAmountMinorUnits > outcome.effectiveMaxAmountMinorUnits
    ) {
      throw new ForbiddenError('resource amount exceeds the role permission financial cap');
    }

    return { allowed: true, effectiveMaxAmountMinorUnits: outcome.effectiveMaxAmountMinorUnits };
  }

  private async permissionCheck(
    tenantId: string,
    userId: string,
    permissionKey: string,
    context: AbacContext,
  ): Promise<PermissionCheckOutcome> {
    const relevantBranch = context.hasResource ? context.resourceBranchId : context.actorBranchId;

    // Sensitive permissions are NEVER cached — not a grant, not a denial.
    if (!context.isSensitivePermission && this.cache !== undefined) {
      const cacheKey = buildCacheKey(tenantId, userId, permissionKey, context.hasResource, relevantBranch);
      const cached = this.cache.get(cacheKey);
      if (cached !== undefined) {
        return cached;
      }
      const grants = await this.read.getApplicableGrants(tenantId, userId, permissionKey, relevantBranch);
      const outcome = computeOutcome(grants);
      this.cache.set(cacheKey, outcome);
      return outcome;
    }

    const grants = await this.read.getApplicableGrants(tenantId, userId, permissionKey, relevantBranch);
    return computeOutcome(grants);
  }
}
