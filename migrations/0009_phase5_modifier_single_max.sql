-- Migration 0009 — Phase 5 hotfix: selection_type='single' implies max_selections is 1 or NULL.
--
-- 0008 is not modified. A single-choice group cannot advertise a cap other
-- than one (or NULL, which the engine treats as "no extra cap" for a
-- single-choice group). Defence in depth for CatalogEngine.assertSelectionTypeConsistency.
--
-- Idempotent: DROP CONSTRAINT IF EXISTS then ADD CONSTRAINT.
-- NO DROP TABLE. NO CASCADE.

ALTER TABLE modifier_groups DROP CONSTRAINT IF EXISTS modifier_groups_single_max;

ALTER TABLE modifier_groups
  ADD CONSTRAINT modifier_groups_single_max
  CHECK (selection_type <> 'single' OR max_selections IS NULL OR max_selections = 1);
