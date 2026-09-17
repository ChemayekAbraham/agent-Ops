-- Tenant self-payment: a non-agent tenant's own deposited money counts as
-- available even when deposit routing placed it in the float bucket.
-- Rewrites public.settle_tenant_rent_from_deposit in place by patching the
-- live definition, so nothing else in that function can drift.
DO $mig$
DECLARE
  v_src text;
  v_before text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_src
    FROM pg_proc WHERE proname = 'settle_tenant_rent_from_deposit'
     AND pronamespace = 'public'::regnamespace;
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'settle_tenant_rent_from_deposit not found';
  END IF;

  -- 1. new locals
  v_before := v_src;
  v_src := replace(v_src,
    '  v_cached         numeric := 0;',
    '  v_cached         numeric := 0;' || E'\n' ||
    '  v_cached_f       numeric := 0;' || E'\n' ||
    '  v_avail_w        numeric := 0;' || E'\n' ||
    '  v_avail_f        numeric := 0;' || E'\n' ||
    '  v_from_w         numeric := 0;' || E'\n' ||
    '  v_from_f         numeric := 0;');
  IF v_src = v_before THEN RAISE EXCEPTION 'patch 1 (declarations) did not apply'; END IF;

  -- 2. availability: withdrawable + own deposited float (non-agent only)
  v_before := v_src;
  v_src := replace(v_src,
    '    SELECT COALESCE(withdrawable_balance, 0) INTO v_cached' || E'\n' ||
    '      FROM public.wallets WHERE user_id = v_dep.user_id;' || E'\n' ||
    '    v_avail := GREATEST(0, LEAST(' || E'\n' ||
    '      COALESCE((public.get_user_wallet_view(v_dep.user_id) ->> ''withdrawable'')::numeric, 0),' || E'\n' ||
    '      COALESCE(v_cached, 0)));' || E'\n' || E'\n' ||
    '    v_applied := round(LEAST(COALESCE(v_dep.amount, 0), v_due, v_avail), 2);',
    '    SELECT COALESCE(withdrawable_balance, 0), COALESCE(float_balance, 0)' || E'\n' ||
    '      INTO v_cached, v_cached_f' || E'\n' ||
    '      FROM public.wallets WHERE user_id = v_dep.user_id;' || E'\n' ||
    '    v_avail_w := GREATEST(0, LEAST(' || E'\n' ||
    '      COALESCE((public.get_user_wallet_view(v_dep.user_id) ->> ''withdrawable'')::numeric, 0),' || E'\n' ||
    '      COALESCE(v_cached, 0)));' || E'\n' || E'\n' ||
    '    -- 2026-09-17: deposits route to FLOAT by default, so a tenant who is' || E'\n' ||
    '    -- NOT an agent actor had zero withdrawable and self-payment was refused' || E'\n' ||
    '    -- although her own money had arrived. Her float IS her own deposit.' || E'\n' ||
    '    -- Agent actors stay excluded: their float is money for their clients.' || E'\n' ||
    '    IF NOT v_is_agent_actor THEN' || E'\n' ||
    '      v_avail_f := GREATEST(0, COALESCE(v_cached_f, 0));' || E'\n' ||
    '    END IF;' || E'\n' || E'\n' ||
    '    v_avail   := v_avail_w + v_avail_f;' || E'\n' ||
    '    v_applied := round(LEAST(COALESCE(v_dep.amount, 0), v_due, v_avail), 2);' || E'\n' ||
    '    v_from_w  := LEAST(v_applied, v_avail_w);' || E'\n' ||
    '    v_from_f  := round(v_applied - v_from_w, 2);');
  IF v_src = v_before THEN RAISE EXCEPTION 'patch 2 (availability) did not apply'; END IF;

  -- 3. remove the hard-coded withdrawable wallet debit leg
  v_before := v_src;
  v_src := replace(v_src,
    '  v_legs := jsonb_build_array(' || E'\n' ||
    '    jsonb_build_object(' || E'\n' ||
    '      ''user_id'', v_dep.user_id,' || E'\n' ||
    '      ''amount'', v_applied,' || E'\n' ||
    '      ''direction'', ''cash_out'',' || E'\n' ||
    '      ''category'', ''tenant_rent_settlement'',' || E'\n' ||
    '      ''ledger_scope'', ''wallet'',' || E'\n' ||
    '      ''wallet_bucket'', ''withdrawable'',' || E'\n' ||
    '      ''recipient_type'', ''user'',' || E'\n' ||
    '      ''classification'', ''production'',' || E'\n' ||
    '      ''description'', ''Tenant self-payment settled from own withdrawable balance'',' || E'\n' ||
    '      ''linked_party'', v_plan.landlord_id,' || E'\n' ||
    '      ''source_table'', ''agent_collections'',' || E'\n' ||
    '      ''source_id'', v_rr,' || E'\n' ||
    '      ''reference_id'', v_tracking' || E'\n' ||
    '    ),' || E'\n' ||
    '    jsonb_build_object(',
    '  v_legs := jsonb_build_array(' || E'\n' ||
    '    jsonb_build_object(');
  IF v_src = v_before THEN RAISE EXCEPTION 'patch 3 (drop fixed wallet leg) did not apply'; END IF;

  -- 4. add per-bucket wallet debit legs
  v_before := v_src;
  v_src := replace(v_src,
    '      ''reference_id'', v_tracking' || E'\n' ||
    '    )' || E'\n' ||
    '  );' || E'\n' || E'\n' ||
    '  IF NOT v_in_scope AND v_plan.agent_id IS NOT NULL THEN',
    '      ''reference_id'', v_tracking' || E'\n' ||
    '    )' || E'\n' ||
    '  );' || E'\n' || E'\n' ||
    '  IF v_from_w > 0 THEN' || E'\n' ||
    '    v_legs := v_legs || jsonb_build_array(jsonb_build_object(' || E'\n' ||
    '      ''user_id'', v_dep.user_id,' || E'\n' ||
    '      ''amount'', v_from_w,' || E'\n' ||
    '      ''direction'', ''cash_out'',' || E'\n' ||
    '      ''category'', ''tenant_rent_settlement'',' || E'\n' ||
    '      ''ledger_scope'', ''wallet'',' || E'\n' ||
    '      ''wallet_bucket'', ''withdrawable'',' || E'\n' ||
    '      ''recipient_type'', ''user'',' || E'\n' ||
    '      ''classification'', ''production'',' || E'\n' ||
    '      ''description'', ''Tenant self-payment settled from own withdrawable balance'',' || E'\n' ||
    '      ''linked_party'', v_plan.landlord_id,' || E'\n' ||
    '      ''source_table'', ''agent_collections'',' || E'\n' ||
    '      ''source_id'', v_rr,' || E'\n' ||
    '      ''reference_id'', v_tracking));' || E'\n' ||
    '  END IF;' || E'\n' || E'\n' ||
    '  IF v_from_f > 0 THEN' || E'\n' ||
    '    v_legs := v_legs || jsonb_build_array(jsonb_build_object(' || E'\n' ||
    '      ''user_id'', v_dep.user_id,' || E'\n' ||
    '      ''amount'', v_from_f,' || E'\n' ||
    '      ''direction'', ''cash_out'',' || E'\n' ||
    '      ''category'', ''agent_float_used_for_rent'',' || E'\n' ||
    '      ''ledger_scope'', ''wallet'',' || E'\n' ||
    '      ''wallet_bucket'', ''float'',' || E'\n' ||
    '      ''recipient_type'', ''operational_wallet'',' || E'\n' ||
    '      ''classification'', ''production'',' || E'\n' ||
    '      ''description'', ''Tenant self-payment settled from own deposited balance'',' || E'\n' ||
    '      ''linked_party'', v_plan.landlord_id,' || E'\n' ||
    '      ''source_table'', ''agent_collections'',' || E'\n' ||
    '      ''source_id'', v_rr,' || E'\n' ||
    '      ''reference_id'', v_tracking));' || E'\n' ||
    '  END IF;' || E'\n' || E'\n' ||
    '  IF NOT v_in_scope AND v_plan.agent_id IS NOT NULL THEN');
  IF v_src = v_before THEN RAISE EXCEPTION 'patch 4 (bucket legs) did not apply'; END IF;

  -- 5. refusal label + money-source diagnostics
  v_src := replace(v_src, 'CASE WHEN v_avail <= 0 THEN ''no_withdrawable_balance''',
                          'CASE WHEN v_avail <= 0 THEN ''no_available_balance''');
  v_src := replace(v_src,
    '      ''money_source'', ''tenant_withdrawable'',',
    '      ''money_source'', CASE WHEN v_from_f > 0 AND v_from_w > 0 THEN ''tenant_withdrawable+deposited_float''' || E'\n' ||
    '                           WHEN v_from_f > 0 THEN ''tenant_deposited_float''' || E'\n' ||
    '                           ELSE ''tenant_withdrawable'' END,' || E'\n' ||
    '      ''applied_from_withdrawable'', v_from_w,' || E'\n' ||
    '      ''applied_from_float'', v_from_f,');
  v_src := replace(v_src,
    '    ''money_source'', ''tenant_withdrawable'',',
    '    ''money_source'', CASE WHEN v_from_f > 0 AND v_from_w > 0 THEN ''tenant_withdrawable+deposited_float''' || E'\n' ||
    '                         WHEN v_from_f > 0 THEN ''tenant_deposited_float''' || E'\n' ||
    '                         ELSE ''tenant_withdrawable'' END,');

  EXECUTE v_src;
END
$mig$;