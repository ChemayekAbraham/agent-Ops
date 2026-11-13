CREATE OR REPLACE FUNCTION public.reject_pending_portfolio(p_portfolio_id uuid, p_reason text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_status text;
  v_pending public.funder_pending_portfolios%ROWTYPE;
BEGIN
  IF v_caller IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT public.is_partner_ops(v_caller) THEN RAISE EXCEPTION 'NOT_AUTHORIZED'; END IF;
  IF length(COALESCE(btrim(p_reason),'')) < 10 THEN
    RAISE EXCEPTION 'A reason of at least 10 characters is required.' USING ERRCODE = 'check_violation';
  END IF;

  SELECT status INTO v_status FROM public.investor_portfolios WHERE id = p_portfolio_id;
  IF v_status IS NULL THEN RAISE EXCEPTION 'PORTFOLIO_NOT_FOUND'; END IF;
  IF v_status <> 'pending_ops_approval' THEN
    RAISE EXCEPTION 'INVALID_STATUS' USING HINT = v_status;
  END IF;

  SELECT * INTO v_pending FROM public.funder_pending_portfolios
   WHERE portfolio_id = p_portfolio_id AND status = 'pending' FOR UPDATE;

  UPDATE public.investor_portfolios SET status = 'cancelled' WHERE id = p_portfolio_id;

  IF v_pending.id IS NOT NULL AND v_pending.source = 'self_managed' THEN
    UPDATE public.rent_requests rr
       SET self_funding_partner_id = NULL, self_funding_line_id = NULL, updated_at = now()
      FROM public.partner_self_funding_lines l
     WHERE l.commitment_id = v_pending.commitment_id AND rr.id = l.rent_request_id;

    UPDATE public.partner_self_plan_claims
       SET status = 'released', updated_at = now()
     WHERE commitment_id = v_pending.commitment_id;

    DELETE FROM public.partner_self_funding_lines WHERE commitment_id = v_pending.commitment_id;

    UPDATE public.partner_self_commitments
       SET status = 'cancelled', updated_at = now()
     WHERE id = v_pending.commitment_id;
  END IF;

  IF v_pending.id IS NOT NULL THEN
    UPDATE public.funder_pending_portfolios
       SET status = 'rejected', reviewed_by = v_caller, reviewed_at = now(),
           review_reason = btrim(p_reason), updated_at = now()
     WHERE id = v_pending.id;
  END IF;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  VALUES (v_caller, 'reject_pending_portfolio', 'investor_portfolios', p_portfolio_id,
    jsonb_build_object('reason', btrim(p_reason), 'prev_status', v_status));

  RETURN p_portfolio_id;
END;
$function$
