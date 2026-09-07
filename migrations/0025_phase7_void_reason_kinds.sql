-- Migration 0025 — Phase 7 (8/10): platform-level void reason kinds.
--
-- Fixed platform vocabulary for void/modify audit classification. Tenants
-- never create/mutate/delete a kind: they attach their own free-form reasons
-- to a kind (migration 0026, mandatory FK) and may DISABLE a kind for future
-- use (tenant_void_reason_kind_settings.is_enabled) — disabling NEVER deletes
-- historical order_voids rows, which keeps the audit/reporting history intact.
-- Same platform-protection pattern as order_status_kinds (0018) and
-- sales_channels (0011): guard trigger + REVOKE + SELECT-only app grants.
--
-- Style notes: idempotent, no DROP TABLE / CASCADE, seeded platform reference
-- data (0011 precedent). No tenant_id column by design → no tenant RLS
-- template applies (global registry class).

CREATE TABLE IF NOT EXISTS void_reason_kinds (
  code text PRIMARY KEY CHECK (btrim(code) <> ''),
  name jsonb NOT NULL CHECK (jsonb_typeof(name) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_platform_void_reason_kind_write ON void_reason_kinds;
CREATE TRIGGER trg_platform_void_reason_kind_write BEFORE INSERT OR UPDATE OR DELETE ON void_reason_kinds
  FOR EACH ROW EXECUTE FUNCTION guard_platform_order_write();

REVOKE ALL ON void_reason_kinds FROM PUBLIC;

INSERT INTO void_reason_kinds (code, name) VALUES
  ('customer_request', '{"ar":"طلب العميل","en":"Customer request"}'),
  ('order_error', '{"ar":"خطأ في الطلب","en":"Order error"}'),
  ('delay', '{"ar":"تأخير","en":"Delay"}'),
  ('kitchen_issue', '{"ar":"مشكلة من المطبخ","en":"Kitchen issue"}'),
  ('quality_issue', '{"ar":"مشكلة جودة","en":"Quality issue"}'),
  ('fraud_suspected', '{"ar":"اشتباه تلاعب","en":"Fraud suspected"}')
ON CONFLICT (code) DO NOTHING;
