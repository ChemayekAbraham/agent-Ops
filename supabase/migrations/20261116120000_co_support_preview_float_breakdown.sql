-- Co-support: the invitation preview explains the invitee's float.
--
-- A partner opened a link and was told "Add UGX 1,335,514 of float" although
-- they had UGX 551,486 of float. The amount was right (their half was
-- 1,530,000 and 357,000 of their float was held for a Rent Plan they were
-- sharing themselves), but the screen could not say so: the preview only
-- returned the free amount. It now also returns the parts, so the page can
-- say what the person has, what is set aside and why, and what is missing.
--
-- New fields for a signed-in invitee (nothing changes for anyone else):
--   float_balance               operational float in the wallet
--   float_held_for_your_shares  set aside for Rent Plans / houses this person is sharing
--   float_held_other            set aside for anything else waiting (pending portfolios)
--   your_open_shares            those shares: id, kind, title, amount held, expires_at
-- float_available / float_needed are unchanged.
-- Same body as Phase 4 otherwise (20261115100000_co_support_phase4_houses.sql).

SET client_encoding = 'UTF8';

CREATE OR REPLACE FUNCTION public.co_support_preview(p_code text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v public.co_support_invites%ROWTYPE;
  v_out jsonb;
  v_status text;
  v_is_partner boolean;
  v_signed boolean;
  v_float numeric;
  v_balance numeric;
  v_held_shares numeric;
  v_held_total numeric;
  v_shares jsonb;
  v_rate numeric;
  v_reason text;
  v_switch boolean;
BEGIN
  SELECT * INTO v FROM public.co_support_invites WHERE code = upper(btrim(COALESCE(p_code, '')));
  IF NOT FOUND THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  v_status := public._co_support_status(v.status, v.expires_at, v.declined_at);
  v_out := public._co_support_invite_json(v.id, v_uid)
        || jsonb_build_object('found', true,
                              'lead_first_name', public._co_support_first_name(v.lead_partner_id),
                              -- funder-onboarding records this person as the referrer
                              'referrer_id', v.lead_partner_id,
                              'signed_in', v_uid IS NOT NULL);

  IF v_uid IS NULL OR v_uid = v.lead_partner_id OR v_uid = v.invitee_id THEN
    RETURN v_out || jsonb_build_object('can_accept', false);
  END IF;

  v_switch := CASE WHEN v.house_id IS NOT NULL THEN public._pipeline_switch_on('funders_empty_houses')
                   ELSE public._pipeline_switch_on('funder_direct_release') END;
  v_is_partner := public.psm_is_partner(v_uid);
  v_signed := public.funder_has_signed_agreement(v_uid);
  v_float := public.funder_float_available(v_uid);
  BEGIN
    v_rate := public.partner_rate_now(v_uid);
  EXCEPTION WHEN OTHERS THEN
    v_rate := NULL;
  END;

  -- Where the viewer's float is (only their own figures).
  v_balance := GREATEST(COALESCE(public.get_user_float_available_balance(v_uid), 0), 0);
  v_held_total := GREATEST(COALESCE(public.funder_pending_hold(v_uid), 0), 0);
  SELECT COALESCE(sum(i.lead_share), 0),
         COALESCE(jsonb_agg(jsonb_build_object(
           'id', i.id,
           'kind', CASE WHEN i.house_id IS NOT NULL THEN 'house' ELSE 'rent_plan' END,
           'title', CASE WHEN i.house_id IS NOT NULL
                         THEN COALESCE(NULLIF(btrim(hl.title), ''), 'an empty house')
                         ELSE split_part(COALESCE(NULLIF(btrim(tp.full_name), ''), 'a tenant'), ' ', 1) || '''s Rent Plan' END,
           'held', i.lead_share,
           'expires_at', i.expires_at) ORDER BY i.created_at), '[]'::jsonb)
    INTO v_held_shares, v_shares
    FROM public.co_support_invites i
    LEFT JOIN public.house_listings hl ON hl.id = i.house_id
    LEFT JOIN public.rent_requests rr ON rr.id = i.rent_request_id
    LEFT JOIN public.profiles tp ON tp.id = rr.tenant_id
   WHERE i.lead_partner_id = v_uid AND i.status = 'open' AND i.expires_at > now();

  v_reason := CASE
    WHEN v_status <> 'open' THEN 'invite_' || v_status
    WHEN NOT v_switch THEN 'paused'
    WHEN NOT v_is_partner THEN 'not_a_partner'
    WHEN NOT v_signed THEN 'agreement_required'
    WHEN v_rate IS NULL THEN 'rate_unavailable'
    WHEN v_float < v.invitee_share THEN 'funds_short'
  END;

  RETURN v_out || jsonb_build_object(
    'can_accept', v_reason IS NULL,
    'reason', v_reason,
    'is_partner', v_is_partner,
    'agreement_signed', v_signed,
    'float_available', v_float,
    'float_needed', GREATEST(v.invitee_share - v_float, 0),
    'float_balance', v_balance,
    'float_held_for_your_shares', v_held_shares,
    'float_held_other', GREATEST(v_held_total - v_held_shares, 0),
    'your_open_shares', v_shares);
END;
$$;
