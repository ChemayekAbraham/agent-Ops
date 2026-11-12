CREATE OR REPLACE FUNCTION public.co_support_accept(p_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_peek record;
  v public.co_support_invites%ROWTYPE;
  v_lead_avail numeric;
  v_avail numeric;
  v_problem text;
  v_claimed integer;
  v_lead jsonb;
  v_mine jsonb;
  v_is_house boolean;
BEGIN
  SELECT id, COALESCE(rent_request_id, house_id) AS target, lead_partner_id, house_id IS NOT NULL AS is_house
    INTO v_peek
    FROM public.co_support_invites WHERE code = upper(btrim(COALESCE(p_code, '')));
  IF NOT FOUND THEN
    IF v_uid IS NULL THEN
      RAISE EXCEPTION 'AUTH_REQUIRED' USING ERRCODE = '42501';
    END IF;
    RAISE EXCEPTION 'INVITE_NOT_FOUND: This link is not valid. Ask your partner to share it again.'
      USING ERRCODE = 'check_violation';
  END IF;
  v_is_house := v_peek.is_house;

  IF v_is_house THEN
    PERFORM public._co_support_require_partner_house(v_uid);
  ELSE
    PERFORM public._co_support_require_partner(v_uid);
  END IF;

  PERFORM public._co_support_lock(v_peek.target, v_peek.lead_partner_id, v_uid);
  SELECT * INTO v FROM public.co_support_invites WHERE id = v_peek.id FOR UPDATE;

  IF v.status = 'completed' AND v.invitee_id = v_uid THEN
    RETURN public._co_support_invite_json(v.id, v_uid)
        || jsonb_build_object('ok', true, 'idempotent_replay', true, 'landlord_float_released', NOT v_is_house);
  END IF;
  IF v.lead_partner_id = v_uid THEN
    RAISE EXCEPTION 'OWN_INVITE: You shared this. Send the link to the partner who will support it with you.'
      USING ERRCODE = 'check_violation';
  END IF;
  IF v.status <> 'open' THEN
    RAISE EXCEPTION 'INVITE_CLOSED: This invitation is no longer open.' USING ERRCODE = 'check_violation';
  END IF;
  IF v.expires_at <= now() THEN
    RAISE EXCEPTION 'INVITE_EXPIRED: This invitation has expired. Ask your partner to send a new one.'
      USING ERRCODE = 'check_violation';
  END IF;
  IF v.declined_at IS NOT NULL THEN
    RAISE EXCEPTION 'INVITE_DECLINED: This invitation was declined. Ask your partner to send a new one.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- The lead must still be a partner with a signed agreement.
  IF NOT public.psm_is_partner(v.lead_partner_id) OR NOT public.funder_has_signed_agreement(v.lead_partner_id) THEN
    RAISE EXCEPTION 'LEAD_NOT_ELIGIBLE: The partner who shared this cannot fund it right now. Ask them to check their account.'
      USING ERRCODE = 'check_violation';
  END IF;

  PERFORM public.partner_rate_now(v_uid);
  v_avail := public.funder_float_available(v_uid);
  IF v_avail < v.invitee_share THEN
    RAISE EXCEPTION 'PARTNER_FUNDS_SHORT: Your half is UGX %. You have UGX % of operational float. Add float to your wallet, then accept.',
      public._co_support_fmt(v.invitee_share), public._co_support_fmt(v_avail)
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT v_is_house THEN
    PERFORM public.psm_assert_no_foreign_booking(v_uid, ARRAY[v.rent_request_id]);
    PERFORM public.psm_assert_no_foreign_booking(v.lead_partner_id, ARRAY[v.rent_request_id]);
  END IF;

  -- Close the invite first: this ends the lead's hold, so their half can be used here.
  UPDATE public.co_support_invites
     SET status = 'completed', invitee_id = v_uid, accepted_at = now(),
         closed_at = now(), close_reason = 'accepted', updated_at = now()
   WHERE id = v.id;

  v_lead_avail := public.funder_float_available(v.lead_partner_id);
  IF v_lead_avail < v.lead_share THEN
    RAISE EXCEPTION 'LEAD_FUNDS_SHORT: Your partner no longer has their half in their wallet. Ask them to add float, then try again.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_is_house THEN
    v_problem := public._co_support_house_problem(v.house_id);
    IF v_problem IS NULL AND (SELECT hl.monthly_rent::numeric FROM public.house_listings hl WHERE hl.id = v.house_id)
                             IS DISTINCT FROM v.rent_amount THEN
      v_problem := 'plan_changed';
    END IF;
  ELSE
    v_problem := public._co_support_plan_problem(v.lead_partner_id, v.rent_request_id);
    -- The halves were agreed on this rent. If the rent changed since, nobody pays.
    IF v_problem IS NULL AND (SELECT rr.rent_amount FROM public.rent_requests rr WHERE rr.id = v.rent_request_id)
                             IS DISTINCT FROM v.rent_amount THEN
      v_problem := 'plan_changed';
    END IF;
    IF v_problem IS NULL THEN
      INSERT INTO public.partner_self_plan_claims (
        rent_request_id, partner_id, amount, status, idempotency_key, expires_at, confirmed_at
      ) VALUES (
        v.rent_request_id, v.lead_partner_id, v.rent_amount, 'confirmed', 'cosup-' || v.id::text, now(), now()
      )
      ON CONFLICT (rent_request_id) WHERE status IN ('held','confirmed') DO NOTHING;
      GET DIAGNOSTICS v_claimed = ROW_COUNT;
      IF v_claimed = 0 THEN
        v_problem := 'plan_held';
      END IF;
    END IF;
  END IF;

  IF v_problem IS NOT NULL THEN
    -- It went elsewhere (or its rent changed). Close the invite; no money moves.
    UPDATE public.co_support_invites
       SET status = 'plan_unavailable', invitee_id = NULL, accepted_at = NULL,
           close_reason = v_problem, updated_at = now()
     WHERE id = v.id;
    PERFORM public.psm_audit(v_uid, v.lead_partner_id, 'co_support_plan_unavailable',
      'co_support_invites', v.id, jsonb_build_object('reason', v_problem, 'invitee', v_uid));
    RETURN jsonb_build_object('ok', false, 'status', 'plan_unavailable', 'reason', v_problem,
      'message', CASE WHEN v_problem = 'plan_changed'
                      THEN 'The rent changed after this was shared. Nothing was taken from your wallet. Ask your partner to share it again.'
                      WHEN v_is_house
                      THEN 'This house was taken before you accepted. Nothing was taken from your wallet.'
                      ELSE 'This Rent Plan was taken before you accepted. Nothing was taken from your wallet.' END);
  END IF;

  IF v_is_house THEN
    v_lead := public._co_support_open_house_half(v.id, v.lead_partner_id, v.lead_rent, v.lead_share, 'lead');
    v_mine := public._co_support_open_house_half(v.id, v_uid, v.invitee_rent, v.invitee_share, 'invitee');
  ELSE
    v_lead := public._co_support_open_half(v.id, v.lead_partner_id, v.lead_rent, v.lead_share, 'lead');
    v_mine := public._co_support_open_half(v.id, v_uid, v.invitee_rent, v.invitee_share, 'invitee');

    UPDATE public.partner_self_plan_claims
       SET commitment_id = (v_lead->>'commitment_id')::uuid, updated_at = now()
     WHERE idempotency_key = 'cosup-' || v.id::text
       AND partner_id = v.lead_partner_id
       AND rent_request_id = v.rent_request_id;

    UPDATE public.rent_requests
       SET self_funding_partner_id = v.lead_partner_id,
           self_funding_line_id = (v_lead->>'line_id')::uuid,
           updated_at = now()
     WHERE id = v.rent_request_id;
  END IF;

  UPDATE public.co_support_invites
     SET lead_commitment_id = (v_lead->>'commitment_id')::uuid,
         invitee_commitment_id = (v_mine->>'commitment_id')::uuid,
         lead_portfolio_id = (v_lead->>'portfolio_id')::uuid,
         invitee_portfolio_id = (v_mine->>'portfolio_id')::uuid,
         updated_at = now()
   WHERE id = v.id;

  IF v_is_house THEN
    -- Partner Ops approves the pair (approve_pending_portfolio); nothing is debited yet.
    BEGIN
      INSERT INTO public.system_events(event_type, user_id, related_entity_type, related_entity_id, description, metadata)
      VALUES ('portfolio_topup', v_uid, 'co_support_invites', v.id,
              'Two partners co-supported a verified empty house: waiting for Partner Ops',
              jsonb_build_object('house_id', v.house_id, 'amount', v.gross_amount,
                                 'lead_partner_id', v.lead_partner_id, 'invitee_id', v_uid,
                                 'lead_portfolio_id', v_lead->>'portfolio_id',
                                 'invitee_portfolio_id', v_mine->>'portfolio_id',
                                 'source', 'self_managed_house'));
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    PERFORM public.psm_audit(v_uid, v_uid, 'co_support_accepted', 'co_support_invites', v.id,
      jsonb_build_object('lead_partner_id', v.lead_partner_id, 'share', v.invitee_share,
                         'portfolio_id', v_mine->>'portfolio_id', 'house_id', v.house_id,
                         'status', 'pending_ops_approval'));
    RETURN public._co_support_invite_json(v.id, v_uid)
        || jsonb_build_object('ok', true, 'awaiting_partner_ops', true, 'landlord_float_released', false,
                              'available_balance', public.funder_float_available(v_uid));
  END IF;

  -- Rent Plan: direct release, as in Phase 1.
  PERFORM set_config('app.funder_direct_release', 'on', true);
  PERFORM public._approve_pending_portfolio_core((v_lead->>'portfolio_id')::uuid, v.lead_partner_id);
  PERFORM public._approve_pending_portfolio_core((v_mine->>'portfolio_id')::uuid, v_uid);

  IF NOT EXISTS (
    SELECT 1 FROM public.agent_landlord_float_allocations a
     WHERE a.rent_request_id = v.rent_request_id
       AND a.source = 'partner_self_funding'
       AND a.status IN ('open', 'partially_paid')
       AND a.allocated_amount = v.rent_amount
  ) THEN
    RAISE EXCEPTION 'CO_SUPPORT_RELEASE_FAILED: The landlord float could not be released, so nothing was taken from either wallet. Please try again.'
      USING ERRCODE = 'check_violation';
  END IF;

  BEGIN
    INSERT INTO public.system_events(event_type, user_id, related_entity_type, related_entity_id, description, metadata)
    VALUES ('rent_request_created', v_uid, 'co_support_invites', v.id,
            'Two partners co-supported a Rent Plan: rent moved to the agent landlord float',
            jsonb_build_object('rent_request_id', v.rent_request_id, 'rent_amount', v.rent_amount,
                               'lead_partner_id', v.lead_partner_id, 'invitee_id', v_uid,
                               'lead_portfolio_id', v_lead->>'portfolio_id',
                               'invitee_portfolio_id', v_mine->>'portfolio_id',
                               'direct_release', true));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  PERFORM public.psm_audit(v_uid, v_uid, 'co_support_accepted', 'co_support_invites', v.id,
    jsonb_build_object('lead_partner_id', v.lead_partner_id, 'share', v.invitee_share,
                       'portfolio_id', v_mine->>'portfolio_id'));

  RETURN public._co_support_invite_json(v.id, v_uid)
      || jsonb_build_object('ok', true, 'landlord_float_released', true,
                            'available_balance', public.funder_float_available(v_uid));
END;
$function$
