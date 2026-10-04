-- 1. Wallet-correction guard: recognise designated merchant-desk Financial Ops
--    operators as authorised authors, and let them post a float -> withdrawable
--    reclass on their own wallet (flagged as self-authored for review).
CREATE OR REPLACE FUNCTION public.guard_platform_wallet_correction()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_operator boolean;
BEGIN
  IF v_actor IS NOT NULL THEN
    IF NEW.created_by IS DISTINCT FROM v_actor THEN
      RAISE EXCEPTION 'WALLET_CORRECTION_AUTHOR_MISMATCH: the correction must be recorded under the signed-in author'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  v_operator := public.merchant_float_fix_authorized(NEW.created_by);

  -- Role gate on the recorded author (works for both JWT and service-role posts).
  IF NOT (
    public.has_role(NEW.created_by, 'cfo')
    OR public.has_role(NEW.created_by, 'financial_ops')
    OR public.has_role(NEW.created_by, 'super_admin')
    OR v_operator
  ) THEN
    RAISE EXCEPTION 'WALLET_CORRECTION_NOT_AUTHORIZED: only the CFO, Financial Ops or a super admin can record a platform wallet correction'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Self-authorship block: never correct your own wallet, EXCEPT for a
  -- float -> withdrawable reclass posted by a designated Financial Ops operator
  -- who also runs a merchant desk. That move never changes the total balance.
  IF NOT NEW.system_authored
     AND NEW.created_by = NEW.target_user_id
     AND NOT (v_operator AND NEW.tool = 'admin_float_to_withdrawable') THEN
    RAISE EXCEPTION 'WALLET_CORRECTION_SELF_BLOCKED: you cannot record a wallet correction for your own account'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NOT NEW.system_authored AND NEW.created_by = NEW.target_user_id THEN
    NEW.metadata := COALESCE(NEW.metadata, '{}'::jsonb)
      || jsonb_build_object('self_authored_operator', true);
  END IF;

  -- Evidence floor.
  IF NEW.evidence IS NULL OR length(btrim(NEW.evidence)) < 20 THEN
    RAISE EXCEPTION 'WALLET_CORRECTION_EVIDENCE_REQUIRED: written evidence of at least 20 characters is required'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

