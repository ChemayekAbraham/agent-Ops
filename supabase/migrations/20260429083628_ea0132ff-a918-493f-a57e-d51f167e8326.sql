-- 1) Verification audit columns on profiles
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS funder_verified_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS funder_verified_by      UUID,
  ADD COLUMN IF NOT EXISTS funder_rejected_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS funder_rejection_reason TEXT;

-- Backfill the one legacy funder that was already marked verified
UPDATE public.profiles
SET funder_verified_at = COALESCE(funder_verified_at, now())
WHERE signup_source = 'funder-onboarding'
  AND verified = true
  AND funder_verified_at IS NULL;

-- 2) Replace get_funder_approval_status:
--    For self-registered funders → use profile verification (source of truth).
--    For everyone else → keep proxy-assignment behavior.
CREATE OR REPLACE FUNCTION public.get_funder_approval_status(_user_id uuid)
RETURNS TABLE(status text, rejection_reason text, approved_at timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_signup_source        text;
  v_funder_verified_at   timestamptz;
  v_funder_rejected_at   timestamptz;
  v_funder_rej_reason    text;
BEGIN
  SELECT p.signup_source, p.funder_verified_at, p.funder_rejected_at, p.funder_rejection_reason
    INTO v_signup_source, v_funder_verified_at, v_funder_rejected_at, v_funder_rej_reason
  FROM public.profiles p
  WHERE p.id = _user_id;

  IF v_signup_source = 'funder-onboarding' THEN
    IF v_funder_verified_at IS NOT NULL THEN
      RETURN QUERY SELECT 'approved'::text, NULL::text, v_funder_verified_at;
      RETURN;
    ELSIF v_funder_rejected_at IS NOT NULL THEN
      RETURN QUERY SELECT 'rejected'::text, v_funder_rej_reason, NULL::timestamptz;
      RETURN;
    ELSE
      RETURN QUERY SELECT 'pending'::text, NULL::text, NULL::timestamptz;
      RETURN;
    END IF;
  END IF;

  -- Non self-registered users: previous proxy-assignment behavior
  RETURN QUERY
  WITH ranked AS (
    SELECT
      paa.approval_status,
      paa.rejection_reason,
      paa.approved_at,
      paa.is_active,
      CASE
        WHEN paa.approval_status = 'approved' AND paa.is_active = true THEN 1
        WHEN paa.approval_status = 'pending' THEN 2
        WHEN paa.approval_status = 'rejected' THEN 3
        ELSE 4
      END AS rank
    FROM public.proxy_agent_assignments paa
    WHERE paa.beneficiary_id = _user_id
      AND paa.beneficiary_role = 'supporter'
    ORDER BY rank ASC, paa.created_at DESC
    LIMIT 1
  )
  SELECT
    COALESCE(
      CASE
        WHEN approval_status = 'approved' AND is_active = true THEN 'approved'
        ELSE approval_status
      END,
      'none'
    )::text AS status,
    rejection_reason::text,
    approved_at
  FROM ranked
  UNION ALL
  SELECT 'none'::text, NULL::text, NULL::timestamptz
  WHERE NOT EXISTS (SELECT 1 FROM ranked)
  LIMIT 1;
END;
$$;

-- 3) Approve RPC
CREATE OR REPLACE FUNCTION public.approve_self_registered_funder(
  _target_user uuid,
  _reason      text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor   uuid := auth.uid();
  v_source  text;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'authentication_required';
  END IF;

  IF NOT (public.has_role(v_actor, 'manager'::app_role) OR public.has_role(v_actor, 'coo'::app_role)) THEN
    RAISE EXCEPTION 'insufficient_privileges';
  END IF;

  IF _reason IS NULL OR length(trim(_reason)) < 10 THEN
    RAISE EXCEPTION 'reason_min_10_chars';
  END IF;

  SELECT signup_source INTO v_source FROM public.profiles WHERE id = _target_user;
  IF v_source IS DISTINCT FROM 'funder-onboarding' THEN
    RAISE EXCEPTION 'not_a_self_registered_funder';
  END IF;

  UPDATE public.profiles
  SET funder_verified_at      = now(),
      funder_verified_by      = v_actor,
      funder_rejected_at      = NULL,
      funder_rejection_reason = NULL,
      verified                = true,
      updated_at              = now()
  WHERE id = _target_user;

  INSERT INTO public.audit_logs (actor_id, action_type, table_name, record_id, reason, metadata)
  VALUES (v_actor, 'approve_self_registered_funder', 'profiles', _target_user, _reason,
          jsonb_build_object('approved_at', now()));

  INSERT INTO public.system_events (event_type, source, payload)
  VALUES ('funder.self_registered.approved', 'partner_ops',
          jsonb_build_object('user_id', _target_user, 'actor_id', v_actor, 'reason', _reason));
END;
$$;

-- 4) Reject RPC
CREATE OR REPLACE FUNCTION public.reject_self_registered_funder(
  _target_user uuid,
  _reason      text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor   uuid := auth.uid();
  v_source  text;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'authentication_required';
  END IF;

  IF NOT (public.has_role(v_actor, 'manager'::app_role) OR public.has_role(v_actor, 'coo'::app_role)) THEN
    RAISE EXCEPTION 'insufficient_privileges';
  END IF;

  IF _reason IS NULL OR length(trim(_reason)) < 10 THEN
    RAISE EXCEPTION 'reason_min_10_chars';
  END IF;

  SELECT signup_source INTO v_source FROM public.profiles WHERE id = _target_user;
  IF v_source IS DISTINCT FROM 'funder-onboarding' THEN
    RAISE EXCEPTION 'not_a_self_registered_funder';
  END IF;

  UPDATE public.profiles
  SET funder_rejected_at      = now(),
      funder_rejection_reason = _reason,
      funder_verified_at      = NULL,
      funder_verified_by      = NULL,
      verified                = false,
      updated_at              = now()
  WHERE id = _target_user;

  INSERT INTO public.audit_logs (actor_id, action_type, table_name, record_id, reason, metadata)
  VALUES (v_actor, 'reject_self_registered_funder', 'profiles', _target_user, _reason,
          jsonb_build_object('rejected_at', now()));

  INSERT INTO public.system_events (event_type, source, payload)
  VALUES ('funder.self_registered.rejected', 'partner_ops',
          jsonb_build_object('user_id', _target_user, 'actor_id', v_actor, 'reason', _reason));
END;
$$;

-- 5) Server-side enforcement: block self-registered funders from inserting
-- portfolios until verified.
CREATE OR REPLACE FUNCTION public.enforce_funder_verified_for_portfolio()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_source       text;
  v_verified_at  timestamptz;
BEGIN
  -- Only check the investor (beneficiary) — not staff-created portfolios on behalf of investors.
  IF NEW.investor_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT signup_source, funder_verified_at
    INTO v_source, v_verified_at
  FROM public.profiles
  WHERE id = NEW.investor_id;

  IF v_source = 'funder-onboarding' AND v_verified_at IS NULL THEN
    RAISE EXCEPTION 'self_registered_funder_not_verified'
      USING HINT = 'Funder must be approved by Partner Ops or COO before creating a portfolio.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_funder_verified_for_portfolio ON public.investor_portfolios;
CREATE TRIGGER trg_enforce_funder_verified_for_portfolio
BEFORE INSERT ON public.investor_portfolios
FOR EACH ROW EXECUTE FUNCTION public.enforce_funder_verified_for_portfolio();