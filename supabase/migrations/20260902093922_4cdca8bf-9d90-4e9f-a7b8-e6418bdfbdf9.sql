-- Allow trusted SECURITY DEFINER flows (e.g. partner onboarding submission) to
-- transition a portfolio owned by the caller, while keeping the self-edit lock
-- for direct table writes by the owner.
CREATE OR REPLACE FUNCTION public.guard_investor_portfolio_self_edit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_privileged boolean;
BEGIN
  -- Trusted server-side flow explicitly opted out of the guard.
  IF coalesce(current_setting('welile.portfolio_trusted', true), '') = 'on' THEN
    RETURN NEW;
  END IF;

  -- Only guard direct edits made by the portfolio owner as a signed-in user.
  IF v_uid IS NULL OR v_uid IS DISTINCT FROM NEW.investor_id THEN
    RETURN NEW;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.user_roles ur
     WHERE ur.user_id = v_uid
       AND ur.role IN ('super_admin','admin','manager','ceo','coo','cfo',
                       'financial_ops','partner_ops','operations')
  ) INTO v_privileged;

  IF v_privileged THEN
    RETURN NEW;
  END IF;

  IF to_jsonb(NEW) - 'account_name' - 'updated_at'
     IS DISTINCT FROM to_jsonb(OLD) - 'account_name' - 'updated_at' THEN
    RAISE EXCEPTION 'PORTFOLIO_FIELD_LOCKED'
      USING HINT = 'You can only change the account name on your own portfolio.',
            ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.guard_investor_portfolio_self_edit() FROM PUBLIC, anon, authenticated;

-- Partner onboarding submission: set the trusted flag for the duration of the
-- transaction so the owner-lock does not block the status transition.
CREATE OR REPLACE FUNCTION public.complete_partner_portfolio(p_portfolio_id uuid, p_raw_token text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
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
  IF v_status NOT IN ('awaiting_partner_details', 'pending_ops_approval') THEN
    RAISE EXCEPTION 'INVALID_STATUS' USING HINT = v_status;
  END IF;

  PERFORM set_config('welile.portfolio_trusted', 'on', true);

  UPDATE public.investor_portfolios
     SET status = 'pending_ops_approval'
   WHERE id = p_portfolio_id;

  PERFORM set_config('welile.portfolio_trusted', 'off', true);

  UPDATE public.portfolio_completion_tokens
     SET consumed_at = now()
   WHERE portfolio_id = p_portfolio_id;

  INSERT INTO public.audit_logs (
    user_id, action_type, table_name, record_id, metadata
  ) VALUES (
    v_caller, 'complete_partner_portfolio', 'investor_portfolios', p_portfolio_id,
    jsonb_build_object('reason','partner_submitted_completion_details','prior_status', v_status)
  );

  RETURN p_portfolio_id;
END; $$;

REVOKE EXECUTE ON FUNCTION public.complete_partner_portfolio(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_partner_portfolio(uuid, text) TO authenticated;