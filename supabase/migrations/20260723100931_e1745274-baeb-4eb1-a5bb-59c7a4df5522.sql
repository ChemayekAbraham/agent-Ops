CREATE OR REPLACE FUNCTION public.complete_partner_portfolio(
  p_portfolio_id uuid,
  p_raw_token text
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_tok record;
  v_status text;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;

  SELECT * INTO v_tok
  FROM public.portfolio_completion_tokens
  WHERE portfolio_id = p_portfolio_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'TOKEN_NOT_FOUND';
  END IF;
  IF v_tok.partner_id <> v_caller THEN
    RAISE EXCEPTION 'NOT_TOKEN_OWNER';
  END IF;
  IF v_tok.consumed_at IS NOT NULL THEN
    RAISE EXCEPTION 'TOKEN_ALREADY_USED';
  END IF;
  IF v_tok.expires_at < now() THEN
    RAISE EXCEPTION 'TOKEN_EXPIRED';
  END IF;
  IF encode(extensions.digest(p_raw_token, 'sha256'), 'hex') <> v_tok.token_hash THEN
    RAISE EXCEPTION 'TOKEN_MISMATCH';
  END IF;

  SELECT status INTO v_status FROM public.investor_portfolios WHERE id = p_portfolio_id;
  IF v_status <> 'awaiting_partner_details' THEN
    RAISE EXCEPTION 'INVALID_STATUS' USING HINT = v_status;
  END IF;

  UPDATE public.investor_portfolios
     SET status = 'pending_ops_approval'
   WHERE id = p_portfolio_id;

  UPDATE public.portfolio_completion_tokens
     SET consumed_at = now()
   WHERE portfolio_id = p_portfolio_id;

  INSERT INTO public.audit_logs (
    user_id, action_type, table_name, record_id, metadata
  ) VALUES (
    v_caller, 'complete_partner_portfolio', 'investor_portfolios', p_portfolio_id,
    jsonb_build_object('reason','partner_submitted_completion_details')
  );

  RETURN p_portfolio_id;
END; $$;