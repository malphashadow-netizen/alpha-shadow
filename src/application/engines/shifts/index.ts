/**
 * Shifts engine — Phase 8.
 *
 * The shift gateway: every NEW order and every payment for a cashier requires
 * that cashier's standing status='open' shift (enforced by the order-creation
 * engine, the payments engine and the payments DB validation trigger).
 *
 * Every permission registered for this surface uses the `resource:action` key
 * format and sets `is_sensitive = true` for money-affecting actions (see the
 * payments permissions, migration 0031). The shift lifecycle itself is
 * controlled by DUAL VERIFICATION (two distinct people at open and at close),
 * not by an extra permission key — the Phase-8 closed spec defines no
 * shift:open/shift:close keys.
 */
export { ShiftEngine } from './shift-engine.ts';
export type { XReport } from './shift-engine.ts';
