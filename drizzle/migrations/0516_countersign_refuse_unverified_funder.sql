CREATE OR REPLACE FUNCTION public.countersign_prepare_support(p_partner_id uuid, p_amount numeric, p_support_mode text, p_return_option text, p_actor uuid, p_countersign_only boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  a          public.partner_agreements%ROWTYPE;
  v_amount   numeric;
  v_exist    numeric;
  v_count    integer;
  v_needed   numeric;
  v_float    numeric;
  v_option   text;
  v_mode     text;
  v_pid      uuid;
  v_code     text;
  v_group    uuid;
  v_today    date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_roi_mode text;
BEGIN
  IF p_actor IS NULL OR NOT public.is_partner_ops(p_actor) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_AUTHORIZED',
      'message', 'Only Partner Operations can countersign.');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('countersign-prepare-' || p_partner_id::text));

  SELECT * INTO a FROM public.partner_agreements WHERE partner_id = p_partner_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NO_AGREEMENT', 'message', 'No agreement found for this partner.');
  END IF;

  v_mode := coalesce(p_support_mode, a.support_mode);
  IF v_mode IS NULL OR v_mode NOT IN ('company_managed', 'self_support') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SUPPORT_MODE_REQUIRED',
      'message', 'Choose how this partner will support (company-managed or self-support) before countersigning.');
  END IF;

  v_amount := coalesce(nullif(p_amount, 0), nullif(a.partnership_amount, 0), 0);
  IF v_amount < 20000 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_AMOUNT',
      'message', 'The contract amount must be at least UGX 20,000.');
  END IF;

  SELECT existing_total, existing_count INTO v_exist, v_count FROM public._partner_contract_coverage(p_partner_id);
  v_needed := greatest(0, v_amount - v_exist);
  v_float  := coalesce(public.funder_float_available(p_partner_id), 0);

  IF p_countersign_only AND v_needed > 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'CONTRACT_NOT_COVERED', 'needed', v_needed,
      'message', format('The contract (UGX %s) is more than this partner''s portfolios (UGX %s). Countersign from the Sign-off dialog so the difference is handled.',
                        to_char(v_amount, 'FM999,999,999,999'), to_char(v_exist, 'FM999,999,999,999')));
  END IF;

  IF v_float < v_needed THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLOAT_SHORT',
      'needed', v_needed, 'float_available', v_float, 'shortfall', v_needed - v_float,
      'message', format('Operational float is short by UGX %s. Needed UGX %s, available UGX %s. Nothing was sent.',
                        to_char(v_needed - v_float, 'FM999,999,999,999'),
                        to_char(v_needed, 'FM999,999,999,999'), to_char(v_float, 'FM999,999,999,999')));
  END IF;

  -- A self-registered funder must be verified by Partner Ops before any
  -- portfolio can be created for them (enforce_funder_verified_for_portfolio).
  -- Refuse cleanly here instead of letting the trigger raise a 500.
  IF v_mode = 'company_managed' AND v_needed > 0 AND EXISTS (
       SELECT 1 FROM public.profiles pr
        WHERE pr.id = p_partner_id
          AND pr.signup_source = 'funder-onboarding'
          AND pr.funder_verified_at IS NULL) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FUNDER_NOT_VERIFIED',
      'message', 'This partner signed up on their own and has not been verified yet. Verify the partner first, then countersign. Nothing was sent.');
  END IF;

  v_option := coalesce(
    CASE WHEN p_return_option IN ('A', 'B') THEN p_return_option END,
    CASE WHEN a.return_option IN ('A', 'B') THEN a.return_option END,
    (SELECT CASE ip.roi_mode WHEN 'monthly_payout' THEN 'A' WHEN 'monthly_compounding' THEN 'B' END
       FROM public.investor_portfolios ip
      WHERE ip.investor_id = p_partner_id ORDER BY ip.created_at LIMIT 1),
    'A');

  IF v_mode = 'company_managed' AND v_needed > 0 THEN
    v_roi_mode := CASE v_option WHEN 'A' THEN 'monthly_payout' ELSE 'monthly_compounding' END;

    v_pid := gen_random_uuid();
    LOOP
      v_code := 'WIP' || to_char(now() AT TIME ZONE 'UTC', 'YYMMDD') || lpad((floor(random()*9000)+1000)::int::text, 4, '0');
      EXIT WHEN NOT EXISTS (SELECT 1 FROM public.investor_portfolios WHERE portfolio_code = v_code);
    END LOOP;

    v_group := public.create_ledger_transaction(
      entries := jsonb_build_array(
        jsonb_build_object(
          'user_id', p_partner_id, 'amount', v_needed, 'direction', 'cash_out',
          'category', 'partner_funding', 'ledger_scope', 'wallet',
          'recipient_type', 'operational_wallet', 'wallet_bucket', 'float',
          'description', format('Operational float deployed to portfolio %s on agreement countersign (float_usage=partner_portfolio_funding)', v_code),
          'source_table', 'investor_portfolios', 'source_id', v_pid,
          'reference_id', v_code, 'linked_party', 'platform'),
        jsonb_build_object(
          'amount', v_needed, 'direction', 'cash_in',
          'category', 'partner_funding', 'ledger_scope', 'platform',
          'description', format('Platform capital received for portfolio %s (agreement countersign)', v_code),
          'source_table', 'investor_portfolios', 'source_id', v_pid,
          'reference_id', v_code, 'linked_party', p_partner_id::text)),
      idempotency_key := 'portfolio-funding-' || v_pid::text);

    INSERT INTO public.investor_portfolios (
      id, investor_id, agent_id, portfolio_code, investment_amount,
      roi_percentage, roi_mode, duration_months, payout_day,
      next_roi_date, maturity_date, status, portfolio_pin, activation_token, auto_reinvest,
      cfo_verified, cfo_verified_at, cfo_verified_by
    ) VALUES (
      v_pid, p_partner_id, p_partner_id, v_code, v_needed,
      15, v_roi_mode, 12, least(extract(day FROM v_today)::int, 28),
      (v_today + interval '1 month')::date, (v_today + interval '12 months')::date,
      'active', lpad((floor(random()*9000)+1000)::int::text, 4, '0'), gen_random_uuid(), false,
      true, now(), p_actor
    );

    INSERT INTO public.wallet_transactions (sender_id, recipient_id, amount, description)
    VALUES (p_partner_id, p_partner_id, v_needed, 'Portfolio funded: ' || v_code);

    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, action, reason, metadata)
    VALUES (p_actor, 'countersign_auto_portfolio', 'investor_portfolios', v_pid::text,
      'countersign_auto_portfolio', 'Portfolio created automatically on agreement countersign (company-managed)',
      jsonb_build_object('partner_id', p_partner_id, 'contract_amount', v_amount, 'existing_total', v_exist,
                         'created_amount', v_needed, 'portfolio_code', v_code, 'return_option', v_option,
                         'ledger_group_id', v_group, 'float_before', v_float));
  END IF;

  UPDATE public.partner_agreements
     SET partnership_amount = v_amount,
         partnership_amount_words = CASE WHEN partnership_amount IS DISTINCT FROM v_amount THEN NULL ELSE partnership_amount_words END,
         return_option = v_option,
         support_mode = v_mode,
         support_mode_set_at = CASE WHEN support_mode IS DISTINCT FROM v_mode THEN now() ELSE support_mode_set_at END,
         support_mode_set_by = CASE WHEN support_mode IS DISTINCT FROM v_mode THEN p_actor ELSE support_mode_set_by END,
         self_support_allowance = CASE WHEN v_mode = 'self_support' THEN v_needed ELSE NULL END,
         auto_portfolio_id = coalesce(v_pid, auto_portfolio_id)
   WHERE id = a.id;

  RETURN jsonb_build_object('ok', true, 'support_mode', v_mode, 'contract_amount', v_amount,
    'existing_total', v_exist, 'needed', v_needed, 'float_available', v_float,
    'portfolio_id', v_pid, 'portfolio_code', v_code, 'return_option', v_option,
    'self_support_allowance', CASE WHEN v_mode = 'self_support' THEN v_needed END);
END;
$function$;