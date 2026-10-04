DO $$
DECLARE u uuid;
BEGIN
  FOR u IN
    SELECT DISTINCT user_id
    FROM public.general_ledger
    WHERE category='wallet_deposit'
      AND ledger_scope='wallet'
      AND direction='cash_in'
      AND wallet_bucket IS NULL
      AND transaction_date > now() - interval '30 days'
  LOOP
    PERFORM public.refresh_wallet_projection_for(u);
  END LOOP;
END $$;