/**
 * Pure catalog invariants — no I/O, no language allow-list, no hardcoded
 * section/item/modifier values. The engine applies these before persistence;
 * PostgreSQL CHECKs / ON DELETE RESTRICT are defence in depth.
 */
import { ValidationError } from '../../shared/errors.ts';
import type { LocalizedText } from './catalog.ts';

export interface ParseLocalizedTextOptions {
  readonly allowEmpty: boolean;
}

/**
 * Accepts ANY language key. There is deliberately no list of codes, no
 * default of `ar`/`en`, and no case-folding of keys — the payload is data.
 */
export function parseLocalizedText(
  value: unknown,
  field: string,
  options: ParseLocalizedTextOptions,
): LocalizedText {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError(`${field} must be a JSON object of language-key → string`, field);
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (!options.allowEmpty && entries.length === 0) {
    throw new ValidationError(`${field} must contain at least one language key`, field);
  }
  const result: Record<string, string> = {};
  for (const [key, text] of entries) {
    if (key.trim() === '') {
      throw new ValidationError(`${field} language keys must be non-empty`, field);
    }
    if (typeof text !== 'string' || text.trim() === '') {
      throw new ValidationError(`${field} values must be non-empty strings`, field);
    }
    result[key] = text;
  }
  return Object.freeze(result);
}

/**
 * `selection_type = 'single'` means at most one choice. `max_selections` may
 * be `1` or `NULL` (NULL = unbounded at the column, interpreted as one for
 * a single-choice group). Any other positive cap is contradictory.
 */
export function assertSelectionTypeConsistency(selectionType: string, maxSelections: number | null): void {
  if (selectionType === 'single' && maxSelections !== null && maxSelections !== 1) {
    throw new ValidationError(
      'selection_type "single" requires max_selections to be 1 or null',
      'maxSelections',
    );
  }
}

/** Rejects min_selections > max_selections when max is not NULL. */
export function assertMinMaxSelections(minSelections: number, maxSelections: number | null): void {
  if (!Number.isInteger(minSelections) || minSelections < 0) {
    throw new ValidationError('min_selections must be a non-negative integer', 'minSelections');
  }
  if (maxSelections !== null) {
    if (!Number.isInteger(maxSelections) || maxSelections < 0) {
      throw new ValidationError('max_selections must be a non-negative integer or null', 'maxSelections');
    }
    if (minSelections > maxSelections) {
      throw new ValidationError('min_selections must not exceed max_selections', 'minSelections');
    }
  }
}

/**
 * Walks the parent chain with no depth cap. Returns true when `categoryId`
 * would appear in its own ancestry (self-parent or a longer cycle).
 *
 * `parentById` is data loaded from the store — the walk never assumes a
 * maximum tree height.
 */
export function parentChainContains(
  categoryId: string,
  startParentId: string | null,
  parentById: ReadonlyMap<string, string | null>,
): boolean {
  const seen = new Set<string>();
  let cursor: string | null = startParentId;
  while (cursor !== null) {
    if (cursor === categoryId) return true;
    if (seen.has(cursor)) return true;
    seen.add(cursor);
    if (!parentById.has(cursor)) return false;
    const next = parentById.get(cursor);
    cursor = next === undefined ? null : next;
  }
  return false;
}
