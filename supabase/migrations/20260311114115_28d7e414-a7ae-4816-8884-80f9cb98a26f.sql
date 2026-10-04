
-- Delete the duplicate self-funded portfolio (WPF-5079)
DELETE FROM investor_portfolios WHERE id = 'b416ff59-cdff-4603-bc62-da9d88b32ade';

-- Insert reversing entry in general_ledger (proper accounting correction)
INSERT INTO general_ledger (user_id, amount, direction, category, source_table, description, reference_id, linked_party)
VALUES (
  '2444a342-b4a0-4fa5-a6ef-6b7696ca1d39',
  50000,
  'cash_in',
  'correction_reversal',
  'investor_portfolios',
  'Reversal: duplicate self-funded portfolio WPF-5079 removed — capital was double-counted from proxy investment credit',
  'WRV2603110001',
  'System Correction'
);

-- Restore Lolem Patrick's wallet to 50,000
UPDATE wallets SET balance = 50000, updated_at = now() WHERE user_id = '2444a342-b4a0-4fa5-a6ef-6b7696ca1d39';
