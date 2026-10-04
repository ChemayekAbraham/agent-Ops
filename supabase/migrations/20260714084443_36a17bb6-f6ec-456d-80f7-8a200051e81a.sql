DO $$
DECLARE v_net numeric;
BEGIN
  PERFORM set_config('wallet.sync_authorized','true', true);
  SELECT COALESCE(SUM(CASE WHEN direction='cash_in' THEN amount ELSE -amount END),0)
    INTO v_net
  FROM public.general_ledger
  WHERE user_id='e11848ee-6d4c-4cd1-a9a0-92ff56bc794f' AND ledger_scope='wallet';
  UPDATE public.wallets
     SET withdrawable_balance = GREATEST(v_net,0),
         float_balance = 0,
         advance_balance = 0,
         balance = GREATEST(v_net,0),
         updated_at = now()
   WHERE user_id='e11848ee-6d4c-4cd1-a9a0-92ff56bc794f';
END $$;