/**
 * B3: PostgreSQL concurrency-control mapping — the ONLY production place that
 * translates SQLSTATEs into the retryable domain error.
 *
 * Mapped (the transaction rolled back cleanly; the client retries):
 *   40001 serialization_failure — a REPEATABLE READ loser: a concurrent
 *         transaction committed a conflicting write first (the B2 order/shift
 *         locks + revision bumps steer every race here by design);
 *   40P01 deadlock_detected     — the detector aborted one side of a lock
 *         cycle (uniform lock order makes these rare; see
 *         docs/concurrency-and-locking.md finding F-1 for the known residual);
 *   55P03 lock_not_available    — a lock wait exceeded `lock_timeout`, or a
 *         NOWAIT lock attempt failed (bounded waits, never a stuck pool slot).
 *
 * Everything else passes through by IDENTITY (same reference): business
 * errors, trigger rejections (23514/23505/…), connection failures, and
 * compound AggregateErrors (operation + ROLLBACK both failed — a 500-class
 * operational incident, never silently retried).
 */
import { ConcurrencyRetryableError } from '../../shared/errors.ts';

type ConcurrencyPgCode = '40001' | '40P01' | '55P03';

function concurrencyPgCodeOf(error: unknown): ConcurrencyPgCode | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null;
  const code: unknown = error.code;
  if (code === '40001' || code === '40P01' || code === '55P03') return code;
  return null;
}

/**
 * Maps a raw transaction failure to ConcurrencyRetryableError when it is a
 * PostgreSQL concurrency-control death (40001/40P01/55P03); returns the
 * ORIGINAL reference untouched otherwise. Pure — safe to apply at any single
 * throw site (withTenantContext, platform wrapper).
 */
export function mapPostgresError(error: unknown): unknown {
  const pgCode = concurrencyPgCodeOf(error);
  if (pgCode === null) return error;
  return new ConcurrencyRetryableError(pgCode, { cause: error });
}