-- 2. Merchant desk float setter: accept designated operators and allow them to
--    correct their own desk (flagged in the audit trail).
CREATE OR REPLACE FUNCTION public.set_merchant_desk_float_to(
  p_desk_id uuid,
  p_agent_id uuid,
  p_target numeric,
  p_reason text,
  p_evidence_note text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_desk_agent uuid;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_evidence text := btrim(coalesce(p_evidence_note, ''));
  v_target numeric;
  v_visible_net numeric;
  v_cache_before numeric;
  v_cache_after numeric;
  v_proj_float numeric;
  v_delta numeric;
  v_recon_id uuid;
  v_group_id uuid;
  v_category text;
  v_classification text;
  v_self_desk boolean := false;
BEGIN
  PERFORM set_config('statement_timeout', '120s', true);

  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT (
    public.has_role(v_actor, 'cfo')
    OR public.has_role(v_actor, 'financial_ops')
    OR public.has_role(v_actor, 'super_admin')
    OR public.merchant_float_fix_authorized(v_actor)
  ) THEN
    RAISE EXCEPTION 'Only the CFO, Financial Ops or a super admin can set a merchant desk float';
  END IF;

  v_target := round(coalesce(p_target, -1));
  IF v_target < 0 THEN
    RAISE EXCEPTION 'Enter the float the agent actually holds. It cannot be negative.';
  END IF;

  IF char_length(v_reason) < 10 THEN
    RAISE EXCEPTION 'A reason of at least 10 characters is required';
  END IF;

  IF char_length(v_evidence) < 20 THEN
    RAISE EXCEPTION 'Evidence is required for any desk float correction: which agent, what was actually seen on their phone (balance, screenshot reference or provider TID) and the date and time it was checked';
  END IF;

  SELECT agent_id INTO v_desk_agent FROM public.cashout_agents WHERE id = p_desk_id;
  IF v_desk_agent IS NULL THEN
    RAISE EXCEPTION 'Merchant desk not found or has no linked agent';
  END IF;
  IF p_agent_id IS NOT NULL AND p_agent_id <> v_desk_agent THEN
    RAISE EXCEPTION 'Agent does not match this merchant desk';
  END IF;

  IF v_desk_agent = v_actor THEN
    -- A designated Financial Ops operator who also runs a merchant desk may
    -- correct their own desk; the entry is flagged for finance review.
    IF NOT public.merchant_float_fix_authorized(v_actor) THEN
      RAISE EXCEPTION 'You cannot set the float on your own merchant desk. Another authorized finance officer must post this entry.';
    END IF;
    v_self_desk := true;
  END IF;

  v_visible_net := public.merchant_ledger_float(v_desk_agent);

  SELECT COALESCE(float_balance, 0) INTO v_cache_before
    FROM public.wallets WHERE user_id = v_desk_agent;
  v_cache_before := COALESCE(v_cache_before, 0);

  v_delta := v_target - v_visible_net;

  IF v_delta <> 0 THEN
    IF v_delta > 0 THEN
      v_category := 'agent_float_deposit';
      v_classification := 'production';
    ELSE
      v_category := 'system_balance_correction';
      v_classification := 'admin_correction';
    END IF;

    INSERT INTO public.merchant_float_reconciliations
      (desk_id, agent_id, adjustment_type, amount, reason, evidence_note, created_by, ledger_effect)
    VALUES
      (p_desk_id, v_desk_agent,
       CASE WHEN v_delta > 0 THEN 'opening_balance' ELSE 'evidenced_writedown' END,
       ABS(v_delta), v_reason, v_evidence, v_actor, 'ledger_posted')
    RETURNING id INTO v_recon_id;

    v_group_id := public.create_ledger_transaction(
      entries := jsonb_build_array(
        jsonb_build_object(
          'user_id', v_desk_agent,
          'amount', ABS(v_delta),
          'direction', CASE WHEN v_delta > 0 THEN 'cash_in' ELSE 'cash_out' END,
          'category', v_category,
          'ledger_scope', 'wallet',
          'wallet_bucket', 'float',
          'recipient_type', 'operational_wallet',
          'classification', v_classification,
          'solvency_bypass_reason', 'other_with_note',
          'source_table', 'merchant_float_reconciliations',
          'source_id', v_recon_id,
          'description', format('Merchant desk float set to %s (books showed %s). Reason: %s | Evidence: %s',
                                v_target, v_visible_net, v_reason, v_evidence),
          'currency', 'UGX',
          'transaction_date', now()
        ),
        jsonb_build_object(
          'amount', ABS(v_delta),
          'direction', CASE WHEN v_delta > 0 THEN 'cash_out' ELSE 'cash_in' END,
          'category', v_category,
          'ledger_scope', 'platform',
          'classification', v_classification,
          'source_table', 'merchant_float_reconciliations',
          'source_id', v_recon_id,
          'description', 'Platform: merchant desk float set to evidenced figure',
          'currency', 'UGX',
          'transaction_date', now()
        )
      ),
      idempotency_key := 'merchant_set_float:' || v_recon_id::text,
      skip_balance_check := true
    );
  END IF;

  PERFORM public.refresh_wallet_projection_for(v_desk_agent);

  SELECT COALESCE(float_balance, 0) INTO v_proj_float
    FROM public.wallet_balances_projection WHERE user_id = v_desk_agent;
  v_proj_float := COALESCE(v_proj_float, 0);

  PERFORM set_config('wallet.sync_authorized', 'true', true);
  UPDATE public.wallets
     SET float_balance = v_proj_float,
         updated_at = now()
   WHERE user_id = v_desk_agent
     AND COALESCE(float_balance, 0) IS DISTINCT FROM v_proj_float;
  PERFORM set_config('wallet.sync_authorized', 'false', true);

  SELECT COALESCE(float_balance, 0) INTO v_cache_after
    FROM public.wallets WHERE user_id = v_desk_agent;
  v_cache_after := COALESCE(v_cache_after, 0);

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
  VALUES (v_actor, 'merchant_desk_float_set', 'merchant_float_reconciliations',
          COALESCE(v_recon_id, p_desk_id), v_reason,
          jsonb_build_object('desk_id', p_desk_id, 'agent_id', v_desk_agent,
                             'target', v_target, 'visible_net_before', v_visible_net,
                             'float_before', v_cache_before, 'float_after', v_cache_after,
                             'projection_float', v_proj_float,
                             'delta', v_delta,
                             'ledger_group_id', v_group_id,
                             'self_desk_correction', v_self_desk,
                             'reason', v_reason, 'evidence', v_evidence));

  RETURN jsonb_build_object('ok', true,
                            'no_op', v_delta = 0,
                            'self_desk_correction', v_self_desk,
                            'reconciliation_id', v_recon_id,
                            'ledger_group_id', v_group_id,
                            'target', v_target,
                            'raw_net_before', v_visible_net,
                            'float_before', v_cache_before,
                            'float_after', v_cache_after,
                            'delta', v_delta);
END;
$$;

REVOKE ALL ON FUNCTION public.set_merchant_desk_float_to(uuid,uuid,numeric,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_merchant_desk_float_to(uuid,uuid,numeric,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_merchant_desk_float_to(uuid,uuid,numeric,text,text) TO service_role;