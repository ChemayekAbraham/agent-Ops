
-- Parent-agent warning + 3-strike UGX 6,000 charge when a sub-agent's
-- house listing is rejected. Merchant (cashout) parents are excluded.
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
  v_reason text := trim(p_reason);
  v_sub_name text;
  v_parent_id uuid;
  v_parent_is_merchant boolean := false;
  v_sub_rejection_count integer := 0;
  v_parent_charged boolean := false;
  v_parent_charge_amount integer := 0;
  v_listing_title text;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF NOT public.is_landlord_ops(v_caller) THEN
    RAISE EXCEPTION 'Not authorized to reject listings';
  END IF;

  IF p_reason IS NULL OR length(v_reason) < 10 THEN
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

  v_listing_title := COALESCE(v_listing.title, 'Untitled');

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
    jsonb_build_object('listing_title', v_listing.title, 'reason', v_reason, 'rejected_by_name', v_caller_name)
  );

  IF v_listing.agent_id IS NOT NULL THEN
    -- Notify listing agent
    INSERT INTO public.notifications (user_id, title, message, type, metadata)
    VALUES (
      v_listing.agent_id,
      '🚫 Listing Rejected',
      'Your listing "' || v_listing_title ||
        '" was rejected by ' || COALESCE(v_caller_name, 'Landlord Ops') ||
        '. Reason: ' || v_reason ||
        '. A UGX 2,000 charge was applied to your wallet for this rejection.',
      'warning',
      jsonb_build_object(
        'listing_id', v_listing.id, 'listing_title', v_listing.title, 'reason', v_reason,
        'rejected_by', v_caller, 'rejected_by_name', v_caller_name, 'action', 'listing_rejected',
        'charge', 2000
      )
    );

    -- UGX 2,000 rejection charge (idempotent per listing)
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
            'description', 'Listing rejection charge — ' || v_listing_title,
            'currency', 'UGX'
          ),
          jsonb_build_object(
            'amount', 2000,
            'direction', 'cash_in',
            'category', 'listing_rejection_recovery',
            'ledger_scope', 'platform',
            'source_table', 'house_listings',
            'source_id', p_listing_id::text,
            'description', 'Recovery: listing rejection charge — ' || v_listing_title,
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

    -- Log rejection for record-keeping / strike counting
    INSERT INTO public.agent_listing_rejections (agent_id, listing_id, reason, rejected_by)
    VALUES (v_listing.agent_id, p_listing_id, v_reason, v_caller);

    -- ─── Parent-agent warning + every-3rd-strike UGX 6,000 charge ───
    SELECT parent_agent_id
      INTO v_parent_id
      FROM public.agent_subagents
     WHERE sub_agent_id = v_listing.agent_id
       AND status = 'verified'
     ORDER BY created_at ASC
     LIMIT 1;

    IF v_parent_id IS NOT NULL AND v_parent_id <> v_listing.agent_id THEN
      -- Exclude merchant (cash-out) parents entirely.
      SELECT EXISTS (
        SELECT 1 FROM public.cashout_agents
         WHERE agent_id = v_parent_id AND is_active = true
      ) INTO v_parent_is_merchant;

      IF NOT v_parent_is_merchant THEN
        SELECT COALESCE(full_name, 'your sub-agent')
          INTO v_sub_name
          FROM public.profiles
         WHERE id = v_listing.agent_id;

        SELECT COUNT(*)
          INTO v_sub_rejection_count
          FROM public.agent_listing_rejections
         WHERE agent_id = v_listing.agent_id;

        -- Every 3rd rejection triggers the UGX 6,000 charge on the parent.
        IF v_sub_rejection_count > 0 AND (v_sub_rejection_count % 3) = 0 THEN
          BEGIN
            PERFORM public.create_ledger_transaction(
              jsonb_build_array(
                jsonb_build_object(
                  'user_id', v_parent_id,
                  'amount', 6000,
                  'direction', 'cash_out',
                  'category', 'listing_rejection_penalty',
                  'ledger_scope', 'wallet',
                  'wallet_bucket', 'withdrawable',
                  'source_table', 'house_listings',
                  'source_id', p_listing_id::text,
                  'description', 'Parent-agent penalty: sub-agent ' || v_sub_name || ' had 3 listings rejected',
                  'currency', 'UGX'
                ),
                jsonb_build_object(
                  'amount', 6000,
                  'direction', 'cash_in',
                  'category', 'listing_rejection_recovery',
                  'ledger_scope', 'platform',
                  'source_table', 'house_listings',
                  'source_id', p_listing_id::text,
                  'description', 'Recovery: parent-agent 3-strike penalty — ' || v_sub_name,
                  'currency', 'UGX'
                )
              ),
              'parent_subagent_rejection_charge:' || p_listing_id::text,
              true
            );
            v_parent_charged := true;
            v_parent_charge_amount := 6000;
          EXCEPTION WHEN OTHERS THEN
            v_parent_charged := false;
          END;
        END IF;

        -- In-app warning to parent (always)
        INSERT INTO public.notifications (user_id, title, message, type, metadata)
        VALUES (
          v_parent_id,
          '⚠️ Sub-agent listing rejected',
          'Your sub-agent ' || v_sub_name || '''s house "' || v_listing_title ||
            '" was rejected. Reason: ' || v_reason || '. ' ||
            CASE WHEN v_parent_charged
              THEN 'A UGX 6,000 penalty was charged to your wallet (3 of their listings have been rejected).'
              ELSE 'You will be deducted UGX 6,000 if a 3rd of their listings is rejected. Current strikes: ' ||
                   v_sub_rejection_count::text || '/3.'
            END,
          'warning',
          jsonb_build_object(
            'action', 'subagent_listing_rejected',
            'sub_agent_id', v_listing.agent_id,
            'sub_agent_name', v_sub_name,
            'listing_id', v_listing.id,
            'listing_title', v_listing_title,
            'reason', v_reason,
            'rejection_count', v_sub_rejection_count,
            'parent_charged', v_parent_charged,
            'parent_charge_amount', v_parent_charge_amount
          )
        );
      END IF;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'listing_id', v_listing.id,
    'agent_notified', v_listing.agent_id IS NOT NULL,
    'charged', v_charged,
    'charge_amount', CASE WHEN v_charged THEN 2000 ELSE 0 END,
    'auto_blocked', false,
    'parent_agent_id', v_parent_id,
    'parent_is_merchant', v_parent_is_merchant,
    'sub_agent_name', v_sub_name,
    'sub_rejection_count', v_sub_rejection_count,
    'parent_charged', v_parent_charged,
    'parent_charge_amount', v_parent_charge_amount,
    'reason', v_reason,
    'listing_title', v_listing_title
  );
END;
$function$;
