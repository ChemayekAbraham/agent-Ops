CREATE OR REPLACE FUNCTION public.lock_portfolio_principal(
  p_portfolio_id uuid,
  p_locked_amount numeric,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_p record;
  v_locked numeric;
  v_remainder numeric;
  v_child_id uuid;
  v_suffix int;
  v_code text;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT (
    public.has_role(v_actor, 'manager')
    OR public.has_role(v_actor, 'ceo')
    OR public.has_role(v_actor, 'coo')
    OR public.has_role(v_actor, 'cfo')
    OR public.has_role(v_actor, 'super_admin')
    OR public.has_role(v_actor, 'partner_ops')
  ) THEN
    RAISE EXCEPTION 'Not authorized to lock portfolios';
  END IF;

  IF p_reason IS NULL OR length(btrim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'A reason of at least 10 characters is required';
  END IF;

  SELECT * INTO v_p FROM public.investor_portfolios WHERE id = p_portfolio_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Portfolio not found';
  END IF;

  IF v_p.status = 'locked' THEN
    RAISE EXCEPTION 'Portfolio is already locked';
  END IF;

  v_locked := round(coalesce(p_locked_amount, 0));
  IF v_locked <= 0 THEN
    RAISE EXCEPTION 'Locked amount must be greater than zero';
  END IF;
  IF v_locked > round(v_p.investment_amount) THEN
    RAISE EXCEPTION 'Locked amount cannot exceed the portfolio principal';
  END IF;

  v_remainder := round(v_p.investment_amount) - v_locked;

  IF v_remainder < 1 THEN
    -- Full lock: the whole portfolio stops earning.
    UPDATE public.investor_portfolios
       SET status = 'locked',
           locked_at = now(),
           locked_by = v_actor,
           lock_reason = btrim(p_reason)
     WHERE id = p_portfolio_id;

    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
    VALUES (v_actor, 'portfolio_locked_full', 'investor_portfolios', p_portfolio_id::text, btrim(p_reason),
            jsonb_build_object('locked_amount', v_locked, 'remaining_amount', 0, 'portfolio_code', v_p.portfolio_code));

    RETURN jsonb_build_object('mode', 'full', 'locked_amount', v_locked, 'remaining_amount', 0,
                              'locked_portfolio_id', p_portfolio_id);
  END IF;

  -- Partial lock: split into a locked child + active remainder.
  SELECT count(*)::int + 1 INTO v_suffix
    FROM public.investor_portfolios
   WHERE locked_from_portfolio_id = p_portfolio_id;
  v_code := coalesce(v_p.portfolio_code, 'WIP') || '-L' || v_suffix;

  INSERT INTO public.investor_portfolios (
    investor_id, invite_id, agent_id, portfolio_code, portfolio_pin, investment_amount, duration_months,
    roi_percentage, roi_mode, payment_method, mobile_network, mobile_money_number,
    bank_name, account_name, account_number, bank_account_name, status, payout_day,
    display_currency, maturity_date, next_roi_date, total_roi_earned,
    locked_at, locked_by, lock_reason, locked_from_portfolio_id
  ) VALUES (
    v_p.investor_id, v_p.invite_id, v_p.agent_id, v_code,
    coalesce(nullif(btrim(coalesce(v_p.portfolio_pin, '')), ''), lpad((floor(random() * 9000) + 1000)::int::text, 4, '0')),
    v_locked, v_p.duration_months,
    v_p.roi_percentage, v_p.roi_mode, v_p.payment_method, v_p.mobile_network, v_p.mobile_money_number,
    v_p.bank_name, v_p.account_name, v_p.account_number, v_p.bank_account_name, 'locked', v_p.payout_day,
    v_p.display_currency, v_p.maturity_date, v_p.next_roi_date, 0,
    now(), v_actor, btrim(p_reason), p_portfolio_id
  )
  RETURNING id INTO v_child_id;

  UPDATE public.investor_portfolios
     SET investment_amount = v_remainder
   WHERE id = p_portfolio_id;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
  VALUES (v_actor, 'portfolio_locked_partial', 'investor_portfolios', p_portfolio_id::text, btrim(p_reason),
          jsonb_build_object('locked_amount', v_locked, 'remaining_amount', v_remainder,
                             'locked_portfolio_id', v_child_id, 'locked_portfolio_code', v_code,
                             'original_amount', round(v_p.investment_amount),
                             'portfolio_code', v_p.portfolio_code));

  RETURN jsonb_build_object('mode', 'partial', 'locked_amount', v_locked, 'remaining_amount', v_remainder,
                            'locked_portfolio_id', v_child_id, 'locked_portfolio_code', v_code);
END;
$$;