CREATE OR REPLACE FUNCTION public.set_merchant_desk_float_to(
  p_desk_id uuid,
  p_agent_id uuid,
  p_target numeric,
  p_reason text,
  p_evidence_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_desk_agent uuid;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_evidence text := btrim(coalesce(p_evidence_note, ''));
  v_target numeric;
  v_raw_net numeric;
  v_cache_before numeric;
  v_delta numeric;
  v_recon_id uuid;
  v_group_id uuid;
  v_category text;
  v_direction text;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT (
    public.has_role(v_actor, 'cfo')
    OR public.has_role(v_actor, 'financial_ops')
    OR public.has_role(v_actor, 'super_admin')
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

  SELECT agent_id INTO v_desk_agent FROM public.cashout_agents WHERE id = p_desk_id;
  IF v_desk_agent IS NULL THEN
    RAISE EXCEPTION 'Merchant desk not found or has no linked agent';
  END IF;
  IF p_agent_id IS NOT NULL AND p_agent_id <> v_desk_agent THEN
    RAISE EXCEPTION 'Agent does not match this merchant desk';
  END IF;
  IF v_desk_agent = v_actor THEN
    RAISE EXCEPTION 'You cannot set the float on your own merchant desk. Another authorized finance officer must post this entry.';
  END IF;

  SELECT COALESCE(SUM(CASE WHEN g.direction = 'cash_in' THEN g.amount ELSE -g.amount END), 0)
    INTO v_raw_net
    FROM public.general_ledger g
   WHERE g.user_id = v_desk_agent
     AND g.ledger_scope = 'wallet'
     AND g.wallet_bucket = 'float';

  SELECT COALESCE(float_balance, 0) INTO v_cache_before FROM public.wallets WHERE user_id = v_desk_agent;
  v_cache_before := COALESCE(v_cache_before, 0);

  v_delta := v_target - v_raw_net;

  IF v_delta < 0 AND char_length(v_evidence) < 20 THEN
    RAISE EXCEPTION 'Evidence is required to lower a desk float: which agent, what was actually seen on their phone (balance, screenshot reference or provider TID) and the date and time it was checked';
  END IF;

  IF v_delta = 0 AND ABS(v_cache_before - v_target) < 1 THEN
    RETURN jsonb_build_object('ok', true, 'no_op', true, 'target', v_target,
                              'raw_net_before', v_raw_net, 'float_before', v_cache_before,
                              'float_after', v_cache_before, 'delta', 0);
  END IF;

  IF v_delta <> 0 THEN
    v_category := CASE WHEN v_delta > 0 THEN 'agent_float_deposit' ELSE 'merchant_float_correction_writedown' END;
    v_direction := CASE WHEN v_delta > 0 THEN 'cash_in' ELSE 'cash_out' END;

    INSERT INTO public.merchant_float_reconciliations
      (desk_id, agent_id, adjustment_type, amount, reason, evidence_note, created_by, ledger_effect)
    VALUES
      (p_desk_id, v_desk_agent,
       CASE WHEN v_delta > 0 THEN 'opening_balance' ELSE 'evidenced_writedown' END,
       ABS(v_delta), v_reason, nullif(v_evidence, ''), v_actor, 'ledger_posted')
    RETURNING id INTO v_recon_id;

    v_group_id := public.create_ledger_transaction(
      entries := jsonb_build_array(
        jsonb_build_object(
          'user_id', v_desk_agent,
          'amount', ABS(v_delta),
          'direction', v_direction,
          'category', v_category,
          'ledger_scope', 'wallet',
          'wallet_bucket', 'float',
          'recipient_type', 'operational_wallet',
          'classification', 'admin_correction',
          'solvency_bypass_reason', 'other_with_note',
          'source_table', 'merchant_float_reconciliations',
          'source_id', v_recon_id,
          'description', format('Merchant desk float set to %s (books were %s). Reason: %s | Evidence: %s',
                                v_target, v_raw_net, v_reason, coalesce(nullif(v_evidence, ''), 'n/a')),
          'currency', 'UGX',
          'transaction_date', now()
        ),
        jsonb_build_object(
          'amount', ABS(v_delta),
          'direction', CASE WHEN v_delta > 0 THEN 'cash_out' ELSE 'cash_in' END,
          'category', v_category,
          'ledger_scope', 'platform',
          'classification', 'admin_correction',
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

  -- Clear the cache: the desk must now show exactly the figure that was set.
  PERFORM set_config('wallet.sync_authorized', 'true', true);
  UPDATE public.wallets
     SET float_balance = v_target,
         updated_at = now()
   WHERE user_id = v_desk_agent;
  PERFORM set_config('wallet.sync_authorized', 'false', true);

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  VALUES (v_actor, 'merchant_desk_float_set', 'merchant_float_reconciliations',
          COALESCE(v_recon_id, p_desk_id),
          jsonb_build_object('desk_id', p_desk_id, 'agent_id', v_desk_agent,
                             'target', v_target, 'raw_net_before', v_raw_net,
                             'float_before', v_cache_before, 'delta', v_delta,
                             'ledger_group_id', v_group_id,
                             'reason', v_reason, 'evidence', nullif(v_evidence, '')));

  RETURN jsonb_build_object('ok', true, 'no_op', false,
                            'reconciliation_id', v_recon_id,
                            'ledger_group_id', v_group_id,
                            'target', v_target,
                            'raw_net_before', v_raw_net,
                            'float_before', v_cache_before,
                            'float_after', v_target,
                            'delta', v_delta);
END;
$function$;

REVOKE ALL ON FUNCTION public.set_merchant_desk_float_to(uuid, uuid, numeric, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_merchant_desk_float_to(uuid, uuid, numeric, text, text) TO authenticated, service_role;