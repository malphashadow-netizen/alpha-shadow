-- Migration 0047 — Phase 8b fix (B8): payment idempotency keys.
--
-- A retried collect is currently a NEW attempt (docs/concurrency-and-locking.md
-- §1): a client that times out and retries double-charges the order. The
-- engine now accepts an optional client-generated idempotency key per collect:
-- the FIRST insert wins; any repeat of the same key replays the recorded
-- payment instead of inserting again (same key + different order/amount/method
-- is a 409 — a key identifies exactly one operation).
--
-- The key is scoped per tenant and PARTIAL: legacy rows (and key-less
-- collects) stay NULL and never collide. The unique index is the race arbiter
-- — the engine pre-checks under the B2 order lock for the same-order case and
-- catches 23505 for the cross-order race — so exactly-once holds structurally
-- at the database level, not just by engine discipline.
--
-- Style notes: idempotent (IF NOT EXISTS), no DROP / CASCADE, no RLS change
-- (no new table; the app role's payments grants already cover the column).

ALTER TABLE payments ADD COLUMN IF NOT EXISTS idempotency_key TEXT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_idempotency_key
  ON payments (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
