-- Temporarily disable immutability triggers for metadata backfill
ALTER TABLE general_ledger DISABLE TRIGGER trg_prevent_ledger_update;
ALTER TABLE general_ledger DISABLE TRIGGER trg_prevent_ledger_delete;

-- Backfill all NULL transaction_group_id entries
UPDATE general_ledger
SET transaction_group_id = gen_random_uuid()
WHERE transaction_group_id IS NULL;

-- Re-enable immutability triggers
ALTER TABLE general_ledger ENABLE TRIGGER trg_prevent_ledger_update;
ALTER TABLE general_ledger ENABLE TRIGGER trg_prevent_ledger_delete;

-- Set default so future entries always get a group ID
ALTER TABLE general_ledger
ALTER COLUMN transaction_group_id SET DEFAULT gen_random_uuid();