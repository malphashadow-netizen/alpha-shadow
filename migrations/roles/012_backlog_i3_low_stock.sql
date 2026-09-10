-- Roles 012 — Backlog (I3): grants for low-stock events + branch mutes.
--
-- MANUAL DBA FILE (007 mirror): applied by the DBA alongside migration 0050.
-- Never add grants for new tables to an already-pushed roles file.
--
--   * inventory_events_outbox: SELECT + INSERT only (append-only evidence,
--     same as order_events_outbox — no UPDATE/DELETE for the app role).
--   * inventory_event_sequences: SELECT + INSERT + UPDATE (the allocator
--     INSERTs-once then UPDATEs-under-lock; no DELETE).
--   * low_stock_mutes: SELECT + INSERT + UPDATE + DELETE. Re-muting
--     refreshes actor + time via ON CONFLICT DO UPDATE, and PostgreSQL
--     demands the UPDATE privilege to plan an upsert even when no conflict
--     occurs; unmuting deletes the row.

-- ── inventory outbox (migration 0050) ──────────────────────────────────────
REVOKE ALL ON inventory_events_outbox, inventory_event_sequences FROM app_login;
GRANT SELECT, INSERT ON inventory_events_outbox TO app_login;
GRANT SELECT, INSERT, UPDATE ON inventory_event_sequences TO app_login;

-- ── branch mutes (migration 0050) ──────────────────────────────────────────
REVOKE ALL ON low_stock_mutes FROM app_login;
GRANT SELECT, INSERT, UPDATE, DELETE ON low_stock_mutes TO app_login;
