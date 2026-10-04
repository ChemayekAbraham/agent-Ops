-- Recreate reject_house_listing WITHOUT the 3-strike auto-block.
-- Keeps the UGX 2,000 rejection charge and the agent notification.
CREATE OR REPLACE FUNCTION public.reject_house_listing(p_listing_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_listing record;
  v_caller_name text;
  v_charged boolean := false;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF NOT public.is_landlord_ops(v_caller) THEN
    RAISE EXCEPTION 'Not authorized to reject listings';
  END IF;

  IF p_reason IS NULL OR length(trim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'Rejection reason must be at least 10 characters';
  END IF;

  SELECT id, title, agent_id, status
    INTO v_listing
    FROM public.house_listings
   WHERE id = p_listing_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Listing not found';
  END IF;

  IF v_listing.status = 'rejected' THEN
    RETURN jsonb_build_object('ok', true, 'already_rejected', true);
  END IF;

  UPDATE public.house_listings
     SET status = 'rejected'
   WHERE id = p_listing_id;

  SELECT COALESCE(full_name, 'Landlord Ops')
    INTO v_caller_name
    FROM public.profiles
   WHERE id = v_caller;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  VALUES (
    v_caller, 'listing_rejected', 'house_listings', p_listing_id::text,
    jsonb_build_object('listing_title', v_listing.title, 'reason', trim(p_reason), 'rejected_by_name', v_caller_name)
  );

  IF v_listing.agent_id IS NOT NULL THEN
    -- Notify agent of rejection
    INSERT INTO public.notifications (user_id, title, message, type, metadata)
    VALUES (
      v_listing.agent_id,
      '🚫 Listing Rejected',
      'Your listing "' || COALESCE(v_listing.title, 'Untitled') ||
        '" was rejected by ' || COALESCE(v_caller_name, 'Landlord Ops') ||
        '. Reason: ' || trim(p_reason) ||
        '. A UGX 2,000 charge was applied to your wallet for this rejection.',
      'warning',
      jsonb_build_object(
        'listing_id', v_listing.id, 'listing_title', v_listing.title, 'reason', trim(p_reason),
        'rejected_by', v_caller, 'rejected_by_name', v_caller_name, 'action', 'listing_rejected',
        'charge', 2000
      )
    );

    -- ─── UGX 2,000 rejection charge (idempotent per listing) ───
    BEGIN
      PERFORM public.create_ledger_transaction(
        jsonb_build_array(
          jsonb_build_object(
            'user_id', v_listing.agent_id,
            'amount', 2000,
            'direction', 'cash_out',
            'category', 'listing_rejection_penalty',
            'ledger_scope', 'wallet',
            'wallet_bucket', 'withdrawable',
            'source_table', 'house_listings',
            'source_id', p_listing_id::text,
            'description', 'Listing rejection charge — ' || COALESCE(v_listing.title, 'house'),
            'currency', 'UGX'
          ),
          jsonb_build_object(
            'amount', 2000,
            'direction', 'cash_in',
            'category', 'listing_rejection_recovery',
            'ledger_scope', 'platform',
            'source_table', 'house_listings',
            'source_id', p_listing_id::text,
            'description', 'Recovery: listing rejection charge — ' || COALESCE(v_listing.title, 'house'),
            'currency', 'UGX'
          )
        ),
        'listing_rejection_charge:' || p_listing_id::text,
        true
      );
      v_charged := true;
    EXCEPTION WHEN OTHERS THEN
      v_charged := false;
    END;

    -- Keep logging the rejection for record-keeping (no longer triggers a block)
    INSERT INTO public.agent_listing_rejections (agent_id, listing_id, reason, rejected_by)
    VALUES (v_listing.agent_id, p_listing_id, trim(p_reason), v_caller);
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'listing_id', v_listing.id,
    'agent_notified', v_listing.agent_id IS NOT NULL,
    'charged', v_charged,
    'charge_amount', CASE WHEN v_charged THEN 2000 ELSE 0 END,
    'auto_blocked', false
  );
END;
$function$;

-- Clear any existing active auto-blocks so previously blocked agents can post again.
UPDATE public.agent_listing_blocks
   SET active = false
 WHERE active = true
   AND auto_blocked = true;