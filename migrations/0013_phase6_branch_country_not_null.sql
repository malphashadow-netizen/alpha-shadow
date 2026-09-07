-- CONTRACT: separate deployment step, only after a verified manual backfill.
-- The runner sets this transaction-local flag ONLY after operator opt-in.
-- Lock before checking so a concurrent writer cannot introduce another NULL.
LOCK TABLE branches IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF current_setting('app.phase6_branch_country_backfill_confirmed', true) IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'Confirm branch-country backfill explicitly before applying 0013' USING ERRCODE = '23514';
  END IF;
END;
$$;
-- PostgreSQL scans all rows (not just those visible under a tenant policy).
-- A single NULL aborts this migration/transaction; no default/backfill exists.
ALTER TABLE branches ALTER COLUMN country_code SET NOT NULL;
