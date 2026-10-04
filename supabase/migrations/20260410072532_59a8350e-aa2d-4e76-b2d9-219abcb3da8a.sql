
-- Temporarily disable the immutability triggers
ALTER TABLE general_ledger DISABLE TRIGGER trg_guard_ledger_write;
ALTER TABLE general_ledger DISABLE TRIGGER trg_prevent_ledger_update;
ALTER TABLE general_ledger DISABLE TRIGGER trg_prevent_ledger_delete;

-- Reclassify ghost user entries to test_dev
UPDATE general_ledger
SET classification = 'test_dev'
WHERE user_id IS NOT NULL
  AND classification IN ('legacy_real', 'production')
  AND user_id NOT IN (SELECT id FROM profiles)
  AND user_id NOT IN (SELECT w.user_id FROM wallets w);

-- Re-enable all protection triggers
ALTER TABLE general_ledger ENABLE TRIGGER trg_guard_ledger_write;
ALTER TABLE general_ledger ENABLE TRIGGER trg_prevent_ledger_update;
ALTER TABLE general_ledger ENABLE TRIGGER trg_prevent_ledger_delete;
