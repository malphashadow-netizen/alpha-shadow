-- Migration 0052 — Backlog (I3 follow-up): canonicalize the 0050 RLS policies.
--
-- WHAT: 0050's three tenant_isolation policies used the two-arg
-- current_setting('app.current_tenant_id', true) form. The repo's locked RLS
-- template (and the rls-coverage contract test) demands the single-arg form
-- current_setting('app.current_tenant_id') — the predicate every other
-- tenant table carries. This migration recreates the three policies
-- byte-identical to the template. No table, constraint, grant, or data
-- change; 0050 itself stands as-pushed.
--
-- WHY single-arg: inside a tenant context the GUC is always SET
-- (fail-closed at withTenantContext); outside one, single-arg
-- current_setting ERRORS — the desired fail-closed behavior for a tenant
-- table (fail loudly, never silently match NULL). The two-arg form belongs
-- to guards that must distinguish "no context" from "wrong context"
-- (guard_platform_*, audit_log's exempted policy) — never to row
-- predicates. Found by the full suite (rls-coverage contract test), not by
-- the phase9 file alone.
--
-- DEPENDS ON: 0050.

DROP POLICY IF EXISTS tenant_isolation ON inventory_event_sequences;
CREATE POLICY tenant_isolation ON inventory_event_sequences
  FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON inventory_events_outbox;
CREATE POLICY tenant_isolation ON inventory_events_outbox
  FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON low_stock_mutes;
CREATE POLICY tenant_isolation ON low_stock_mutes
  FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);
