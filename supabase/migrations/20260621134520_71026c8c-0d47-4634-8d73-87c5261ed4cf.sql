CREATE OR REPLACE FUNCTION public.set_landlord_verification(p_landlord_id uuid, p_status text, p_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_name text;
  v_reason text := btrim(p_reason);
  v_title text;
  v_message text;
  v_type text;
BEGIN
  IF NOT is_ops_role(v_actor) THEN RAISE EXCEPTION 'Not authorized'; END IF;
  IF p_status NOT IN ('pending','verified','rejected') THEN RAISE EXCEPTION 'Invalid status'; END IF;
  IF v_reason IS NULL OR length(v_reason) < 10 THEN RAISE EXCEPTION 'A reason of at least 10 characters is required'; END IF;

  UPDATE public.landlords
  SET verification_status = p_status,
      verification_reason = v_reason,
      verified = (p_status = 'verified'),
      verified_at = CASE WHEN p_status = 'verified' THEN now() ELSE verified_at END,
      verified_by = CASE WHEN p_status = 'verified' THEN v_actor ELSE verified_by END
  WHERE id = p_landlord_id
  RETURNING name INTO v_name;
  IF NOT FOUND THEN RAISE EXCEPTION 'Landlord not found'; END IF;

  UPDATE public.landlord_verification_requests
  SET status = p_status,
      reject_comment = CASE WHEN p_status = 'rejected' THEN v_reason ELSE reject_comment END,
      resolved_by = v_actor,
      resolved_at = now()
  WHERE landlord_id = p_landlord_id AND status = 'pending';

  INSERT INTO public.audit_logs(user_id, action_type, table_name, record_id, metadata)
  VALUES (v_actor, 'landlord_verification_status_set', 'landlords', p_landlord_id,
    jsonb_build_object('status', p_status, 'reason', v_reason));

  -- Notify every borrower linked to this landlord
  IF p_status = 'verified' THEN
    v_type := 'success';
    v_title := 'Landlord verified';
    v_message := 'Your landlord' || COALESCE(' (' || v_name || ')', '') || ' GPS location has been verified. You can now request a loan.';
  ELSIF p_status = 'rejected' THEN
    v_type := 'error';
    v_title := 'Landlord verification rejected';
    v_message := 'Your landlord' || COALESCE(' (' || v_name || ')', '') || ' verification was rejected. Reason: ' || v_reason;
  ELSE
    v_type := 'info';
    v_title := 'Landlord verification pending';
    v_message := 'Your landlord' || COALESCE(' (' || v_name || ')', '') || ' verification is under review. ' || v_reason;
  END IF;

  INSERT INTO public.notifications (user_id, title, message, type, metadata)
  SELECT p.id, v_title, v_message, v_type,
    jsonb_build_object('kind', 'landlord_verification', 'landlord_id', p_landlord_id, 'status', p_status, 'reason', v_reason)
  FROM public.profiles p
  WHERE p.borrower_landlord_id = p_landlord_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_lc1_verification(p_lc1_id uuid, p_status text, p_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_name text;
  v_reason text := btrim(p_reason);
  v_title text;
  v_message text;
  v_type text;
BEGIN
  IF NOT is_ops_role(v_actor) THEN RAISE EXCEPTION 'Not authorized'; END IF;
  IF p_status NOT IN ('pending','verified','rejected') THEN RAISE EXCEPTION 'Invalid status'; END IF;
  IF v_reason IS NULL OR length(v_reason) < 10 THEN RAISE EXCEPTION 'A reason of at least 10 characters is required'; END IF;

  UPDATE public.lc1_chairpersons
  SET verification_status = p_status,
      verification_reason = v_reason,
      verified = (p_status = 'verified'),
      verified_at = CASE WHEN p_status = 'verified' THEN now() ELSE verified_at END,
      verified_by = CASE WHEN p_status = 'verified' THEN v_actor ELSE verified_by END
  WHERE id = p_lc1_id
  RETURNING name INTO v_name;
  IF NOT FOUND THEN RAISE EXCEPTION 'LC1 chairperson not found'; END IF;

  UPDATE public.lc1_verification_requests
  SET status = p_status,
      reject_comment = CASE WHEN p_status = 'rejected' THEN v_reason ELSE reject_comment END,
      resolved_by = v_actor,
      resolved_at = now()
  WHERE lc1_id = p_lc1_id AND status = 'pending';

  INSERT INTO public.audit_logs(user_id, action_type, table_name, record_id, metadata)
  VALUES (v_actor, 'lc1_verification_status_set', 'lc1_chairpersons', p_lc1_id,
    jsonb_build_object('status', p_status, 'reason', v_reason));

  -- Notify every borrower linked to this LC1 chairperson
  IF p_status = 'verified' THEN
    v_type := 'success';
    v_title := 'LC1 chairperson verified';
    v_message := 'Your LC1 chairperson' || COALESCE(' (' || v_name || ')', '') || ' has been verified. You can now request a loan.';
  ELSIF p_status = 'rejected' THEN
    v_type := 'error';
    v_title := 'LC1 verification rejected';
    v_message := 'Your LC1 chairperson' || COALESCE(' (' || v_name || ')', '') || ' verification was rejected. Reason: ' || v_reason;
  ELSE
    v_type := 'info';
    v_title := 'LC1 verification pending';
    v_message := 'Your LC1 chairperson' || COALESCE(' (' || v_name || ')', '') || ' verification is under review. ' || v_reason;
  END IF;

  INSERT INTO public.notifications (user_id, title, message, type, metadata)
  SELECT p.id, v_title, v_message, v_type,
    jsonb_build_object('kind', 'lc1_verification', 'lc1_id', p_lc1_id, 'status', p_status, 'reason', v_reason)
  FROM public.profiles p
  WHERE p.borrower_lc1_id = p_lc1_id;
END;
$$;