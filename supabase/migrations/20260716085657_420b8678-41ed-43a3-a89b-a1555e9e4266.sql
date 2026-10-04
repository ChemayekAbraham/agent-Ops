DROP FUNCTION IF EXISTS public.set_landlord_verification(uuid, text, text);
DROP FUNCTION IF EXISTS public.set_lc1_verification(uuid, text, text);

CREATE OR REPLACE FUNCTION public.set_landlord_verification(p_landlord_id uuid, p_status text, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_name text;
  v_registered_by uuid;
  v_reason text := btrim(p_reason);
  v_title text;
  v_message text;
  v_type text;
  v_charge_amount integer := 2000;
  v_agent_charged boolean := false;
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
  RETURNING name, registered_by INTO v_name, v_registered_by;
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

  IF p_status = 'verified' THEN
    v_type := 'success'; v_title := 'Landlord verified';
    v_message := 'Your landlord' || COALESCE(' (' || v_name || ')', '') || ' GPS location has been verified. You can now request a loan.';
  ELSIF p_status = 'rejected' THEN
    v_type := 'error'; v_title := 'Landlord verification rejected';
    v_message := 'Your landlord' || COALESCE(' (' || v_name || ')', '') || ' verification was rejected. Reason: ' || v_reason;
  ELSE
    v_type := 'info'; v_title := 'Landlord verification pending';
    v_message := 'Your landlord' || COALESCE(' (' || v_name || ')', '') || ' verification is under review. ' || v_reason;
  END IF;

  INSERT INTO public.notifications (user_id, title, message, type, metadata)
  SELECT p.id, v_title, v_message, v_type,
    jsonb_build_object('kind', 'landlord_verification', 'landlord_id', p_landlord_id, 'status', p_status, 'reason', v_reason)
  FROM public.profiles p
  WHERE p.borrower_landlord_id = p_landlord_id;

  IF p_status = 'rejected' AND v_registered_by IS NOT NULL THEN
    BEGIN
      PERFORM public.create_ledger_transaction(
        jsonb_build_array(
          jsonb_build_object('user_id', v_registered_by, 'amount', v_charge_amount, 'direction', 'cash_out',
            'category', 'listing_rejection_penalty', 'ledger_scope', 'wallet', 'wallet_bucket', 'withdrawable',
            'source_table', 'landlords', 'source_id', p_landlord_id::text,
            'description', 'Landlord rejection charge — ' || COALESCE(v_name, 'landlord'), 'currency', 'UGX'),
          jsonb_build_object('amount', v_charge_amount, 'direction', 'cash_in',
            'category', 'listing_rejection_recovery', 'ledger_scope', 'platform',
            'source_table', 'landlords', 'source_id', p_landlord_id::text,
            'description', 'Recovery: landlord rejection charge — ' || COALESCE(v_name, 'landlord'), 'currency', 'UGX')
        ),
        'landlord_rejection_charge:' || p_landlord_id::text,
        true
      );
      v_agent_charged := true;
    EXCEPTION WHEN OTHERS THEN v_agent_charged := false;
    END;

    INSERT INTO public.notifications (user_id, title, message, type, metadata)
    VALUES (v_registered_by, '🚫 Landlord Rejected',
      'The landlord "' || COALESCE(v_name, 'landlord') || '" you registered was rejected. Reason: ' || v_reason ||
        CASE WHEN v_agent_charged THEN '. A UGX ' || v_charge_amount || ' charge was applied to your wallet.' ELSE '' END,
      'warning',
      jsonb_build_object('kind', 'landlord_rejection_penalty', 'landlord_id', p_landlord_id, 'landlord_name', v_name,
        'reason', v_reason, 'charge', CASE WHEN v_agent_charged THEN v_charge_amount ELSE 0 END, 'action', 'landlord_rejected'));
  END IF;

  RETURN jsonb_build_object('ok', true, 'landlord_id', p_landlord_id, 'status', p_status,
    'agent_id', v_registered_by, 'agent_charged', v_agent_charged,
    'charge_amount', CASE WHEN v_agent_charged THEN v_charge_amount ELSE 0 END);
END;
$$;

CREATE OR REPLACE FUNCTION public.set_lc1_verification(p_lc1_id uuid, p_status text, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_name text;
  v_registered_by uuid;
  v_reason text := btrim(p_reason);
  v_title text;
  v_message text;
  v_type text;
  v_charge_amount integer := 2000;
  v_agent_charged boolean := false;
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
  RETURNING name, registered_by INTO v_name, v_registered_by;
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

  IF p_status = 'verified' THEN
    v_type := 'success'; v_title := 'LC1 chairperson verified';
    v_message := 'Your LC1 chairperson' || COALESCE(' (' || v_name || ')', '') || ' has been verified. You can now request a loan.';
  ELSIF p_status = 'rejected' THEN
    v_type := 'error'; v_title := 'LC1 verification rejected';
    v_message := 'Your LC1 chairperson' || COALESCE(' (' || v_name || ')', '') || ' verification was rejected. Reason: ' || v_reason;
  ELSE
    v_type := 'info'; v_title := 'LC1 verification pending';
    v_message := 'Your LC1 chairperson' || COALESCE(' (' || v_name || ')', '') || ' verification is under review. ' || v_reason;
  END IF;

  INSERT INTO public.notifications (user_id, title, message, type, metadata)
  SELECT p.id, v_title, v_message, v_type,
    jsonb_build_object('kind', 'lc1_verification', 'lc1_id', p_lc1_id, 'status', p_status, 'reason', v_reason)
  FROM public.profiles p
  WHERE p.borrower_lc1_id = p_lc1_id;

  IF p_status = 'rejected' AND v_registered_by IS NOT NULL THEN
    BEGIN
      PERFORM public.create_ledger_transaction(
        jsonb_build_array(
          jsonb_build_object('user_id', v_registered_by, 'amount', v_charge_amount, 'direction', 'cash_out',
            'category', 'listing_rejection_penalty', 'ledger_scope', 'wallet', 'wallet_bucket', 'withdrawable',
            'source_table', 'lc1_chairpersons', 'source_id', p_lc1_id::text,
            'description', 'LC1 chairperson rejection charge — ' || COALESCE(v_name, 'LC1'), 'currency', 'UGX'),
          jsonb_build_object('amount', v_charge_amount, 'direction', 'cash_in',
            'category', 'listing_rejection_recovery', 'ledger_scope', 'platform',
            'source_table', 'lc1_chairpersons', 'source_id', p_lc1_id::text,
            'description', 'Recovery: LC1 chairperson rejection charge — ' || COALESCE(v_name, 'LC1'), 'currency', 'UGX')
        ),
        'lc1_rejection_charge:' || p_lc1_id::text,
        true
      );
      v_agent_charged := true;
    EXCEPTION WHEN OTHERS THEN v_agent_charged := false;
    END;

    INSERT INTO public.notifications (user_id, title, message, type, metadata)
    VALUES (v_registered_by, '🚫 LC1 Chairperson Rejected',
      'The LC1 chairperson "' || COALESCE(v_name, 'chairperson') || '" you registered was rejected. Reason: ' || v_reason ||
        CASE WHEN v_agent_charged THEN '. A UGX ' || v_charge_amount || ' charge was applied to your wallet.' ELSE '' END,
      'warning',
      jsonb_build_object('kind', 'lc1_rejection_penalty', 'lc1_id', p_lc1_id, 'lc1_name', v_name,
        'reason', v_reason, 'charge', CASE WHEN v_agent_charged THEN v_charge_amount ELSE 0 END, 'action', 'lc1_rejected'));
  END IF;

  RETURN jsonb_build_object('ok', true, 'lc1_id', p_lc1_id, 'status', p_status,
    'agent_id', v_registered_by, 'agent_charged', v_agent_charged,
    'charge_amount', CASE WHEN v_agent_charged THEN v_charge_amount ELSE 0 END);
END;
$$;

GRANT EXECUTE ON FUNCTION public.set_landlord_verification(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_lc1_verification(uuid, text, text) TO authenticated;