/**
 * B3 — mapPostgresError classifier (pure unit test, no database).
 *
 * The classifier is SURGICAL: only the three concurrency SQLSTATEs —
 * `40001` (serialization failure), `40P01` (deadlock detected), `55P03`
 * (lock_timeout) — are translated into the retryable
 * `ConcurrencyRetryableError`. Everything else MUST pass through BY IDENTITY
 * (fail-closed: never mislabel a constraint violation, a permission denial,
 * or a connection failure as "just retry").
 */
import { describe, expect, it } from 'vitest';

import { mapPostgresError } from '../../../src/infrastructure/db/postgres-errors.ts';
import {
  ConcurrencyRetryableError,
  InsufficientStockError,
  toErrorResponse,
  ValidationError,
} from '../../../src/shared/errors.ts';

const CONCURRENCY_CODES = ['40001', '40P01', '55P03'] as const;

describe('B3 mapPostgresError classifier (unit)', () => {
  it.each(CONCURRENCY_CODES)('maps %s to a retryable ConcurrencyRetryableError', (pgCode) => {
    const original = { code: pgCode, message: `pg says: ${pgCode}` };
    const mapped = mapPostgresError(original);

    expect(mapped).toBeInstanceOf(ConcurrencyRetryableError);
    expect(mapped).toMatchObject({
      code: 'concurrency.retryable_conflict',
      pgCode,
      cause: original,
    });
    // Client-safe message: no pg internals leak, retry guidance present.
    expect((mapped as ConcurrencyRetryableError).message).toMatch(/retry/i);
    expect((mapped as ConcurrencyRetryableError).message).not.toContain('pg says');
  });

  it('passes every other shape through BY IDENTITY (fail-closed)', () => {
    const passthrough: unknown[] = [
      { code: '23505', message: 'duplicate key' }, // unique violation — NOT retryable-as-success
      { code: '23503', message: 'fk violation' }, // integrity — never retryable
      { code: '40001', message: 'x' }, // placeholder replaced below by numeric-code object
      { message: 'no code at all' }, // quacks without .code
      new ValidationError('bad input'), // already-mapped domain errors keep their identity
      new InsufficientStockError('دقيق', 'item-id', 'branch-id'),
      new Error('plain error'),
      null,
      undefined,
      '40001', // bare primitives, even code-looking ones
      40001,
    ];
    // A NUMERIC code must NOT quack-match: pg always reports string SQLSTATEs.
    passthrough[2] = { code: 40001, message: 'numeric impostor' };

    for (const value of passthrough) {
      expect(mapPostgresError(value)).toBe(value);
    }
  });

  it('serializes the retryable error as HTTP 503 with the stable code', () => {
    const mapped = mapPostgresError({ code: '40P01', message: 'deadlock detected' });
    const response = toErrorResponse(mapped, () => undefined);

    expect(response.status).toBe(503);
    expect(response.code).toBe('concurrency.retryable_conflict');
    expect(response.message).toMatch(/retry/i);
  });
});
