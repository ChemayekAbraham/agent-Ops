CREATE OR REPLACE FUNCTION public.unlock_portfolio(p_portfolio_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_p record;
  v_next date;
  v_day int;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT (
    public.has_role(v_actor, 'manager') OR public.has_role(v_actor, 'ceo')
    OR public.has_role(v_actor, 'coo') OR public.has_role(v_actor, 'cfo')
    OR public.has_role(v_actor, 'super_admin') OR public.has_role(v_actor, 'partner_ops')
  ) THEN
    RAISE EXCEPTION 'Not authorized to unlock portfolios';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'A reason of at least 10 characters is required';
  END IF;

  SELECT * INTO v_p FROM public.investor_portfolios WHERE id = p_portfolio_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Portfolio not found'; END IF;
  IF v_p.status IS DISTINCT FROM 'locked' THEN RAISE EXCEPTION 'Portfolio is not locked'; END IF;

  -- Returns resume from the next payout day after today; no back-dated Returns for the locked period.
  v_next := v_p.next_roi_date;
  IF v_next IS NULL OR v_next <= current_date THEN
    v_day := LEAST(GREATEST(COALESCE(v_p.payout_day, 1), 1), 28);
    v_next := make_date(extract(year FROM current_date)::int, extract(month FROM current_date)::int, v_day);
    IF v_next <= current_date THEN v_next := (v_next + interval '1 month')::date; END IF;
  END IF;

  UPDATE public.investor_portfolios
     SET status = 'active', next_roi_date = v_next
   WHERE id = p_portfolio_id;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
  VALUES (v_actor, 'portfolio_unlocked', 'investor_portfolios', p_portfolio_id::text, btrim(p_reason),
          jsonb_build_object('portfolio_code', v_p.portfolio_code, 'investment_amount', v_p.investment_amount,
                             'locked_at', v_p.locked_at, 'lock_reason', v_p.lock_reason,
                             'locked_from_portfolio_id', v_p.locked_from_portfolio_id,
                             'next_roi_date', v_next));

  BEGIN
    INSERT INTO public.system_events (event_type, related_entity_type, related_entity_id, user_id, metadata)
    VALUES ('portfolio_unlocked', 'investor_portfolios', p_portfolio_id, v_actor,
            jsonb_build_object('portfolio_code', v_p.portfolio_code, 'reason', btrim(p_reason)));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN jsonb_build_object('status', 'active', 'portfolio_id', p_portfolio_id, 'next_roi_date', v_next);
END;
$$;

REVOKE ALL ON FUNCTION public.unlock_portfolio(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.unlock_portfolio(uuid, text) TO authenticated, service_role;