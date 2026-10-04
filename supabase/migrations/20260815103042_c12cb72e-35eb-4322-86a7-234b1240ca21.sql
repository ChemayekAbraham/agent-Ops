INSERT INTO public.ledger_account_map (ledger_scope,category,wallet_bucket,account_code,debit_when) VALUES
 ('wallet','rent_payment_for_tenant',NULL,'A2','cash_in')
ON CONFLICT (ledger_scope, category, COALESCE(wallet_bucket,'*'))
DO UPDATE SET account_code = EXCLUDED.account_code, debit_when = EXCLUDED.debit_when;

UPDATE public.ledger_account_map
   SET account_code = 'L1', debit_when = 'cash_out'
 WHERE ledger_scope = 'platform' AND category = 'roi_wallet_credit';