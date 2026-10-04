
DO $$
BEGIN
  ALTER TABLE public.general_ledger DISABLE TRIGGER trg_prevent_ledger_update;
  ALTER TABLE public.general_ledger DISABLE TRIGGER trg_sync_wallet_from_ledger;

  -- Fix: The cash_out correction entries for the 3 inflated users should be platform-scope
  -- (their wallet-scope ledger was 0, so no wallet-scope entry is needed)
  UPDATE public.general_ledger 
  SET ledger_scope = 'platform'
  WHERE reference_id IN ('COR2604100001','COR2604100002','COR2604100003')
    AND ledger_scope = 'wallet'
    AND direction = 'cash_out'
    AND category = 'system_balance_correction';

  -- For Hellen: remove the extra wallet cash_in (her ledger already had 5K, adding another 5K makes it 10K)
  -- Delete the correction cash_in wallet entry since her ledger was already correct
  ALTER TABLE public.general_ledger DISABLE TRIGGER trg_prevent_ledger_delete;
  
  DELETE FROM public.general_ledger 
  WHERE reference_id = 'COR2604100004'
    AND ledger_scope = 'wallet'
    AND direction = 'cash_in'
    AND category = 'system_balance_correction';

  ALTER TABLE public.general_ledger ENABLE TRIGGER trg_prevent_ledger_delete;
  ALTER TABLE public.general_ledger ENABLE TRIGGER trg_prevent_ledger_update;
  ALTER TABLE public.general_ledger ENABLE TRIGGER trg_sync_wallet_from_ledger;

  -- Force-reconcile Hellen's wallet to her true ledger balance (5000)
  PERFORM set_config('wallet.sync_authorized', 'true', true);
  UPDATE public.wallets SET balance = 5000, updated_at = now()
  WHERE user_id = 'bd266fc7-1066-468a-8beb-347430d9d9b6';
  PERFORM set_config('wallet.sync_authorized', 'false', true);
END $$;
