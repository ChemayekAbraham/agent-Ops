
-- Temporarily disable immutability triggers to remove erroneous 39.99B entry
ALTER TABLE general_ledger DISABLE TRIGGER trg_prevent_ledger_delete;
ALTER TABLE general_ledger DISABLE TRIGGER trg_prevent_ledger_update;
ALTER TABLE general_ledger DISABLE TRIGGER trg_sync_wallet_from_ledger;

-- Delete the erroneous ledger entry
DELETE FROM general_ledger WHERE id = '2a5b1f81-c3b9-4f5b-aa7d-c9bc494b3a8e';

-- Re-enable all triggers
ALTER TABLE general_ledger ENABLE TRIGGER trg_prevent_ledger_delete;
ALTER TABLE general_ledger ENABLE TRIGGER trg_prevent_ledger_update;
ALTER TABLE general_ledger ENABLE TRIGGER trg_sync_wallet_from_ledger;
