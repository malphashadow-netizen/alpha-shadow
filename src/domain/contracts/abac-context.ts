/**
 * AbacContext — mandatory discriminated union for the ABAC stage.
 *
 * The union (not a plain object with an optional branch) is the whole point:
 * when a resource exists (`hasResource: true`) TypeScript FORCES the caller to
 * provide `resourceBranchId` (a non-null string) — forgetting the branch of a
 * real resource is a compile error, not a documented convention.
 *
 * `isSensitivePermission` is derived from `permissions_registry.is_sensitive`
 * by the caller; the engine uses it to bypass the L1 cache (sensitive checks
 * are never cached, neither grants nor denials).
 */
export type AbacContext =
  | {
      readonly hasResource: true;
      readonly actorBranchId: string | null;
      readonly resourceBranchId: string;
      readonly resourceAmountMinorUnits?: bigint;
      readonly isSensitivePermission: boolean;
    }
  | {
      readonly hasResource: false;
      readonly actorBranchId: string | null;
      readonly isSensitivePermission: boolean;
    };
