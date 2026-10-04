DO $$
BEGIN
  PERFORM set_config('wallet.sync_authorized','true', true);
  UPDATE public.wallets
     SET withdrawable_balance = 10000,
         balance = 10000,
         updated_at = now()
   WHERE user_id='e11848ee-6d4c-4cd1-a9a0-92ff56bc794f';
END $$;
SELECT withdrawable_balance, balance FROM public.wallets WHERE user_id='e11848ee-6d4c-4cd1-a9a0-92ff56bc794f';