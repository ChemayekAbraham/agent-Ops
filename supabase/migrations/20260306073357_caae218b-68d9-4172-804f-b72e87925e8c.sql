
UPDATE wallets 
SET balance = balance + 200000, updated_at = now()
WHERE user_id = '48c687b9-4691-4a4f-b7f4-dc54a2fe029c';

INSERT INTO general_ledger (user_id, amount, direction, category, source_table, description, reference_id)
VALUES (
  '48c687b9-4691-4a4f-b7f4-dc54a2fe029c',
  200000,
  'cash_in',
  'deposit',
  'wallets',
  'Test deposit: UGX 200,000 for supporter funding flow test',
  'TEST-' || substring(gen_random_uuid()::text, 1, 8)
);
