
-- Set the session flag to authorize direct wallet mutation
SET LOCAL wallet.sync_authorized = 'true';

-- Zero out PAMELA SSAKA's phantom wallet balance
UPDATE public.wallets 
SET balance = 0, updated_at = now()
WHERE user_id = '9a20da54-829f-435d-b717-ca59a5e22658';

-- Zero out YAWE MIKE's phantom wallet balance  
UPDATE public.wallets
SET balance = 0, updated_at = now()
WHERE user_id = '44f7b888-aa2c-4a58-8c92-aa8bc36f5964';

-- Log the reconciliation to audit_logs
INSERT INTO public.audit_logs (action_type, table_name, record_id, user_id, metadata)
VALUES 
  ('system_balance_correction', 'wallets', '9a20da54-829f-435d-b717-ca59a5e22658', NULL, 
   '{"reason": "phantom_balance_reconciliation", "user_name": "PAMELA SSAKA", "previous_balance": 6729419, "new_balance": 0, "ledger_net": 0}'::jsonb),
  ('system_balance_correction', 'wallets', '44f7b888-aa2c-4a58-8c92-aa8bc36f5964', NULL,
   '{"reason": "phantom_balance_reconciliation", "user_name": "YAWE MIKE", "previous_balance": 45000, "new_balance": 0, "ledger_net": 0}'::jsonb);
