CREATE OR REPLACE FUNCTION public.enforce_rent_request_landlord_agreement()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- The agreement is compulsory only when the authenticated agent creating the
  -- row is the same agent recorded on a brand-new non-renewal request. Tenant
  -- submissions, service-side inserts, and renewal requests remain optional.
  IF NEW.landlord_id IS NULL
     OR NEW.registration_type = 'renewal'
     OR auth.uid() IS DISTINCT FROM NEW.agent_id THEN
    RETURN NEW;
  END IF;

  IF NOT public.landlord_has_current_agreement(NEW.landlord_id) THEN
    RAISE EXCEPTION 'LANDLORD_AGREEMENT_REQUIRED'
      USING ERRCODE = '23514',
            DETAIL = 'A current signed 12-month landlord agreement is required before posting a new rent request as an agent.';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_landlord_verified_on_pipeline_approval()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Agreement evidence is visible in the pipeline but is not a prerequisite
  -- for landlord verification or for an existing request to move forward.
  IF NEW.landlord_ops_reviewed_at IS NOT NULL AND NEW.landlord_id IS NOT NULL THEN
    PERFORM set_config('landlord_verification.sync_authorized', 'true', true);
    UPDATE public.landlords
       SET verification_status = 'verified',
           verification_source = COALESCE(verification_source, 'pipeline_auto'),
           verification_reason = COALESCE(verification_reason, 'Auto-verified after landlord pipeline review'),
           verified_at = COALESCE(verified_at, NEW.landlord_ops_reviewed_at),
           verified_by = COALESCE(verified_by, NEW.landlord_ops_reviewed_by)
     WHERE id = NEW.landlord_id
       AND COALESCE(verification_status, 'pending') = 'pending';
    PERFORM set_config('landlord_verification.sync_authorized', 'false', true);
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_landlord_verification(
  p_landlord_id uuid,
  p_status text,
  p_reason text,
  p_source text DEFAULT 'ops_manual'
)
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
  IF p_status NOT IN ('pending','verified','rejected','resubmitted') THEN RAISE EXCEPTION 'Invalid status'; END IF;
  IF v_reason IS NULL OR length(v_reason) < 10 THEN RAISE EXCEPTION 'A reason of at least 10 characters is required'; END IF;

  PERFORM set_config('landlord_verification.sync_authorized', 'true', true);
  UPDATE public.landlords
  SET verification_status = p_status,
      verification_reason = v_reason,
      verification_source = COALESCE(NULLIF(btrim(p_source), ''), 'ops_manual'),
      verified = (p_status = 'verified'),
      verified_at = CASE WHEN p_status = 'verified' THEN now() ELSE verified_at END,
      verified_by = CASE WHEN p_status = 'verified' THEN v_actor ELSE verified_by END
  WHERE id = p_landlord_id
  RETURNING name, registered_by INTO v_name, v_registered_by;
  IF NOT FOUND THEN RAISE EXCEPTION 'Landlord not found'; END IF;
  PERFORM set_config('landlord_verification.sync_authorized', 'false', true);

  UPDATE public.landlord_verification_requests
  SET status = CASE WHEN p_status IN ('verified','rejected') THEN p_status ELSE 'pending' END,
      reject_comment = CASE WHEN p_status = 'rejected' THEN v_reason ELSE reject_comment END,
      resolved_by = v_actor,
      resolved_at = now()
  WHERE landlord_id = p_landlord_id AND status = 'pending';

  INSERT INTO public.audit_logs(user_id, action_type, table_name, record_id, metadata)
  VALUES (v_actor, 'landlord_verification_status_set', 'landlords', p_landlord_id,
    jsonb_build_object('status', p_status, 'reason', v_reason, 'source', p_source,
      'agreement_required', false));

  IF p_status = 'verified' THEN
    v_type := 'success'; v_title := 'Landlord verified';
    v_message := 'Your landlord' || COALESCE(' (' || v_name || ')', '') || ' has been verified.';
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
        'landlord_rejection_charge:' || p_landlord_id::text, true);
      v_agent_charged := true;
    EXCEPTION WHEN OTHERS THEN v_agent_charged := false;
    END;
    INSERT INTO public.notifications (user_id, title, message, type, metadata)
    VALUES (v_registered_by, 'Landlord Rejected',
      'The landlord "' || COALESCE(v_name, 'landlord') || '" you registered was rejected. Reason: ' || v_reason,
      'warning', jsonb_build_object('kind', 'landlord_rejection_penalty', 'landlord_id', p_landlord_id,
        'reason', v_reason, 'charge', CASE WHEN v_agent_charged THEN v_charge_amount ELSE 0 END));
  END IF;

  RETURN jsonb_build_object('ok', true, 'landlord_id', p_landlord_id, 'status', p_status,
    'source', COALESCE(NULLIF(btrim(p_source), ''), 'ops_manual'), 'agent_id', v_registered_by,
    'agent_charged', v_agent_charged, 'charge_amount', CASE WHEN v_agent_charged THEN v_charge_amount ELSE 0 END);
END;
$$;

GRANT EXECUTE ON FUNCTION public.set_landlord_verification(uuid, text, text, text) TO authenticated;