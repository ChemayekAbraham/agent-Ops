-- ROLLBACK of 20261125160000 (only on CFO instruction).
DELETE FROM public.fin_cash_flow_map WHERE account_code = 'E3' AND category = 'wallet_correction_reclass_e3';
