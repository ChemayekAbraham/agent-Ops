DO $$
BEGIN
  PERFORM set_config('wallet.sync_authorized','true',true);
  UPDATE wallets
     SET float_balance = float_balance + 35000,
         updated_at = now()
   WHERE user_id = '9bb21b14-cf97-428d-960a-abdd244e80b8';
END $$;