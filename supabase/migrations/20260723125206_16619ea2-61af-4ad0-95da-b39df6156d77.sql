-- Allow approve_pending_portfolio to accept awaiting_partner_details (used by
-- direct_confirmation flow for first-time partners) in addition to
-- pending_ops_approval. Also activate the already-stuck WIP2607238308.
CREATE OR REPLACE FUNCTION public.approve_pending_portfolio(p_portfolio_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_status text;
BEGIN
  IF v_caller IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT public.is_partner_ops(v_caller) THEN RAISE EXCEPTION 'NOT_AUTHORIZED'; END IF;

  SELECT status INTO v_status FROM public.investor_portfolios WHERE id = p_portfolio_id;
  IF v_status IS NULL THEN RAISE EXCEPTION 'PORTFOLIO_NOT_FOUND'; END IF;
  IF v_status NOT IN ('pending_ops_approval','awaiting_partner_details') THEN
    RAISE EXCEPTION 'INVALID_STATUS' USING HINT = v_status;
  END IF;

  UPDATE public.investor_portfolios
     SET status = 'active'
   WHERE id = p_portfolio_id;

  INSERT INTO public.audit_logs (
    user_id, action_type, table_name, record_id, metadata
  ) VALUES (
    v_caller, 'approve_pending_portfolio', 'investor_portfolios', p_portfolio_id,
    jsonb_build_object('reason','ops_approved_partner_completed_portfolio','prev_status',v_status)
  );

  RETURN p_portfolio_id;
END; $function$;