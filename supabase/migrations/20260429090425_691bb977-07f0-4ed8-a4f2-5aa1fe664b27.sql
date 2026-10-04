CREATE OR REPLACE FUNCTION public.approve_self_registered_funder(_target_user uuid, _reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_source text;
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

  SELECT signup_source INTO v_source
  FROM public.profiles
  WHERE id = _target_user;

  IF v_source IS DISTINCT FROM 'funder-onboarding' THEN
    RAISE EXCEPTION 'not_a_self_registered_funder';
  END IF;

  UPDATE public.profiles
  SET funder_verified_at = now(),
      funder_verified_by = v_actor,
      funder_rejected_at = NULL,
      funder_rejection_reason = NULL,
      verified = true,
      updated_at = now()
  WHERE id = _target_user;

  INSERT INTO public.audit_logs (user_id, action_type, action, table_name, record_id, metadata)
  VALUES (
    v_actor,
    'approve_self_registered_funder',
    'approve_self_registered_funder',
    'profiles',
    _target_user::text,
    jsonb_build_object(
      'reason', trim(_reason),
      'approved_at', now(),
      'target_user_id', _target_user,
      'actor_id', v_actor
    )
  );

  INSERT INTO public.system_events (event_type, source, payload)
  VALUES (
    'funder.self_registered.approved',
    'partner_ops',
    jsonb_build_object('user_id', _target_user, 'actor_id', v_actor, 'reason', trim(_reason))
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.reject_self_registered_funder(_target_user uuid, _reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_source text;
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

  SELECT signup_source INTO v_source
  FROM public.profiles
  WHERE id = _target_user;

  IF v_source IS DISTINCT FROM 'funder-onboarding' THEN
    RAISE EXCEPTION 'not_a_self_registered_funder';
  END IF;

  UPDATE public.profiles
  SET funder_rejected_at = now(),
      funder_rejection_reason = trim(_reason),
      funder_verified_at = NULL,
      funder_verified_by = NULL,
      verified = false,
      updated_at = now()
  WHERE id = _target_user;

  INSERT INTO public.audit_logs (user_id, action_type, action, table_name, record_id, metadata)
  VALUES (
    v_actor,
    'reject_self_registered_funder',
    'reject_self_registered_funder',
    'profiles',
    _target_user::text,
    jsonb_build_object(
      'reason', trim(_reason),
      'rejected_at', now(),
      'target_user_id', _target_user,
      'actor_id', v_actor
    )
  );

  INSERT INTO public.system_events (event_type, source, payload)
  VALUES (
    'funder.self_registered.rejected',
    'partner_ops',
    jsonb_build_object('user_id', _target_user, 'actor_id', v_actor, 'reason', trim(_reason))
  );
END;
$$;