
-- Fix jahlk's wallet balance to match ledger (1M in - 500k out = 500k)
UPDATE wallets 
SET balance = 500000, updated_at = now() 
WHERE user_id = '24b115d5-25ba-4cce-8b3b-2fa99ec93bc8' AND balance = 0;

-- Corrective ledger entry for audit trail
INSERT INTO general_ledger (user_id, amount, direction, category, source_table, description, reference_id)
VALUES (
  '24b115d5-25ba-4cce-8b3b-2fa99ec93bc8',
  500000,
  'cash_in',
  'balance_correction',
  'wallets',
  'Correction: Wallet resync to match ledger. Net ledger = 1M (activation) - 500k (rent fund) = 500k.',
  'WBC260306-FIX1'
);
