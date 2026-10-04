
-- Add UGX 500,000 test funds to SSENKAALI PIUS (agent) wallet
UPDATE wallets 
SET balance = balance + 500000, updated_at = now()
WHERE user_id = '0b109aad-212a-4fd0-ab03-3d7aee9cf397';

-- Record the test deposit in general_ledger
INSERT INTO general_ledger (user_id, amount, direction, category, source_table, description, reference_id)
VALUES (
  '0b109aad-212a-4fd0-ab03-3d7aee9cf397',
  500000,
  'cash_in',
  'deposit',
  'wallets',
  'Test deposit: UGX 500,000 added for wallet isolation testing',
  'TEST-' || substring(gen_random_uuid()::text, 1, 8)
);
