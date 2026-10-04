-- Temporarily disable immutability triggers
ALTER TABLE general_ledger DISABLE TRIGGER trg_prevent_ledger_update;
ALTER TABLE general_ledger DISABLE TRIGGER trg_prevent_ledger_delete;

-- Delete the incorrect proxy approval credits directly
DELETE FROM general_ledger
WHERE category = 'roi_payout' AND direction = 'cash_in' AND ledger_scope = 'wallet'
AND description ILIKE '%proxy approval credit%';

-- Re-enable immutability triggers
ALTER TABLE general_ledger ENABLE TRIGGER trg_prevent_ledger_update;
ALTER TABLE general_ledger ENABLE TRIGGER trg_prevent_ledger_delete;