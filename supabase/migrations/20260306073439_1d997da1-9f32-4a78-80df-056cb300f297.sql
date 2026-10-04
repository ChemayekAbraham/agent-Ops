
-- Simulate supporter funding: deduct 50,000 from gostaria's wallet (as fund-rent-pool would)
UPDATE wallets 
SET balance = balance - 50000, updated_at = now()
WHERE user_id = '48c687b9-4691-4a4f-b7f4-dc54a2fe029c' AND balance >= 50000;

-- Record in general_ledger (as the edge function would)
INSERT INTO general_ledger (user_id, amount, direction, category, source_table, source_id, description, reference_id, linked_party)
VALUES (
  '48c687b9-4691-4a4f-b7f4-dc54a2fe029c',
  50000,
  'cash_out',
  'supporter_rent_fund',
  'opportunity_summaries',
  '02760c9d-ec69-418c-8d85-e0e7b0753d19',
  'Supporter rent funding: UGX 50,000 to Rent Management Pool. Payout day: 15th. First payout: 2026-04-15',
  'WRF260306' || (floor(random() * 9000 + 1000)::int)::text,
  'Rent Management Pool'
);
