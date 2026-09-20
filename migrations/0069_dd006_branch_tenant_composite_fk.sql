-- Migration 0069 — same-tenant branch references (defence in depth).
--
-- PostgreSQL referential-integrity checks bypass row security. The original
-- single-column FKs therefore prove only that a branch id exists, not that its
-- tenant owns the referencing row. Migration 0012 already provides the
-- branches (id, tenant_id) candidate key used by these composite constraints.
-- Existing rows are validated when each constraint is added.

ALTER TABLE users
  ADD CONSTRAINT users_branch_tenant_fkey
  FOREIGN KEY (branch_id, tenant_id) REFERENCES branches (id, tenant_id)
  ON DELETE RESTRICT;

ALTER TABLE inventory_items
  ADD CONSTRAINT inventory_items_branch_tenant_fkey
  FOREIGN KEY (branch_id, tenant_id) REFERENCES branches (id, tenant_id)
  ON DELETE RESTRICT;

COMMENT ON CONSTRAINT users_branch_tenant_fkey ON users IS
  'Composite defence-in-depth FK: tenant_id participates in branch ownership because FK checks bypass RLS.';
COMMENT ON CONSTRAINT inventory_items_branch_tenant_fkey ON inventory_items IS
  'Composite defence-in-depth FK: tenant_id participates in branch ownership because FK checks bypass RLS.';
