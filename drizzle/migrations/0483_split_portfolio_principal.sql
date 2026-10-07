CREATE OR REPLACE FUNCTION public.split_portfolio_principal(p_portfolio_id uuid, p_split_amount numeric, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid(); v_p record; v_split numeric; v_remainder numeric;
  v_child_id uuid; v_suffix int; v_code text;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT (public.has_role(v_actor,'partner_ops') OR public.has_role(v_actor,'manager') OR public.has_role(v_actor,'coo')
       OR public.has_role(v_actor,'cfo') OR public.has_role(v_actor,'ceo') OR public.has_role(v_actor,'super_admin')) THEN
    RAISE EXCEPTION 'Not authorized to split portfolios' USING ERRCODE = '42501';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 10 THEN RAISE EXCEPTION 'A reason of at least 10 characters is required'; END IF;

  SELECT * INTO v_p FROM public.investor_portfolios WHERE id = p_portfolio_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Portfolio not found'; END IF;
  IF v_p.status <> 'active' THEN RAISE EXCEPTION 'Only active portfolios can be split'; END IF;
  IF v_p.pending_renewal_request_id IS NOT NULL THEN RAISE EXCEPTION 'Portfolio has a pending renewal'; END IF;

  v_split := round(coalesce(p_split_amount,0));
  IF v_split <= 0 THEN RAISE EXCEPTION 'Split amount must be greater than zero'; END IF;
  v_remainder := round(v_p.investment_amount) - v_split;
  IF v_remainder < 1 THEN RAISE EXCEPTION 'Split amount must be less than the portfolio principal'; END IF;
  IF v_remainder < round(coalesce(v_p.principal_allocated,0)) THEN
    RAISE EXCEPTION 'Split would leave less than the principal already placed on Rent Plans (UGX %)', round(coalesce(v_p.principal_allocated,0));
  END IF;

  SELECT count(*)::int + 1 INTO v_suffix FROM public.investor_portfolios
   WHERE locked_from_portfolio_id = p_portfolio_id AND portfolio_code LIKE coalesce(v_p.portfolio_code,'WIP') || '-S%';
  v_code := coalesce(v_p.portfolio_code,'WIP') || '-S' || v_suffix;

  PERFORM set_config('app.portfolio_action', 'portfolio_split', true);

  -- Inserted as 'locked' then activated, so the carve-out is not treated as new
  -- funding (no wallet debit) nor a new fund-in (no commission). Capital was
  -- already received for the parent.
  INSERT INTO public.investor_portfolios (
    investor_id, invite_id, agent_id, portfolio_code, portfolio_pin, investment_amount, duration_months,
    roi_percentage, roi_mode, payment_method, mobile_network, mobile_money_number,
    bank_name, account_name, account_number, bank_account_name, status, payout_day,
    display_currency, maturity_date, next_roi_date, total_roi_earned, auto_reinvest,
    created_at, cfo_verified, cfo_verified_at, cfo_verified_by, investment_reference,
    locked_from_portfolio_id, allocation_note
  ) VALUES (
    v_p.investor_id, v_p.invite_id, v_p.agent_id, v_code,
    coalesce(nullif(btrim(coalesce(v_p.portfolio_pin,'')),''), lpad((floor(random()*9000)+1000)::int::text,4,'0')),
    v_split, v_p.duration_months, v_p.roi_percentage, v_p.roi_mode, v_p.payment_method, v_p.mobile_network,
    v_p.mobile_money_number, v_p.bank_name, v_p.account_name, v_p.account_number, v_p.bank_account_name,
    'locked', v_p.payout_day, v_p.display_currency, v_p.maturity_date, v_p.next_roi_date, 0, v_p.auto_reinvest,
    v_p.created_at, v_p.cfo_verified, v_p.cfo_verified_at, v_p.cfo_verified_by, v_p.investment_reference,
    p_portfolio_id, 'Split from ' || coalesce(v_p.portfolio_code,'portfolio')
  ) RETURNING id INTO v_child_id;

  UPDATE public.investor_portfolios SET status = 'active' WHERE id = v_child_id;
  UPDATE public.investor_portfolios
     SET investment_amount = v_remainder,
         principal_unallocated = GREATEST(0, coalesce(principal_unallocated,0) - v_split)
   WHERE id = p_portfolio_id;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
  VALUES (v_actor, 'portfolio_split', 'investor_portfolios', p_portfolio_id::text, btrim(p_reason),
    jsonb_build_object('split_amount', v_split, 'remaining_amount', v_remainder, 'original_amount', round(v_p.investment_amount),
      'new_portfolio_id', v_child_id, 'new_portfolio_code', v_code, 'portfolio_code', v_p.portfolio_code));

  -- No email or notification for a split: mark these change-log rows as already handled.
  UPDATE public.portfolio_change_log SET notified_at = now()
   WHERE portfolio_id IN (p_portfolio_id, v_child_id) AND notified_at IS NULL;

  RETURN jsonb_build_object('new_portfolio_id', v_child_id, 'new_portfolio_code', v_code,
                            'split_amount', v_split, 'remaining_amount', v_remainder);
END $function$;
REVOKE ALL ON FUNCTION public.split_portfolio_principal(uuid, numeric, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.split_portfolio_principal(uuid, numeric, text) TO authenticated;