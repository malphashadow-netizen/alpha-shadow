/**
 * Phase 9 — Decision 9: the store-layer classifier that turns a trigger-level
 * `sale_deduction` SHORTAGE rejection (SQLSTATE 23514) into a cashier-safe
 * `InsufficientStockError` must be *surgical*: `23514` alone is not enough,
 * because the same state carries the sign/link/scope CHECKs, the branch
 * assertion and the permission assertion. Only a `23514` whose message begins
 * with the trigger's pinned prefix may be translated; every other shape —
 * including a shortage-looking message on a *different* SQLSTATE — must pass
 * through untouched (fail-closed: never mislabel a security/integrity error
 * as a mere shortage).
 *
 * This is a pure unit test: the classifier operates on synthetic
 * `{ code, message }` objects, no database is touched.
 */
import { describe, expect, it } from 'vitest';

import {
  isStockShortageTriggerError,
  STOCK_SHORTAGE_MESSAGE_PREFIX,
} from '../../../src/infrastructure/db/repositories/postgres-orders-store.ts';
import { InsufficientStockError, toErrorResponse } from '../../../src/shared/errors.ts';

describe('Phase 9 stock-shortage classifier (unit)', () => {
  it('pins the stable trigger-message prefix shared with migration 0040', () => {
    // The migration's RAISE text and this constant MUST stay in lockstep;
    // this assertion is the tripwire that breaks if either side drifts.
    expect(STOCK_SHORTAGE_MESSAGE_PREFIX).toBe('stock: insufficient quantity');
  });

  it('matches ONLY a 23514 that carries the shortage prefix', () => {
    const shortage = {
      code: '23514',
      message:
        'stock: insufficient quantity for sale_deduction without a manager override (item 11111111-2222-3333-4444-555555555555, branch 66666666-7777-8888-9999-000000000000)',
    };
    expect(isStockShortageTriggerError(shortage)).toBe(true);

    // Same SQLSTATE, different CHECK (sign/link/scope/branch/permission) → NOT a shortage.
    expect(isStockShortageTriggerError({ code: '23514', message: 'new row for relation "stock_movements" violates check constraint "stock_movements_type_sign_ck"' })).toBe(false);
    expect(isStockShortageTriggerError({ code: '23514', message: 'stock: branch mismatch: movement branch differs from order branch' })).toBe(false);
    expect(isStockShortageTriggerError({ code: '23514', message: 'stock: permission denied: manual_receiving requires the inventory:receive key' })).toBe(false);
    // Shortage-looking text on a DIFFERENT sqlstate → never translated.
    expect(isStockShortageTriggerError({ code: '40001', message: shortage.message })).toBe(false);
    expect(isStockShortageTriggerError({ code: '23505', message: shortage.message })).toBe(false);
    expect(isStockShortageTriggerError({ code: '42501', message: shortage.message })).toBe(false);
    // Missing or mistyped fields → no match.
    expect(isStockShortageTriggerError({ code: '23514' })).toBe(false);
    expect(isStockShortageTriggerError({ message: shortage.message })).toBe(false);
    expect(isStockShortageTriggerError({ code: '23514', message: 42 })).toBe(false);
    expect(isStockShortageTriggerError({ code: 23514, message: shortage.message })).toBe(false);
    // Non-objects → no match.
    expect(isStockShortageTriggerError(null)).toBe(false);
    expect(isStockShortageTriggerError(undefined)).toBe(false);
    expect(isStockShortageTriggerError('stock: insufficient quantity')).toBe(false);
    expect(isStockShortageTriggerError(23514)).toBe(false);
  });

  it('InsufficientStockError carries the component name, item id and branch for the cashier message', () => {
    const error = new InsufficientStockError('دقيق', '11111111-2222-3333-4444-555555555555', '66666666-7777-8888-9999-000000000000');
    expect(error.code).toBe('inventory.insufficient_stock');
    expect(error.inventoryItemDisplayName).toBe('دقيق');
    expect(error.inventoryItemId).toBe('11111111-2222-3333-4444-555555555555');
    expect(error.branchId).toBe('66666666-7777-8888-9999-000000000000');
    expect(error.message).toContain('دقيق');
    expect(error.message).toContain('66666666-7777-8888-9999-000000000000');
    expect(error.message).toMatch(/manager override/i);
    expect(error).toBeInstanceOf(Error);
  });

  it('toErrorResponse maps it to a retryable 409 carrying the client-safe message', () => {
    const response = toErrorResponse(new InsufficientStockError('دقيق', 'item-id', 'branch-id'));
    expect(response).toMatchObject({ status: 409, code: 'inventory.insufficient_stock' });
    expect(response.message).toContain('دقيق');
  });
});
