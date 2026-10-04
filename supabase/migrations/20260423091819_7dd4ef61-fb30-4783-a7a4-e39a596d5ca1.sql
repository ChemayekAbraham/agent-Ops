DO $$
DECLARE
  v_row record;
  v_count int := 0;
  v_total numeric := 0;
  v_breakdown jsonb := '{}'::jsonb;
  v_target_bucket text;
  v_user_roles text[];
  v_has_float_history boolean;
  v_has_commission_history boolean;
BEGIN
  PERFORM set_config('wallet.sync_authorized', 'true', true);

  FOR v_row IN
    SELECT user_id, balance
    FROM public.wallets
    WHERE balance > 0
      AND COALESCE(withdrawable_balance, 0) = 0
      AND COALESCE(float_balance, 0) = 0
      AND COALESCE(advance_balance, 0) = 0
  LOOP
    -- Heuristic: check user's wallet ledger history for dominant flow type
    SELECT array_agg(DISTINCT role::text) INTO v_user_roles
    FROM public.user_roles WHERE user_id = v_row.user_id;

    SELECT EXISTS (
      SELECT 1 FROM public.general_ledger
      WHERE user_id = v_row.user_id
        AND ledger_scope = 'wallet'
        AND category IN ('agent_float_deposit', 'agent_float_funding', 'rent_float_funding')
    ) INTO v_has_float_history;

    SELECT EXISTS (
      SELECT 1 FROM public.general_ledger
      WHERE user_id = v_row.user_id
        AND ledger_scope = 'wallet'
        AND category IN ('agent_commission_earned', 'wallet_deposit', 'roi_wallet_credit')
    ) INTO v_has_commission_history;

    -- Decide bucket: float-only history → float; otherwise → withdrawable
    IF v_has_float_history AND NOT v_has_commission_history AND (v_user_roles && ARRAY['agent']) THEN
      v_target_bucket := 'float';
      UPDATE public.wallets
        SET float_balance = v_row.balance, updated_at = now()
        WHERE user_id = v_row.user_id;
    ELSE
      v_target_bucket := 'withdrawable';
      UPDATE public.wallets
        SET withdrawable_balance = v_row.balance, updated_at = now()
        WHERE user_id = v_row.user_id;
    END IF;

    v_count := v_count + 1;
    v_total := v_total + v_row.balance;
    v_breakdown := jsonb_set(
      v_breakdown,
      ARRAY[v_target_bucket],
      to_jsonb(COALESCE((v_breakdown ->> v_target_bucket)::numeric, 0) + v_row.balance)
    );
  END LOOP;

  PERFORM set_config('wallet.sync_authorized', 'false', true);

  INSERT INTO public.audit_logs (action_type, table_name, record_id, metadata)
  VALUES (
    'wallet_bucket_restoration', 'wallets', NULL,
    jsonb_build_object(
      'wallets_restored', v_count,
      'total_ugx', v_total,
      'breakdown', v_breakdown,
      'note', 'Repaired buckets after over-subtraction during phantom back-fill rollback. Heuristic: agent+float-only history → float; else → withdrawable.',
      'executed_at', now()
    )
  );

  RAISE NOTICE 'Restored % wallet buckets, total UGX %; breakdown: %', v_count, v_total, v_breakdown;
END $$;