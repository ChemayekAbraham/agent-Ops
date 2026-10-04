
-- Insert corrective entries for SANYU JERUSHA's 2 ROI payouts that never synced to wallet
-- Entry 1: UGX 1,800,400 ROI payout
INSERT INTO general_ledger (user_id, amount, direction, category, description, source_table, source_id, transaction_group_id, ledger_scope, transaction_date)
VALUES (
  '52af6b9d-86f3-4fb0-9134-1104f04f1238',
  1800400,
  'cash_in',
  'roi_payout',
  'Corrective entry: ROI payout of USh 1,800,400 to SANYU JERUSHA wallet (original missing txn_group_id)',
  'general_ledger',
  '381a8f7e-25ee-4268-9077-37afbc07758e',
  gen_random_uuid(),
  'wallet',
  now()
);

-- Entry 2: UGX 1,016,400 ROI payout  
INSERT INTO general_ledger (user_id, amount, direction, category, description, source_table, source_id, transaction_group_id, ledger_scope, transaction_date)
VALUES (
  '52af6b9d-86f3-4fb0-9134-1104f04f1238',
  1016400,
  'cash_in',
  'roi_payout',
  'Corrective entry: ROI payout of USh 1,016,400 to SANYU JERUSHA wallet (original missing txn_group_id)',
  'general_ledger',
  'cde83b51-571e-42f1-84ba-77d8c12cc172',
  gen_random_uuid(),
  'wallet',
  now()
);
