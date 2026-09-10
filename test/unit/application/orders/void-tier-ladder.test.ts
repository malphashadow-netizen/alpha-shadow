/**
 * Audit F-A pin: the code-side void tier ladder.
 *
 * The database backstop (migration 0054, validate_order_void) re-implements
 * this ladder in SQL (the v_keys CASE). The two MUST stay identical: if this
 * test fails because someone changed the ladder, migration 0054's successor
 * must change with it (and vice versa).
 */
import { describe, expect, it } from 'vitest';
import {
  ORDER_VOID_PERMISSION_KEYS,
  VOID_PERMISSION_TIER_RANK,
} from '../../../../src/domain/contracts/orders.ts';

describe('void tier ladder (audit F-A pin)', () => {
  it('maps every tier to its exact atomic permission key', () => {
    expect({ ...ORDER_VOID_PERMISSION_KEYS }).toEqual({
      server: 'order:void',
      shift_supervisor: 'order:void:shift_supervisor',
      manager: 'order:void:manager',
    });
  });

  it('ranks the tiers server < shift_supervisor < manager', () => {
    expect(VOID_PERMISSION_TIER_RANK.server).toBe(1);
    expect(VOID_PERMISSION_TIER_RANK.shift_supervisor).toBe(2);
    expect(VOID_PERMISSION_TIER_RANK.manager).toBe(3);
  });

  it('has exactly three tiers (no silent fourth rung)', () => {
    expect(Object.keys(ORDER_VOID_PERMISSION_KEYS)).toHaveLength(3);
    expect(Object.keys(VOID_PERMISSION_TIER_RANK)).toHaveLength(3);
  });
});
