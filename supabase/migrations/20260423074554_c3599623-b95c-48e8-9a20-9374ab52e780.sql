DO $$
DECLARE
  r record;
BEGIN
  PERFORM set_config('wallet.sync_authorized', 'true', true);

  FOR r IN
    SELECT user_id, balance,
           (COALESCE(withdrawable_balance,0)+COALESCE(float_balance,0)+COALESCE(advance_balance,0)) AS bucket_sum
    FROM public.wallets
    WHERE balance IS DISTINCT FROM
          (COALESCE(withdrawable_balance,0)+COALESCE(float_balance,0)+COALESCE(advance_balance,0))
  LOOP
    UPDATE public.wallets
       SET balance = r.bucket_sum, updated_at = now()
     WHERE user_id = r.user_id;

    INSERT INTO public.audit_logs (user_id, action_type, action, table_name, record_id, metadata)
    VALUES (
      r.user_id,
      'WLT-REPAIR-1',
      'wallet_balance_drift_heal',
      'wallets',
      r.user_id::text,
      jsonb_build_object(
        'reason', 'WLT-REPAIR-1',
        'previous_balance', r.balance,
        'corrected_balance', r.bucket_sum,
        'drift', r.balance - r.bucket_sum,
        'note', 'Healed wallet.balance to match bucket sum (system-wide drift sweep)'
      )
    );
  END LOOP;
END $$;