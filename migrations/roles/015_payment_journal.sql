-- migrations/roles/015_payment_journal.sql — MANUAL, ONE-TIME DBA script.
-- Run after migration 0060. The application can resolve active account
-- purposes and append journal evidence; it cannot mutate or delete it.

REVOKE ALL ON accounts, journal_entries, journal_entry_lines FROM app_login;
GRANT SELECT ON accounts TO app_login;
GRANT SELECT, INSERT ON journal_entries, journal_entry_lines TO app_login;

REVOKE ALL ON SEQUENCE journal_entries_entry_number_seq FROM app_login;
GRANT USAGE, SELECT ON SEQUENCE journal_entries_entry_number_seq TO app_login;
