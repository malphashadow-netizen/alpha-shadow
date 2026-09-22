-- جدول قواعد الانتقال (بيانات، Decision D-1 — قرار تصميمي جديد موثّق، غير مستخرج من كود سابق)
CREATE TABLE IF NOT EXISTS compliance_document_status_transitions (
  from_status text NOT NULL,
  to_status text NOT NULL,
  PRIMARY KEY (from_status, to_status)
);
INSERT INTO compliance_document_status_transitions (from_status, to_status) VALUES
  ('DRAFT', 'FINALIZED'),
  ('FINALIZED', 'COMPLIANCE_PENDING'),
  ('COMPLIANCE_PENDING', 'GENERATED'),
  ('GENERATED', 'SIGNED'),
  ('SIGNED', 'SUBMITTED'),
  ('SUBMITTED', 'ACCEPTED'),
  ('SUBMITTED', 'REPORTED'),
  ('SUBMITTED', 'REJECTED'),
  ('SUBMITTED', 'FAILED'),
  ('FAILED', 'RETRY'),
  ('RETRY', 'GENERATED')
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS compliance_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  branch_id uuid NOT NULL,
  order_id uuid NOT NULL,
  document_type text NOT NULL CHECK (btrim(document_type) <> ''),
  country_code char(2) NOT NULL REFERENCES tax_jurisdictions (country_code),
  authority_id uuid NOT NULL,
  settlement_mode text NOT NULL
    CHECK (settlement_mode IN ('synchronous_clearance', 'asynchronous_reporting')),
  document_status text NOT NULL DEFAULT 'DRAFT',
  document_hash text,
  artifact_reference text,
  artifact_hash text,
  external_reference text,
  submission_attempt_no integer NOT NULL DEFAULT 0 CHECK (submission_attempt_no >= 0),
  last_error text,
  next_retry_at timestamptz,
  submitted_at timestamptz,
  settled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT compliance_documents_id_tenant_key UNIQUE (id, tenant_id),
  FOREIGN KEY (branch_id, tenant_id) REFERENCES branches (id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (order_id, tenant_id) REFERENCES orders (id, tenant_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_compliance_documents_tenant_id ON compliance_documents (tenant_id);
CREATE INDEX IF NOT EXISTS idx_compliance_documents_order ON compliance_documents (tenant_id, order_id);
CREATE INDEX IF NOT EXISTS idx_compliance_documents_status ON compliance_documents (tenant_id, document_status);
CREATE INDEX IF NOT EXISTS idx_compliance_documents_retry
  ON compliance_documents (next_retry_at) WHERE document_status = 'RETRY';

ALTER TABLE compliance_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE compliance_documents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON compliance_documents
  FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE TABLE IF NOT EXISTS compliance_document_transitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  compliance_document_id uuid NOT NULL,
  order_id uuid NOT NULL,
  from_status text,
  to_status text NOT NULL,
  reason text,
  submission_attempt_no integer,
  actor_user_id uuid,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (compliance_document_id, tenant_id)
    REFERENCES compliance_documents (id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (order_id, tenant_id) REFERENCES orders (id, tenant_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX idx_compliance_document_transitions_single_initial
  ON compliance_document_transitions (tenant_id, compliance_document_id)
  WHERE from_status IS NULL;
CREATE INDEX IF NOT EXISTS idx_compliance_document_transitions_tenant_id
  ON compliance_document_transitions (tenant_id);
CREATE INDEX IF NOT EXISTS idx_compliance_document_transitions_document
  ON compliance_document_transitions (tenant_id, compliance_document_id, occurred_at);

ALTER TABLE compliance_document_transitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE compliance_document_transitions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON compliance_document_transitions
  FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE FUNCTION validate_compliance_document_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_current text;
BEGIN
  SELECT document_status INTO v_current FROM public.compliance_documents
    WHERE id = NEW.compliance_document_id AND tenant_id = NEW.tenant_id;
  IF v_current IS NULL THEN
    RAISE EXCEPTION 'transition must reference a compliance document of the same tenant' USING ERRCODE = '23514';
  END IF;

  IF NEW.from_status IS NULL THEN
    IF NEW.to_status IS DISTINCT FROM 'DRAFT' THEN
      RAISE EXCEPTION 'the initial transition (from NULL) must target DRAFT' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NEW.from_status IS DISTINCT FROM v_current THEN
      RAISE EXCEPTION 'from_status must equal the document''s current status: the event row is written before any derived update' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.compliance_document_status_transitions t
      WHERE t.from_status = NEW.from_status AND t.to_status = NEW.to_status) THEN
      RAISE EXCEPTION 'illegal compliance document status transition: % -> %', NEW.from_status, NEW.to_status
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.actor_user_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.users u WHERE u.id = NEW.actor_user_id AND u.tenant_id = NEW.tenant_id AND u.is_active) THEN
    RAISE EXCEPTION 'transition actor must be an active user of the same tenant' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_validate_compliance_document_transition
  BEFORE INSERT ON compliance_document_transitions
  FOR EACH ROW EXECUTE FUNCTION validate_compliance_document_transition();

CREATE FUNCTION apply_compliance_document_status() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('app.compliance_derived_write', '1', true);
  UPDATE public.compliance_documents SET
    document_status = NEW.to_status,
    submission_attempt_no = CASE WHEN NEW.to_status = 'SUBMITTED'
      THEN submission_attempt_no + 1 ELSE submission_attempt_no END,
    submitted_at = CASE WHEN NEW.to_status = 'SUBMITTED' AND submitted_at IS NULL
      THEN NEW.occurred_at ELSE submitted_at END,
    settled_at = CASE WHEN NEW.to_status IN ('ACCEPTED', 'REPORTED') AND settled_at IS NULL
      THEN NEW.occurred_at ELSE settled_at END,
    last_error = CASE WHEN NEW.to_status = 'FAILED' THEN NEW.reason ELSE last_error END
  WHERE id = NEW.compliance_document_id AND tenant_id = NEW.tenant_id;
  PERFORM set_config('app.compliance_derived_write', '', true);
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_apply_compliance_document_status
  AFTER INSERT ON compliance_document_transitions
  FOR EACH ROW EXECUTE FUNCTION apply_compliance_document_status();

CREATE FUNCTION guard_compliance_document_derived_status() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.document_status IS DISTINCT FROM OLD.document_status
     AND NULLIF(current_setting('app.compliance_derived_write', true), '') IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'compliance_documents.document_status is derived from compliance_document_transitions; direct writes are forbidden' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_compliance_documents_derived_status_guard
  BEFORE UPDATE ON compliance_documents
  FOR EACH ROW EXECUTE FUNCTION guard_compliance_document_derived_status();

CREATE FUNCTION require_initial_compliance_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.compliance_document_transitions
    WHERE compliance_document_id = NEW.id AND tenant_id = NEW.tenant_id AND from_status IS NULL) THEN
    RAISE EXCEPTION 'a compliance_document must be created together with its initial (NULL -> DRAFT) transition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER trg_require_initial_compliance_transition
  AFTER INSERT ON compliance_documents
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_initial_compliance_transition();

REVOKE ALL ON compliance_documents, compliance_document_transitions,
  compliance_document_status_transitions FROM PUBLIC;
