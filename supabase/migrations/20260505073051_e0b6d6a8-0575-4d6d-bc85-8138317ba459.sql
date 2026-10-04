DO $$
DECLARE
  r record;
  v_strict numeric;
  v_delta  numeric;
  v_ref    text;
BEGIN
  PERFORM set_config('wallet.sync_authorized', 'true', true);

  FOR r IN SELECT user_id, cached_withdrawable FROM public.wallet_anchored_drift_view LOOP
    v_strict := public.get_user_available_balance(r.user_id);
    v_delta  := GREATEST(0, COALESCE(r.cached_withdrawable,0) - COALESCE(v_strict,0));
    IF v_delta < 1 THEN CONTINUE; END IF;

    v_ref := 'bulk_reseed_' || r.user_id::text || '_' || extract(epoch from now())::bigint::text;

    -- Post balanced admin_correction (wallet leg cash_out, platform leg cash_in)
    BEGIN
      PERFORM public.create_ledger_transaction(
        entries := jsonb_build_array(
          jsonb_build_object(
            'user_id', r.user_id,
            'amount', v_delta,
            'direction','cash_out',
            'category','system_balance_correction',
            'ledger_scope','wallet',
            'classification','admin_correction',
            'description','Bulk anchored cache reconciliation (clear cache excess)',
            'reference_id', v_ref
          ),
          jsonb_build_object(
            'user_id', NULL,
            'amount', v_delta,
            'direction','cash_in',
            'category','system_balance_correction',
            'ledger_scope','platform',
            'classification','admin_correction',
            'description','Phantom withdrawable cleared (bulk) for ' || r.user_id::text,
            'reference_id', v_ref
          )
        ),
        idempotency_key := v_ref,
        skip_balance_check := true
      );
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'ledger post failed for %: %', r.user_id, SQLERRM;
    END;

    -- Force cached withdrawable down to strict figure
    PERFORM set_config('wallet.sync_authorized', 'true', true);
    UPDATE public.wallets
       SET withdrawable_balance = v_strict,
           balance              = v_strict + COALESCE(float_balance,0),
           updated_at           = now()
     WHERE user_id = r.user_id;
  END LOOP;
END $$;