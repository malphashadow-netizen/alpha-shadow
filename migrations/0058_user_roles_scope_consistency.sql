-- Migration 0058 — F-06: enforce user-role scope consistency at the database boundary.
--
-- The permission repositories already reject tenant-scoped assignments with a
-- non-NULL scope_id and branch-scoped assignments with a NULL scope_id. This
-- CHECK mirrors that application-layer validation at the database boundary so
-- raw SQL, future repositories, fixtures, and administrative paths cannot
-- persist an internally inconsistent role assignment.
--
-- Existing deployments may predate this database constraint. Fail explicitly
-- with the number of inconsistent rows before adding the CHECK, rather than
-- relying on PostgreSQL's less descriptive ADD CONSTRAINT validation failure.
--
-- Idempotent: DROP CONSTRAINT IF EXISTS then ADD CONSTRAINT, following the
-- established migration 0048 pattern. No new table or tenant-scoped access
-- path is introduced, so the existing ENABLE + FORCE ROW LEVEL SECURITY policy
-- and role grants remain unchanged.

ALTER TABLE user_roles
  DROP CONSTRAINT IF EXISTS user_roles_scope_consistency_check;

DO $$
DECLARE
  invalid_assignment_count bigint;
BEGIN
  SELECT COUNT(*)
    INTO invalid_assignment_count
    FROM user_roles
   WHERE (scope_type = 'tenant' AND scope_id IS NOT NULL)
      OR (scope_type = 'branch' AND scope_id IS NULL);

  IF invalid_assignment_count > 0 THEN
    RAISE EXCEPTION
      'Cannot enforce user_roles scope consistency: % invalid assignment(s) found',
      invalid_assignment_count
      USING ERRCODE = '23514';
  END IF;
END
$$;

ALTER TABLE user_roles
  ADD CONSTRAINT user_roles_scope_consistency_check
  CHECK (
    (scope_type = 'tenant' AND scope_id IS NULL)
    OR
    (scope_type = 'branch' AND scope_id IS NOT NULL)
  );
