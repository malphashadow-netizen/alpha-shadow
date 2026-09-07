/**
 * `sec_v` derivation — the full, deterministic contract (no freedom of choice).
 *
 *  1. Take every ACTIVE user_roles row (`is_active = true`) for the user.
 *  2. For each row build the quadruple `(roleId, roleVersion, scopeType,
 *     scopeId)` — the scope is INCLUDED so an UPDATE that only changes the
 *     scope (without touching roleId/roleVersion) also invalidates the token.
 *  3. Sort the list ascending by `roleId`, then by `scopeId` (determinism).
 *  4. Serialise the quadruples + `user.security_version` into one fixed-format
 *     JSON text (a sorted JSON array).
 *  5. Apply SHA-256 to that text → the hex digest IS `sec_v`.
 *
 * The domain layer is a pure core (zero external deps, no `node:crypto`), so
 * the hash function is INJECTED; production injects `sha256Hex` from
 * `src/shared/crypto.ts`.
 */

import type { ActiveUserRole } from './permission-repository.ts';

export type SecVHash = (text: string) => string;

function compareScopeId(left: string | null, right: string | null): number {
  if (left === right) return 0;
  if (left === null) return -1;
  if (right === null) return 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareTuples(left: readonly unknown[], right: readonly unknown[]): number {
  const leftRoleId = left[0];
  const rightRoleId = right[0];
  if (typeof leftRoleId === 'string' && typeof rightRoleId === 'string') {
    if (leftRoleId < rightRoleId) return -1;
    if (leftRoleId > rightRoleId) return 1;
  }
  const leftScopeId = left[3];
  const rightScopeId = right[3];
  if (leftScopeId === null || typeof leftScopeId === 'string') {
    if (rightScopeId === null || typeof rightScopeId === 'string') {
      return compareScopeId(leftScopeId, rightScopeId);
    }
  }
  return 0;
}

/** Serialises the quadruples + securityVersion into the fixed JSON text. */
export function serialiseSecVPayload(roles: readonly ActiveUserRole[], securityVersion: number): string {
  const tuples: readonly (readonly [string, number, string, string | null])[] = roles.map((r) => [
    r.roleId,
    r.roleVersion,
    r.scopeType,
    r.scopeId,
  ]);
  const sorted = [...tuples].sort(compareTuples);
  return JSON.stringify({ roles: sorted, securityVersion });
}

/** Computes sec_v: SHA-256 hex digest of the fixed-format payload. */
export function deriveSecV(roles: readonly ActiveUserRole[], securityVersion: number, hash: SecVHash): string {
  return hash(serialiseSecVPayload(roles, securityVersion));
}
