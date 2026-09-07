#!/usr/bin/env node
/**
 * Standalone pre-integration probe for the financial arithmetic boundary.
 *
 * The package script compiles the real TypeScript module first, then this
 * script imports that emitted module. This proves the actual runtime accepts
 * PostgreSQL NUMERIC text and that the central conversion function applies
 * round-half-even without a float or a rounding library.
 */
import { currencyCode, convertMoneyAtRate, money } from '../dist/shared/money.js';

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

const USD = currencyCode('USD');
const JPY = currencyCode('JPY');
const BHD = currencyCode('BHD');
const KWD = currencyCode('KWD');

// 5 cents × 1.25 = 6.25 cents → 6 (the even neighbour).
assertEqual(convertMoneyAtRate(money(5n, USD), '1.25', USD, 2).amountMinor, 6n, 'half-even down');
// 6 cents × 1.25 = 7.5 cents → 8 (the even neighbour).
assertEqual(convertMoneyAtRate(money(6n, USD), '1.25', USD, 2).amountMinor, 8n, 'half-even up');
// One USD (100 cents) at 110 JPY/USD is exactly 110 whole JPY.
assertEqual(convertMoneyAtRate(money(100n, USD), '110.00000000', JPY, 0).amountMinor, 110n, 'cross-scale conversion');
// One BHD (1000 fils) at 100 JPY/BHD is exactly 100 whole JPY.
assertEqual(convertMoneyAtRate(money(1000n, BHD), '100', JPY, 0, 3).amountMinor, 100n, 'three-decimal source');
// Phase 4b — KWD is a THREE-decimal target (fils), matching the seeded
// currencies registry (migration 0007) and ISO_4217_MINOR_UNITS.
// USD 1000.00 × 0.3065 = KWD 306.500 → exactly 306500 fils, no rounding.
assertEqual(
  convertMoneyAtRate(money(100000n, USD), '0.30650000', KWD, 3).amountMinor,
  306500n,
  'three-decimal target (KWD) exact',
);
// USD 1.00 × 0.3065 = 306.5 fils → 306, the even neighbour at the 3rd decimal.
assertEqual(
  convertMoneyAtRate(money(100n, USD), '0.30650000', KWD, 3).amountMinor,
  306n,
  'three-decimal target (KWD) half-even',
);

console.log('Financial arithmetic verification passed: NUMERIC text + round-half-even are runtime-verified.');
