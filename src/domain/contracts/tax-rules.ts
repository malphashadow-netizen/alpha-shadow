import { ExciseConfirmationRequiredError, TaxConfigurationError, ValidationError } from '../../shared/errors.ts';
import type { TaxCategory } from './tax.ts';
import { EXCISE_CONFIRMATION_TEXT } from './tenant-tax-admin.ts';

export function assertCountryCode(code: string): void {
  if (!/^[A-Z]{2}$/.test(code)) throw new ValidationError('countryCode must be two uppercase letters', 'countryCode');
}
export function assertTaxDate(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) {
    throw new ValidationError('Expected a finite YYYY-MM-DD tax calendar date');
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new ValidationError('Invalid tax calendar date');
  }
}
export function assertTaxDateRange(from: string, to: string | null): void {
  assertTaxDate(from);
  if (to !== null) {
    assertTaxDate(to);
    if (to < from) throw new ValidationError('Tax effectiveTo must not precede effectiveFrom');
  }
}
/** Rate dates follow the BRANCH local day, never the database/server timezone. */
export function taxDateInTimezone(at: Date, timeZone: string): string {
  if (!Number.isFinite(at.getTime())) throw new ValidationError('Invalid tax transaction time', 'at');
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at);
  } catch {
    throw new ValidationError('Invalid branch timezone', 'timezone');
  }
  const part = (key: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === key)?.value ?? '';
  const result = `${part('year')}-${part('month')}-${part('day')}`;
  assertTaxDate(result);
  return result;
}
export function assertExciseConfirmation(confirmation: string): void {
  if (confirmation !== EXCISE_CONFIRMATION_TEXT) throw new ExciseConfirmationRequiredError();
}
export function assertOrdinaryTaxCategory(category: TaxCategory): void {
  if (!category.isActive) throw new TaxConfigurationError('Tax category is inactive');
  if (category.taxFamily === 'excise') throw new ExciseConfirmationRequiredError();
}
export function sortTaxCategories(categories: readonly TaxCategory[]): TaxCategory[] {
  const sorted = [...categories].sort((a, b) => a.cascadePriority - b.cascadePriority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (new Set(sorted.map((c) => c.id)).size !== sorted.length) {
    throw new TaxConfigurationError('Multiple category assignments resolve to the same tax category');
  }
  const excise = sorted.filter((c) => c.taxFamily === 'excise');
  const vat = sorted.filter((c) => c.taxFamily === 'vat');
  if (excise.some((e) => vat.some((v) => e.cascadePriority >= v.cascadePriority))) {
    throw new TaxConfigurationError('Every excise priority must be strictly lower than every VAT priority');
  }
  return sorted;
}
