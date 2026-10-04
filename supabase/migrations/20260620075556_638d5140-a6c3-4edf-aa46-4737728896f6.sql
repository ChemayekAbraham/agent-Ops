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
  v_last_block_at timestamptz;
  v_rej_count integer;
  v_until timestamptz;
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

    -- ─── UGX 2,000 rejection charge: debit the agent's wallet (withdrawable)
    -- and recover it to the platform. Idempotent per listing so it can never be
    -- double-charged. skip_balance_check = true: the charge always posts even if
    -- it overdraws (the strict withdrawable rule floors the display at 0). ───
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
      -- Never let a charge failure block the rejection itself.
      v_charged := false;
    END;

    -- Log the rejection for the 3-strike counter
    INSERT INTO public.agent_listing_rejections (agent_id, listing_id, reason, rejected_by)
    VALUES (v_listing.agent_id, p_listing_id, trim(p_reason), v_caller);

    -- Count rejections since the agent's most recent block (resets each block)
    SELECT created_at INTO v_last_block_at
    FROM public.agent_listing_blocks
    WHERE agent_id = v_listing.agent_id
    ORDER BY created_at DESC
    LIMIT 1;

    SELECT count(*) INTO v_rej_count
    FROM public.agent_listing_rejections
    WHERE agent_id = v_listing.agent_id
      AND rejected_at > COALESCE(v_last_block_at, '-infinity'::timestamptz);

    -- Auto-block on the 3rd rejection if not already actively blocked
    IF v_rej_count >= 3 AND NOT EXISTS (
        SELECT 1 FROM public.agent_listing_blocks
        WHERE agent_id = v_listing.agent_id AND active AND blocked_until > now()
    ) THEN
      v_until := now() + interval '2 days';
      INSERT INTO public.agent_listing_blocks (agent_id, blocked_until, reason, auto_blocked, rejection_count)
      VALUES (
        v_listing.agent_id, v_until,
        'You have been blocked from posting houses for 2 days because 3 of your listings were rejected. Most recent reason: ' || trim(p_reason),
        true, v_rej_count
      );

      INSERT INTO public.notifications (user_id, title, message, type, metadata)
      VALUES (
        v_listing.agent_id,
        '🚫 House posting blocked (3 rejections)',
        'You have been blocked from posting houses until ' || to_char(v_until, 'Mon DD, YYYY HH24:MI') ||
          ' because 3 of your listings were rejected. Most recent reason: ' || trim(p_reason),
        'warning',
        jsonb_build_object('action', 'listing_block', 'blocked_until', v_until, 'auto_blocked', true)
      );
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'listing_id', v_listing.id,
    'agent_notified', v_listing.agent_id IS NOT NULL,
    'charged', v_charged,
    'charge_amount', CASE WHEN v_charged THEN 2000 ELSE 0 END,
    'rejection_count', v_rej_count,
    'auto_blocked', (v_until IS NOT NULL)
  );
END;
$function$;