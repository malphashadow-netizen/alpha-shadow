/**
 * sec_v derivation unit tests (acceptance criteria 1 & 2).
 *
 *   1. Changing ANY one role among the user's multiple roles changes the hash.
 *   2. Changing only the scope (scope_type / scope_id) of an existing
 *      user_roles row — without touching roleId/roleVersion — changes the hash.
 *
 * Plus determinism (ordering-independent, stable output) and the
 * security_version input, all with the real SHA-256 (`sha256Hex`).
 */
import { describe, expect, it } from 'vitest';

import type { ActiveUserRole } from '../../../src/domain/contracts/permission-repository.ts';
import { deriveSecV, serialiseSecVPayload } from '../../../src/domain/contracts/sec-v.ts';
import { sha256Hex } from '../../../src/shared/crypto.ts';

function role(
  roleId: string,
  roleVersion = 1,
  scopeType: 'tenant' | 'branch' = 'tenant',
  scopeId: string | null = null,
): ActiveUserRole {
  return { roleId, roleVersion, scopeType, scopeId };
}

const secV = (roles: readonly ActiveUserRole[], securityVersion = 1): string =>
  deriveSecV(roles, securityVersion, sha256Hex);

describe('sec_v — changes when any one of the user\'s multiple roles changes', () => {
  it('changes when the role_version of the FIRST of two roles changes', () => {
    const before = secV([role('role-a', 1), role('role-b', 2)]);
    const after = secV([role('role-a', 2), role('role-b', 2)]);
    expect(after).not.toBe(before);
  });

  it('changes when the role_version of the SECOND of two roles changes', () => {
    const before = secV([role('role-a', 1), role('role-b', 2)]);
    const after = secV([role('role-a', 1), role('role-b', 3)]);
    expect(after).not.toBe(before);
  });

  it('changes when ANY role id among three roles changes', () => {
    const before = secV([role('role-a', 1), role('role-b', 1), role('role-c', 1)]);
    const swapped = secV([role('role-a', 1), role('role-b', 1), role('role-c2', 1)]);
    const dropped = secV([role('role-a', 1), role('role-b', 1)]);
    expect(swapped).not.toBe(before);
    expect(dropped).not.toBe(before);
    expect(dropped).not.toBe(swapped);
  });
});

describe('sec_v — changes when only the scope of an existing row changes', () => {
  it('changes when scope_type changes tenant → branch (same roleId, same roleVersion)', () => {
    const tenantScoped = secV([role('role-a', 5, 'tenant', null)]);
    const branchScoped = secV([role('role-a', 5, 'branch', 'branch-1')]);
    expect(branchScoped).not.toBe(tenantScoped);
  });

  it('changes when scope_id changes branch-1 → branch-2 (scope_type unchanged)', () => {
    const branchOne = secV([role('role-a', 5, 'branch', 'branch-1')]);
    const branchTwo = secV([role('role-a', 5, 'branch', 'branch-2')]);
    expect(branchTwo).not.toBe(branchOne);
  });

  it('changes when scope changes among MULTIPLE roles without touching roleId/roleVersion', () => {
    const before = secV([role('role-a', 1, 'tenant', null), role('role-b', 1, 'branch', 'branch-1')]);
    const after = secV([role('role-a', 1, 'branch', 'branch-1'), role('role-b', 1, 'tenant', null)]);
    expect(after).not.toBe(before);
  });
});

describe('sec_v — determinism and inputs', () => {
  it('is deterministic regardless of input ordering (sorted by roleId, then scopeId)', () => {
    const a = role('role-a', 1, 'branch', 'branch-1');
    const b = role('role-b', 2, 'tenant', null);
    expect(secV([a, b])).toBe(secV([b, a]));
  });

  it('produces the same value for the same input', () => {
    const roles = [role('role-a', 1), role('role-b', 2, 'branch', 'branch-9')];
    expect(secV(roles)).toBe(secV(roles));
  });

  it('changes when users.security_version changes', () => {
    const roles = [role('role-a', 1)];
    expect(secV(roles, 1)).not.toBe(secV(roles, 2));
  });

  it('serialises the quadruples as a fixed sorted JSON array including the scope', () => {
    const payload = serialiseSecVPayload([role('role-b', 2, 'branch', 'branch-1'), role('role-a', 1, 'tenant', null)], 7);
    const parsed = JSON.parse(payload) as { roles: unknown[][]; securityVersion: number };
    expect(parsed.securityVersion).toBe(7);
    expect(parsed.roles).toEqual([
      ['role-a', 1, 'tenant', null],
      ['role-b', 2, 'branch', 'branch-1'],
    ]);
  });
});
