DO $$
DECLARE
  r RECORD;
  v_cur numeric;
  v_delta numeric;
  v_grp uuid;
  v_i int;
BEGIN
  PERFORM set_config('ledger.authorized', 'true', true);

  FOR r IN
    SELECT * FROM (VALUES
      ('5be34dc0-4535-4f61-8c85-f92f2713f652'::uuid, 537633::numeric),
      ('7f4d0676-3d06-41ec-bcce-9408dd471d9b'::uuid, 1988092::numeric)
    ) AS t(user_id, target)
  LOOP
    FOR v_i IN 1..5 LOOP
      PERFORM public.refresh_wallet_projection_for(r.user_id);

      SELECT COALESCE(float_balance, 0) INTO v_cur
      FROM public.wallet_balances_projection WHERE user_id = r.user_id;

      v_delta := v_cur - r.target;
      EXIT WHEN v_delta <= 0;

      v_grp := gen_random_uuid();
      INSERT INTO public.general_ledger
        (transaction_group_id, amount, direction, category, description, user_id,
         source_table, ledger_scope, wallet_bucket, recipient_type, classification,
         idempotency_key, transaction_date)
      VALUES
        (v_grp, v_delta, 'cash_out', 'agent_float_settlement',
         'Merchant desk float aligned to agent-confirmed holding: UGX ' || r.target::text,
         r.user_id, 'merchant_float_reconciliations', 'wallet', 'float', 'operational_wallet',
         'production', 'merchant_float_align2:' || r.user_id::text || ':' || v_i::text || ':' || v_delta::text, now()),
        (v_grp, v_delta, 'cash_in', 'agent_float_settlement',
         'Merchant desk float alignment (platform leg): UGX ' || r.target::text,
         NULL, 'merchant_float_reconciliations', 'platform', NULL, NULL,
         'production', 'merchant_float_align2_platform:' || r.user_id::text || ':' || v_i::text || ':' || v_delta::text, now());
    END LOOP;

    PERFORM public.refresh_wallet_projection_for(r.user_id);
  END LOOP;
END $$;