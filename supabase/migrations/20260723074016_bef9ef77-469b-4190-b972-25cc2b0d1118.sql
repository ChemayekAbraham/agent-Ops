
-- ============ portfolio_completion_tokens ============
CREATE TABLE IF NOT EXISTS public.portfolio_completion_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  portfolio_id uuid NOT NULL UNIQUE REFERENCES public.investor_portfolios(id) ON DELETE CASCADE,
  partner_id uuid NOT NULL,
  token_hash text NOT NULL,
  email_snapshot text,
  phone_snapshot text,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
  consumed_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pct_partner ON public.portfolio_completion_tokens(partner_id);
CREATE INDEX IF NOT EXISTS idx_pct_hash ON public.portfolio_completion_tokens(token_hash);

GRANT SELECT ON public.portfolio_completion_tokens TO authenticated;
GRANT ALL ON public.portfolio_completion_tokens TO service_role;
ALTER TABLE public.portfolio_completion_tokens ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "partner can read own completion token" ON public.portfolio_completion_tokens;
CREATE POLICY "partner can read own completion token"
  ON public.portfolio_completion_tokens FOR SELECT
  TO authenticated
  USING (partner_id = auth.uid());

-- ============ Ops-role helper (mirrors coo-create-portfolio guard) ============
CREATE OR REPLACE FUNCTION public.is_partner_ops(_uid uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _uid AND role IN ('manager','coo','super_admin','cto')
  ) OR EXISTS (
    SELECT 1 FROM public.staff_permissions
    WHERE user_id = _uid AND permitted_dashboard = 'partner-ops'
  );
$$;

-- ============ create_pending_portfolio ============
-- Ops-only. Creates an inert portfolio + returns a one-shot raw token.
-- Token is stored hashed; caller must email the raw value once.
CREATE OR REPLACE FUNCTION public.create_pending_portfolio(
  p_partner_id uuid,
  p_amount numeric,
  p_duration_months integer,
  p_roi_percentage numeric,
  p_roi_mode text,
  p_nickname text,
  p_raw_token text
)
RETURNS TABLE(portfolio_id uuid, portfolio_code text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_partner_email text;
  v_partner_phone text;
  v_ref text;
  v_pid uuid;
  v_pin text;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED' USING HINT = 'not_signed_in';
  END IF;
  IF NOT public.is_partner_ops(v_caller) THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED' USING HINT = 'only_partner_ops_can_create_portfolios';
  END IF;
  IF p_amount IS NULL OR p_amount < 20000 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT' USING HINT = 'amount_below_minimum';
  END IF;
  IF p_duration_months IS NULL OR p_duration_months < 1 OR p_duration_months > 60 THEN
    RAISE EXCEPTION 'INVALID_DURATION' USING HINT = 'duration_out_of_range';
  END IF;
  IF p_roi_percentage IS NULL OR p_roi_percentage <= 0 OR p_roi_percentage > 100 THEN
    RAISE EXCEPTION 'INVALID_ROI' USING HINT = 'roi_out_of_range';
  END IF;
  IF p_roi_mode NOT IN ('monthly_payout','monthly_compounding') THEN
    RAISE EXCEPTION 'INVALID_MODE' USING HINT = 'roi_mode_invalid';
  END IF;
  IF p_raw_token IS NULL OR length(p_raw_token) < 32 THEN
    RAISE EXCEPTION 'INVALID_TOKEN' USING HINT = 'token_too_short';
  END IF;

  SELECT email, phone INTO v_partner_email, v_partner_phone
  FROM public.profiles WHERE id = p_partner_id;
  IF v_partner_email IS NULL AND v_partner_phone IS NULL THEN
    RAISE EXCEPTION 'PARTNER_MISSING_CONTACT' USING HINT = 'partner_has_no_email_or_phone';
  END IF;

  -- portfolio_code (WIP prefix, matches existing convention)
  v_ref := 'WIP' ||
    to_char(now() AT TIME ZONE 'UTC', 'YYMMDD') ||
    lpad((floor(random()*9000)+1000)::int::text, 4, '0');
  v_pin := lpad((floor(random()*9000)+1000)::int::text, 4, '0');

  INSERT INTO public.investor_portfolios (
    investor_id, agent_id, portfolio_code, investment_amount,
    roi_percentage, roi_mode, duration_months, payout_day,
    status, portfolio_pin, activation_token, auto_reinvest
  )
  VALUES (
    p_partner_id, p_partner_id, v_ref, p_amount,
    p_roi_percentage, p_roi_mode, p_duration_months, 15,
    'awaiting_partner_details', v_pin, gen_random_uuid(), false
  )
  RETURNING id INTO v_pid;

  INSERT INTO public.portfolio_completion_tokens (
    portfolio_id, partner_id, token_hash,
    email_snapshot, phone_snapshot, created_by
  )
  VALUES (
    v_pid, p_partner_id, encode(digest(p_raw_token, 'sha256'), 'hex'),
    v_partner_email, v_partner_phone, v_caller
  );

  INSERT INTO public.audit_logs (
    user_id, action_type, table_name, record_id, metadata
  ) VALUES (
    v_caller, 'create_pending_portfolio', 'investor_portfolios', v_pid,
    jsonb_build_object(
      'partner_id', p_partner_id,
      'amount', p_amount,
      'roi_percentage', p_roi_percentage,
      'duration_months', p_duration_months,
      'roi_mode', p_roi_mode,
      'nickname', p_nickname,
      'reason', 'partner_completion_invite_sent'
    )
  );

  RETURN QUERY SELECT v_pid, v_ref;
END; $$;

REVOKE ALL ON FUNCTION public.create_pending_portfolio(uuid,numeric,integer,numeric,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_pending_portfolio(uuid,numeric,integer,numeric,text,text,text) TO authenticated, service_role;

-- ============ complete_partner_portfolio ============
-- Partner-only. Called from edge function AFTER JWT check.
-- Validates token; flips status; audits.
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
  IF encode(digest(p_raw_token, 'sha256'), 'hex') <> v_tok.token_hash THEN
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

REVOKE ALL ON FUNCTION public.complete_partner_portfolio(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.complete_partner_portfolio(uuid,text) TO authenticated, service_role;

-- ============ approve_pending_portfolio ============
-- Ops-only. Flips pending_ops_approval → active. Does NOT post ledger — capital
-- funding remains a separate operation (existing top-up flow).
CREATE OR REPLACE FUNCTION public.approve_pending_portfolio(p_portfolio_id uuid)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_status text;
BEGIN
  IF v_caller IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT public.is_partner_ops(v_caller) THEN RAISE EXCEPTION 'NOT_AUTHORIZED'; END IF;

  SELECT status INTO v_status FROM public.investor_portfolios WHERE id = p_portfolio_id;
  IF v_status IS NULL THEN RAISE EXCEPTION 'PORTFOLIO_NOT_FOUND'; END IF;
  IF v_status <> 'pending_ops_approval' THEN
    RAISE EXCEPTION 'INVALID_STATUS' USING HINT = v_status;
  END IF;

  UPDATE public.investor_portfolios
     SET status = 'active'
   WHERE id = p_portfolio_id;

  INSERT INTO public.audit_logs (
    user_id, action_type, table_name, record_id, metadata
  ) VALUES (
    v_caller, 'approve_pending_portfolio', 'investor_portfolios', p_portfolio_id,
    jsonb_build_object('reason','ops_approved_partner_completed_portfolio')
  );

  RETURN p_portfolio_id;
END; $$;

REVOKE ALL ON FUNCTION public.approve_pending_portfolio(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.approve_pending_portfolio(uuid) TO authenticated, service_role;
