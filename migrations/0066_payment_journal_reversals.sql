-- Migration 0066 — DD-004 payment void/refund journal reversals.
--
-- Each completed-payment journal entry can have one immutable, tenant-safe
-- reversal entry. The reversal records a later financial event; it never
-- updates or deletes the original entry.

ALTER TABLE journal_entries
  ADD COLUMN IF NOT EXISTS reversal_of_journal_entry_id uuid;

ALTER TABLE journal_entries
  DROP CONSTRAINT IF EXISTS journal_entries_reversal_of_tenant_fkey;
ALTER TABLE journal_entries
  ADD CONSTRAINT journal_entries_reversal_of_tenant_fkey
  FOREIGN KEY (reversal_of_journal_entry_id, tenant_id)
  REFERENCES journal_entries (id, tenant_id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS journal_entries_one_reversal_per_original_idx
  ON journal_entries (tenant_id, reversal_of_journal_entry_id)
  WHERE reversal_of_journal_entry_id IS NOT NULL;
