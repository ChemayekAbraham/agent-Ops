DO $$
DECLARE
  r RECORD;
  v_ledger numeric;
  v_delta numeric;
  v_grp uuid;
BEGIN
  PERFORM set_config('ledger.authorized', 'true', true);

  FOR r IN
    SELECT * FROM (VALUES
      ('5be34dc0-4535-4f61-8c85-f92f2713f652'::uuid, 537633::numeric),
      ('7f4d0676-3d06-41ec-bcce-9408dd471d9b'::uuid, 1988092::numeric)
    ) AS t(user_id, target)
  LOOP
    SELECT COALESCE(SUM(CASE WHEN direction = 'cash_in' THEN amount ELSE -amount END), 0)
      INTO v_ledger
    FROM public.general_ledger
    WHERE ledger_scope = 'wallet' AND wallet_bucket = 'float' AND user_id = r.user_id;

    v_delta := v_ledger - r.target;

    IF v_delta > 0 THEN
      v_grp := gen_random_uuid();

      INSERT INTO public.general_ledger
        (transaction_group_id, amount, direction, category, description, user_id,
         source_table, ledger_scope, wallet_bucket, recipient_type, classification,
         idempotency_key, transaction_date)
      VALUES
        (v_grp, v_delta, 'cash_out', 'agent_float_settlement',
         'Merchant desk float reset to agent-confirmed holding: UGX ' || r.target::text,
         r.user_id, 'merchant_float_reconciliations', 'wallet', 'float', 'operational_wallet',
         'production', 'merchant_float_reset:' || r.user_id::text || ':' || r.target::text, now()),
        (v_grp, v_delta, 'cash_in', 'agent_float_settlement',
         'Merchant desk float reset (platform leg): UGX ' || r.target::text,
         NULL, 'merchant_float_reconciliations', 'platform', NULL, NULL,
         'production', 'merchant_float_reset_platform:' || r.user_id::text || ':' || r.target::text, now());
    END IF;

    PERFORM set_config('wallet.sync_authorized', 'true', true);
    UPDATE public.wallets
    SET float_balance = r.target,
        updated_at = now()
    WHERE user_id = r.user_id;

    PERFORM public.refresh_wallet_projection_for(r.user_id);
  END LOOP;
END $$;