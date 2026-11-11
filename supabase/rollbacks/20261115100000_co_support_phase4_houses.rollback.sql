-- Rollback for 20261115100000_co_support_phase4_houses.sql.
-- Puts back the live bodies of the four changed objects and the Phase 1
-- versions of the co-support functions; removes everything house-specific.
-- Refuses while any house invitation or co-supported house row exists.
SET client_encoding = 'UTF8';
SET lock_timeout = '5s';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.co_support_invites WHERE house_id IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public.partner_supported_houses WHERE co_support_id IS NOT NULL) THEN
    RAISE EXCEPTION 'ROLLBACK_REFUSED: co-supported houses exist';
  END IF;
END $$;

-- 1. Live bodies
CREATE OR REPLACE FUNCTION public.house_has_live_claim(p_house_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    -- 1. A funder picked it through the promissory-note flow.
    SELECT 1 FROM public.promissory_note_house_intents i
     WHERE i.house_id = p_house_id AND i.status IN ('reserved','funded')
    UNION ALL
    -- 2. A partner is self-supporting it.
    SELECT 1 FROM public.partner_supported_houses psh
     WHERE psh.house_id = p_house_id AND psh.status IN ('pending','active')
    UNION ALL
    -- 3. A company-managed portfolio claimed it.
    SELECT 1 FROM public.portfolio_allocations a
     WHERE a.house_id = p_house_id AND a.status IN ('reserved','fulfilled')
  );
$function$;

CREATE OR REPLACE FUNCTION public.agent_list_empty_house_opportunities(p_search text DEFAULT NULL::text, p_limit integer DEFAULT 30, p_offset integer DEFAULT 0, p_district text DEFAULT NULL::text, p_verified_only boolean DEFAULT false, p_gps_only boolean DEFAULT false, p_min_rent numeric DEFAULT NULL::numeric, p_max_rent numeric DEFAULT NULL::numeric, p_near_lat double precision DEFAULT NULL::double precision, p_near_lng double precision DEFAULT NULL::double precision, p_radius_km double precision DEFAULT NULL::double precision, p_sort text DEFAULT NULL::text, p_quote_for text DEFAULT 'public'::text, p_partner_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 30), 1), 100);
  v_offset integer := GREATEST(COALESCE(p_offset, 0), 0);
  v_search text := NULLIF(btrim(COALESCE(p_search, '')), '');
  v_district text := NULLIF(btrim(COALESCE(p_district, '')), '');
  v_radius double precision := NULLIF(COALESCE(p_radius_km, 0), 0);
  v_sort text := lower(NULLIF(btrim(COALESCE(p_sort, '')), ''));
  v_dlat double precision;
  v_dlng double precision;
  v_total bigint := 0;
  v_rows jsonb := '[]'::jsonb;
  v_rate numeric := public.partner_quote_rate(p_quote_for, p_partner_id);
  v_districts jsonb := '[]'::jsonb;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501'; END IF;
  IF NOT (
    public.has_role(v_uid, 'agent') OR public.has_role(v_uid, 'senior_agent')
    OR public.has_role(v_uid, 'sub_agent') OR public.has_role(v_uid, 'supporter')
    OR public.is_ops_role(v_uid)
  ) THEN
    RAISE EXCEPTION 'Not authorised' USING ERRCODE = '42501';
  END IF;

  IF v_sort IS NULL OR v_sort NOT IN ('recommended', 'nearest', 'newest', 'rent_high', 'rent_low') THEN
    v_sort := 'recommended';
  END IF;

  IF v_sort = 'nearest' AND (p_near_lat IS NULL OR p_near_lng IS NULL) THEN
    v_sort := 'recommended';
  END IF;

  IF v_radius IS NOT NULL AND p_near_lat IS NOT NULL AND p_near_lng IS NOT NULL THEN
    v_dlat := v_radius / 111.0;
    v_dlng := v_radius / GREATEST(cos(radians(p_near_lat)) * 111.0, 0.000001);
  END IF;

  WITH base AS (
    SELECT
      h.id,
      h.verified,
      h.created_at,
      COALESCE(h.monthly_rent, 0) AS monthly_rent,
      CASE
        WHEN p_near_lat IS NULL OR p_near_lng IS NULL
          OR h.latitude IS NULL OR h.longitude IS NULL THEN NULL
        ELSE sqrt(
          pow((h.latitude - p_near_lat) * 111.0, 2)
          + pow((h.longitude - p_near_lng) * cos(radians(p_near_lat)) * 111.0, 2)
        )
      END AS distance_km
    FROM public.house_listings h
    LEFT JOIN public.landlords lp ON lp.id = h.landlord_id
    LEFT JOIN public.profiles ap ON ap.id = h.agent_id
    WHERE h.status = 'available'
      AND h.tenant_id IS NULL
      AND COALESCE(h.is_hidden, false) = false
      AND COALESCE(h.monthly_rent, 0) > 0
      AND NOT EXISTS (SELECT 1 FROM public.promissory_note_house_intents pni
                       WHERE pni.house_id = h.id AND pni.status IN ('reserved','funded'))
      AND NOT EXISTS (SELECT 1 FROM public.partner_supported_houses pshc
                       WHERE pshc.house_id = h.id AND pshc.status IN ('pending','active'))
      AND NOT EXISTS (SELECT 1 FROM public.portfolio_allocations pa
                       WHERE pa.house_id = h.id AND pa.status IN ('reserved','fulfilled'))
      AND (
        v_search IS NULL
        OR h.title ILIKE '%' || v_search || '%'
        OR h.district ILIKE '%' || v_search || '%'
        OR h.sub_county ILIKE '%' || v_search || '%'
        OR h.village ILIKE '%' || v_search || '%'
        OR h.region ILIKE '%' || v_search || '%'
        OR lp.name ILIKE '%' || v_search || '%'
        OR lp.phone ILIKE '%' || v_search || '%'
        OR ap.full_name ILIKE '%' || v_search || '%'
      )
      AND (v_district IS NULL OR h.district ILIKE v_district)
      AND (COALESCE(p_verified_only, false) = false OR COALESCE(h.verified, false) = true)
      AND (
        COALESCE(p_gps_only, false) = false
        OR (h.latitude IS NOT NULL AND h.longitude IS NOT NULL AND (h.latitude <> 0 OR h.longitude <> 0))
      )
      AND (p_min_rent IS NULL OR COALESCE(h.monthly_rent, 0) >= p_min_rent)
      AND (p_max_rent IS NULL OR COALESCE(h.monthly_rent, 0) <= p_max_rent)
      AND (
        v_dlat IS NULL
        OR (
          h.latitude IS NOT NULL AND h.longitude IS NOT NULL
          AND h.latitude BETWEEN p_near_lat - v_dlat AND p_near_lat + v_dlat
          AND h.longitude BETWEEN p_near_lng - v_dlng AND p_near_lng + v_dlng
        )
      )
  ),
  counted AS (SELECT COUNT(*) AS c FROM base),
  page AS (
    SELECT
      b.id,
      b.distance_km,
      row_number() OVER (
        ORDER BY
          CASE WHEN v_sort = 'nearest' THEN b.distance_km END ASC NULLS LAST,
          CASE WHEN v_sort = 'newest' THEN b.created_at END DESC NULLS LAST,
          CASE WHEN v_sort = 'rent_high' THEN b.monthly_rent END DESC NULLS LAST,
          CASE WHEN v_sort = 'rent_low' THEN b.monthly_rent END ASC NULLS LAST,
          CASE WHEN v_sort = 'recommended' THEN (CASE WHEN b.verified THEN 0 ELSE 1 END) END ASC NULLS LAST,
          b.created_at DESC
      ) AS rn
    FROM base b
    ORDER BY rn
    LIMIT v_limit OFFSET v_offset
  ),
  rows_json AS (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'house_id', h.id,
      'title', h.title,
      'house_category', h.house_category,
      'monthly_rent', COALESCE(h.monthly_rent, 0),
      'district', h.district,
      'sub_county', h.sub_county,
      'village', h.village,
      'region', h.region,
      'number_of_rooms', h.number_of_rooms,
      'verified', COALESCE(h.verified, false),
      'listing_agent_id', h.agent_id,
      'listing_agent_name', p.full_name,
      'image_url', CASE WHEN h.image_urls IS NOT NULL AND array_length(h.image_urls, 1) > 0 THEN h.image_urls[1] ELSE NULL END,
      'image_urls', COALESCE(to_jsonb(h.image_urls), '[]'::jsonb),
      'latitude', h.latitude,
      'longitude', h.longitude,
      'landlord_id', h.landlord_id,
      'landlord_name', lp.name,
      'landlord_phone', lp.phone,
      'distance_km', pg.distance_km,
      'partner_monthly_return', round(COALESCE(h.monthly_rent, 0) * v_rate / 100),
      'partner_annual_return', round(COALESCE(h.monthly_rent, 0) * v_rate / 100 * 12),
      'created_at', h.created_at
    ) ORDER BY pg.rn), '[]'::jsonb) AS j
    FROM page pg
    JOIN public.house_listings h ON h.id = pg.id
    LEFT JOIN public.profiles p ON p.id = h.agent_id
    LEFT JOIN public.landlords lp ON lp.id = h.landlord_id
  )
  SELECT counted.c, rows_json.j INTO v_total, v_rows FROM counted, rows_json;

  SELECT COALESCE(jsonb_agg(q.d ORDER BY q.d), '[]'::jsonb) INTO v_districts
  FROM (
    SELECT DISTINCT btrim(hl.district) AS d
    FROM public.house_listings hl
    WHERE hl.status = 'available'
      AND hl.tenant_id IS NULL
      AND COALESCE(hl.is_hidden, false) = false
      AND COALESCE(hl.monthly_rent, 0) > 0
      AND NULLIF(btrim(COALESCE(hl.district, '')), '') IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.partner_supported_houses psh
        WHERE psh.house_id = hl.id
          AND psh.status IN ('pending', 'active')
      )
  ) q;

  RETURN jsonb_build_object('total', v_total, 'houses', v_rows, 'districts', v_districts,
                            'returns_rate_pct', v_rate);
END;
$function$;

CREATE OR REPLACE FUNCTION public.approve_pending_portfolio(p_portfolio_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
BEGIN
  IF v_caller IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT public.is_partner_ops(v_caller) THEN RAISE EXCEPTION 'NOT_AUTHORIZED'; END IF;
  RETURN public._approve_pending_portfolio_core(p_portfolio_id, v_caller);
END;
$function$;

CREATE OR REPLACE FUNCTION public.reject_pending_portfolio(p_portfolio_id uuid, p_reason text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_status text;
  v_pending public.funder_pending_portfolios%ROWTYPE;
BEGIN
  IF v_caller IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT public.is_partner_ops(v_caller) THEN RAISE EXCEPTION 'NOT_AUTHORIZED'; END IF;
  IF length(COALESCE(btrim(p_reason),'')) < 10 THEN
    RAISE EXCEPTION 'A reason of at least 10 characters is required.' USING ERRCODE = 'check_violation';
  END IF;

  SELECT status INTO v_status FROM public.investor_portfolios WHERE id = p_portfolio_id;
  IF v_status IS NULL THEN RAISE EXCEPTION 'PORTFOLIO_NOT_FOUND'; END IF;
  IF v_status <> 'pending_ops_approval' THEN
    RAISE EXCEPTION 'INVALID_STATUS' USING HINT = v_status;
  END IF;

  SELECT * INTO v_pending FROM public.funder_pending_portfolios
   WHERE portfolio_id = p_portfolio_id AND status = 'pending' FOR UPDATE;

  UPDATE public.investor_portfolios SET status = 'cancelled' WHERE id = p_portfolio_id;

  IF v_pending.id IS NOT NULL AND v_pending.source = 'self_managed' THEN
    UPDATE public.rent_requests rr
       SET self_funding_partner_id = NULL, self_funding_line_id = NULL, updated_at = now()
      FROM public.partner_self_funding_lines l
     WHERE l.commitment_id = v_pending.commitment_id AND rr.id = l.rent_request_id;

    UPDATE public.partner_self_plan_claims
       SET status = 'released', updated_at = now()
     WHERE commitment_id = v_pending.commitment_id;

    DELETE FROM public.partner_self_funding_lines WHERE commitment_id = v_pending.commitment_id;

    UPDATE public.partner_self_commitments
       SET status = 'cancelled', updated_at = now()
     WHERE id = v_pending.commitment_id;
  END IF;

  IF v_pending.id IS NOT NULL THEN
    UPDATE public.funder_pending_portfolios
       SET status = 'rejected', reviewed_by = v_caller, reviewed_at = now(),
           review_reason = btrim(p_reason), updated_at = now()
     WHERE id = v_pending.id;
  END IF;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  VALUES (v_caller, 'reject_pending_portfolio', 'investor_portfolios', p_portfolio_id,
    jsonb_build_object('reason', btrim(p_reason), 'prev_status', v_status));

  RETURN p_portfolio_id;
END;
$function$;

-- 2. Phase 1 co-support functions
CREATE OR REPLACE FUNCTION public._co_support_expire_stale(p_rent_request_id uuid DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_n integer;
BEGIN
  UPDATE public.co_support_invites
     SET status = 'expired', closed_at = now(), close_reason = 'expired', updated_at = now()
   WHERE status = 'open'
     AND expires_at <= now()
     AND (p_rent_request_id IS NULL OR rent_request_id = p_rent_request_id);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

CREATE OR REPLACE FUNCTION public._co_support_invite_json(p_invite_id uuid, p_viewer uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v public.co_support_invites%ROWTYPE;
  v_role text;
  v_share numeric;
  v_other uuid;
  v_rate numeric;
  v_portfolio uuid;
  v_rr record;
BEGIN
  SELECT * INTO v FROM public.co_support_invites WHERE id = p_invite_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  v_role := CASE WHEN p_viewer = v.lead_partner_id THEN 'lead'
                 WHEN p_viewer IS NOT NULL AND p_viewer = v.invitee_id THEN 'invitee'
                 ELSE 'other' END;
  v_share := CASE WHEN v_role = 'lead' THEN v.lead_share ELSE v.invitee_share END;
  v_other := CASE WHEN v_role = 'lead' THEN COALESCE(v.invitee_id, v.declined_by) ELSE v.lead_partner_id END;
  v_portfolio := CASE WHEN v_role = 'lead' THEN v.lead_portfolio_id
                      WHEN v_role = 'invitee' THEN v.invitee_portfolio_id END;

  -- The viewer's own rate: the stamped one once funded, otherwise today's.
  IF v_role IN ('lead', 'invitee') AND v_portfolio IS NOT NULL THEN
    SELECT l.monthly_rate INTO v_rate
      FROM public.partner_self_funding_lines l
     WHERE l.co_support_id = v.id AND l.partner_id = p_viewer AND l.status <> 'cancelled'
     LIMIT 1;
  ELSIF p_viewer IS NOT NULL THEN
    BEGIN
      v_rate := public.partner_rate_now(p_viewer);
    EXCEPTION WHEN OTHERS THEN
      v_rate := NULL;
    END;
  END IF;

  SELECT split_part(COALESCE(NULLIF(btrim(tp.full_name), ''), 'Tenant'), ' ', 1) AS tenant_first_name,
         NULLIF(btrim(rr.request_city), '') AS city,
         rr.house_image_urls[1] AS house_image_url
    INTO v_rr
    FROM public.rent_requests rr
    LEFT JOIN public.profiles tp ON tp.id = rr.tenant_id
   WHERE rr.id = v.rent_request_id;

  RETURN jsonb_build_object(
    'id', v.id,
    'code', CASE WHEN v_role = 'lead' THEN v.code END,
    'status', public._co_support_status(v.status, v.expires_at, v.declined_at),
    'expires_at', v.expires_at,
    'rent_request_id', v.rent_request_id,
    'tenant_first_name', v_rr.tenant_first_name,
    'city', v_rr.city,
    'house_image_url', v_rr.house_image_url,
    'rent_amount', v.rent_amount,
    'plan_amount', v.gross_amount,
    'your_role', v_role,
    'your_share', v_share,
    'partner_share', v.gross_amount - v_share,
    'partner_first_name', public._co_support_first_name(v_other),
    'your_monthly_rent_profit_share', CASE WHEN v_rate IS NULL THEN NULL ELSE round(v_share * v_rate / 100) END,
    'your_portfolio_id', v_portfolio,
    'accepted_at', v.accepted_at,
    'created_at', v.created_at
  );
END;
$$;

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
  v_rate numeric;
  v_reason text;
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

  v_is_partner := public.psm_is_partner(v_uid);
  v_signed := public.funder_has_signed_agreement(v_uid);
  v_float := public.funder_float_available(v_uid);
  BEGIN
    v_rate := public.partner_rate_now(v_uid);
  EXCEPTION WHEN OTHERS THEN
    v_rate := NULL;
  END;

  v_reason := CASE
    WHEN v_status <> 'open' THEN 'invite_' || v_status
    WHEN NOT public._pipeline_switch_on('funder_direct_release') THEN 'paused'
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
    'float_needed', GREATEST(v.invitee_share - v_float, 0));
END;
$$;

CREATE OR REPLACE FUNCTION public.co_support_accept(p_code text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
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
BEGIN
  PERFORM public._co_support_require_partner(v_uid);

  SELECT id, rent_request_id, lead_partner_id INTO v_peek
    FROM public.co_support_invites WHERE code = upper(btrim(COALESCE(p_code, '')));
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVITE_NOT_FOUND: This link is not valid. Ask your partner to share it again.'
      USING ERRCODE = 'check_violation';
  END IF;

  PERFORM public._co_support_lock(v_peek.rent_request_id, v_peek.lead_partner_id, v_uid);
  SELECT * INTO v FROM public.co_support_invites WHERE id = v_peek.id FOR UPDATE;

  IF v.status = 'completed' AND v.invitee_id = v_uid THEN
    RETURN public._co_support_invite_json(v.id, v_uid)
        || jsonb_build_object('ok', true, 'idempotent_replay', true, 'landlord_float_released', true);
  END IF;
  IF v.lead_partner_id = v_uid THEN
    RAISE EXCEPTION 'OWN_INVITE: You shared this Rent Plan. Send the link to the partner who will support it with you.'
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
    RAISE EXCEPTION 'LEAD_NOT_ELIGIBLE: The partner who shared this Rent Plan cannot fund it right now. Ask them to check their account.'
      USING ERRCODE = 'check_violation';
  END IF;

  PERFORM public.partner_rate_now(v_uid);
  v_avail := public.funder_float_available(v_uid);
  IF v_avail < v.invitee_share THEN
    RAISE EXCEPTION 'PARTNER_FUNDS_SHORT: Your half is UGX %. You have UGX % of operational float. Add float to your wallet, then accept.',
      public._co_support_fmt(v.invitee_share), public._co_support_fmt(v_avail)
      USING ERRCODE = 'check_violation';
  END IF;
  PERFORM public.psm_assert_no_foreign_booking(v_uid, ARRAY[v.rent_request_id]);
  PERFORM public.psm_assert_no_foreign_booking(v.lead_partner_id, ARRAY[v.rent_request_id]);

  -- Close the invite first: this ends the lead's hold, so their half can be spent here.
  UPDATE public.co_support_invites
     SET status = 'completed', invitee_id = v_uid, accepted_at = now(),
         closed_at = now(), close_reason = 'accepted', updated_at = now()
   WHERE id = v.id;

  v_lead_avail := public.funder_float_available(v.lead_partner_id);
  IF v_lead_avail < v.lead_share THEN
    RAISE EXCEPTION 'LEAD_FUNDS_SHORT: Your partner no longer has their half in their wallet. Ask them to add float, then try again.'
      USING ERRCODE = 'check_violation';
  END IF;

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

  IF v_problem IS NOT NULL THEN
    -- The plan went elsewhere. Close the invite; no money moves.
    UPDATE public.co_support_invites
       SET status = 'plan_unavailable', invitee_id = NULL, accepted_at = NULL,
           close_reason = v_problem, updated_at = now()
     WHERE id = v.id;
    PERFORM public.psm_audit(v_uid, v.lead_partner_id, 'co_support_plan_unavailable',
      'co_support_invites', v.id, jsonb_build_object('reason', v_problem, 'invitee', v_uid));
    RETURN jsonb_build_object('ok', false, 'status', 'plan_unavailable', 'reason', v_problem,
      'message', CASE WHEN v_problem = 'plan_changed'
                      THEN 'The rent on this plan changed after it was shared. Nothing was taken from your wallet. Ask your partner to share it again.'
                      ELSE 'This Rent Plan was taken before you accepted. Nothing was taken from your wallet.' END);
  END IF;

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

  UPDATE public.co_support_invites
     SET lead_commitment_id = (v_lead->>'commitment_id')::uuid,
         invitee_commitment_id = (v_mine->>'commitment_id')::uuid,
         lead_portfolio_id = (v_lead->>'portfolio_id')::uuid,
         invitee_portfolio_id = (v_mine->>'portfolio_id')::uuid,
         updated_at = now()
   WHERE id = v.id;

  -- Direct release: debit each partner, pay each half's fee, and (on the
  -- second half) release the full rent to the agent's landlord float.
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
$$;

CREATE OR REPLACE FUNCTION public.co_support_decline(p_code text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_peek record;
  v public.co_support_invites%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED' USING ERRCODE = '42501';
  END IF;
  SELECT id, rent_request_id, lead_partner_id INTO v_peek
    FROM public.co_support_invites WHERE code = upper(btrim(COALESCE(p_code, '')));
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVITE_NOT_FOUND: This link is not valid.' USING ERRCODE = 'check_violation';
  END IF;

  PERFORM public._co_support_lock(v_peek.rent_request_id, v_peek.lead_partner_id);
  SELECT * INTO v FROM public.co_support_invites WHERE id = v_peek.id FOR UPDATE;

  IF v.lead_partner_id = v_uid THEN
    RAISE EXCEPTION 'OWN_INVITE: To stop sharing this Rent Plan, cancel it instead.' USING ERRCODE = 'check_violation';
  END IF;
  IF public._co_support_status(v.status, v.expires_at, v.declined_at) <> 'open' THEN
    RETURN public._co_support_invite_json(v.id, v_uid) || jsonb_build_object('ok', true, 'idempotent_replay', true);
  END IF;

  UPDATE public.co_support_invites
     SET declined_at = now(), declined_by = v_uid, updated_at = now()
   WHERE id = v.id;

  PERFORM public.psm_audit(v_uid, v.lead_partner_id, 'co_support_declined', 'co_support_invites', v.id,
    jsonb_build_object('declined_by', v_uid));

  RETURN public._co_support_invite_json(v.id, v_uid) || jsonb_build_object('ok', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.co_support_cancel(p_invite_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_peek record;
  v public.co_support_invites%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED' USING ERRCODE = '42501';
  END IF;
  SELECT id, rent_request_id, lead_partner_id INTO v_peek FROM public.co_support_invites WHERE id = p_invite_id;
  IF NOT FOUND OR v_peek.lead_partner_id <> v_uid THEN
    RAISE EXCEPTION 'INVITE_NOT_FOUND' USING ERRCODE = 'check_violation';
  END IF;

  PERFORM public._co_support_lock(v_peek.rent_request_id, v_uid);
  SELECT * INTO v FROM public.co_support_invites WHERE id = p_invite_id FOR UPDATE;

  IF v.status IN ('open', 'expired') THEN
    UPDATE public.co_support_invites
       SET status = 'cancelled', closed_at = now(), close_reason = 'cancelled_by_lead', updated_at = now()
     WHERE id = v.id;
    PERFORM public.psm_audit(v_uid, v_uid, 'co_support_cancelled', 'co_support_invites', v.id, '{}'::jsonb);
  END IF;

  RETURN public._co_support_invite_json(v.id, v_uid) || jsonb_build_object('ok', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.co_support_reinvite(p_invite_id uuid, p_new_link boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_peek record;
  v public.co_support_invites%ROWTYPE;
  v_s jsonb;
  v_new public.co_support_invites%ROWTYPE;
BEGIN
  PERFORM public._co_support_require_partner(v_uid);
  SELECT id, rent_request_id, lead_partner_id INTO v_peek FROM public.co_support_invites WHERE id = p_invite_id;
  IF NOT FOUND OR v_peek.lead_partner_id <> v_uid THEN
    RAISE EXCEPTION 'INVITE_NOT_FOUND' USING ERRCODE = 'check_violation';
  END IF;

  PERFORM public._co_support_lock(v_peek.rent_request_id, v_uid);
  SELECT * INTO v FROM public.co_support_invites WHERE id = p_invite_id FOR UPDATE;

  IF v.status NOT IN ('open', 'expired') THEN
    RAISE EXCEPTION 'INVITE_CLOSED: This invitation is closed. Start a new one from the Rent Plan.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Step this invite aside so the plan checks below see the plan as free.
  UPDATE public.co_support_invites
     SET status = 'replaced', closed_at = now(), close_reason = 'reinvited', updated_at = now()
   WHERE id = v.id;

  IF EXISTS (SELECT 1 FROM public.co_support_invites
              WHERE rent_request_id = v.rent_request_id AND status = 'open' AND id <> v.id) THEN
    RAISE EXCEPTION 'PLAN_NOT_AVAILABLE: Another partner is already sharing this Rent Plan.'
      USING ERRCODE = 'check_violation';
  END IF;

  PERFORM public.psm_assert_no_foreign_booking(v_uid, ARRAY[v.rent_request_id]);
  v_s := public._co_support_lead_checks(v_uid, v.rent_request_id);

  IF p_new_link THEN
    INSERT INTO public.co_support_invites (
      code, rent_request_id, lead_partner_id, rent_amount, gross_amount,
      lead_rent, invitee_rent, lead_share, invitee_share, expires_at, replaces_id
    ) VALUES (
      public._co_support_new_code(), v.rent_request_id, v_uid,
      (v_s->>'rent')::numeric, (v_s->>'gross')::numeric,
      (v_s->>'lead_rent')::numeric, (v_s->>'invitee_rent')::numeric,
      (v_s->>'lead_share')::numeric, (v_s->>'invitee_share')::numeric,
      now() + interval '48 hours', v.id
    ) RETURNING * INTO v_new;
  ELSE
    UPDATE public.co_support_invites
       SET status = 'open', closed_at = NULL, close_reason = NULL,
           declined_at = NULL, declined_by = NULL,
           rent_amount = (v_s->>'rent')::numeric, gross_amount = (v_s->>'gross')::numeric,
           lead_rent = (v_s->>'lead_rent')::numeric, invitee_rent = (v_s->>'invitee_rent')::numeric,
           lead_share = (v_s->>'lead_share')::numeric, invitee_share = (v_s->>'invitee_share')::numeric,
           expires_at = now() + interval '48 hours', updated_at = now()
     WHERE id = v.id
    RETURNING * INTO v_new;
  END IF;

  PERFORM public.psm_audit(v_uid, v_uid, 'co_support_reinvited', 'co_support_invites', v_new.id,
    jsonb_build_object('previous_invite_id', v.id, 'new_link', p_new_link, 'expires_at', v_new.expires_at));

  RETURN public._co_support_invite_json(v_new.id, v_uid);
END;
$$;

CREATE OR REPLACE FUNCTION public.co_support_fund_alone(p_invite_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_peek record;
  v public.co_support_invites%ROWTYPE;
  v_need numeric;
  v_avail numeric;
  v_res jsonb;
BEGIN
  PERFORM public._co_support_require_partner(v_uid);
  SELECT id, rent_request_id, lead_partner_id INTO v_peek FROM public.co_support_invites WHERE id = p_invite_id;
  IF NOT FOUND OR v_peek.lead_partner_id <> v_uid THEN
    RAISE EXCEPTION 'INVITE_NOT_FOUND' USING ERRCODE = 'check_violation';
  END IF;

  PERFORM public._co_support_lock(v_peek.rent_request_id, v_uid);
  SELECT * INTO v FROM public.co_support_invites WHERE id = p_invite_id FOR UPDATE;

  IF v.status NOT IN ('open', 'expired') THEN
    RAISE EXCEPTION 'INVITE_CLOSED: This invitation is closed.' USING ERRCODE = 'check_violation';
  END IF;

  UPDATE public.co_support_invites
     SET status = 'funded_alone', closed_at = now(), close_reason = 'funded_alone', updated_at = now()
   WHERE id = v.id;

  v_need := public.self_support_gross(v.rent_amount);
  v_avail := public.funder_support_capacity(v_uid);
  IF v_avail < v_need THEN
    RAISE EXCEPTION 'PARTNER_FUNDS_SHORT: The full Rent Plan is UGX %. You have UGX % of operational float. Add float to your wallet, then try again.',
      public._co_support_fmt(v_need), public._co_support_fmt(v_avail)
      USING ERRCODE = 'check_violation';
  END IF;

  v_res := public.funder_support_tenant_direct(ARRAY[v.rent_request_id], NULL, 1);

  PERFORM public.psm_audit(v_uid, v_uid, 'co_support_funded_alone', 'co_support_invites', v.id,
    jsonb_build_object('amount', v_need, 'result', v_res));

  RETURN v_res || jsonb_build_object('co_support_id', v.id, 'ok', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.co_support_staff_cancel(p_invite_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v public.co_support_invites%ROWTYPE;
  v_after text;
  v_reason text;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED' USING ERRCODE = '42501';
  END IF;
  IF NOT public.is_partner_ops(v_caller) THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED' USING ERRCODE = '42501';
  END IF;
  IF length(COALESCE(btrim(p_reason), '')) < 10 THEN
    RAISE EXCEPTION 'A reason of at least 10 characters is required.' USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v FROM public.co_support_invites WHERE id = p_invite_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVITE_NOT_FOUND' USING ERRCODE = 'check_violation';
  END IF;
  IF v.status <> 'completed' THEN
    RAISE EXCEPTION 'NOT_FUNDED: This co-support invitation has no funding to cancel (status %).', v.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.agent_landlord_float_allocations a
     WHERE a.rent_request_id = v.rent_request_id AND a.source = 'partner_self_funding'
       AND COALESCE(a.paid_out_amount, 0) > 0
  ) THEN
    RAISE EXCEPTION 'LANDLORD_ALREADY_PAID: The landlord has already been paid from this float, so the funding cannot be cancelled here.'
      USING ERRCODE = 'check_violation';
  END IF;

  v_reason := 'staff_cancelled: ' || btrim(p_reason);
  -- Both halves in one statement; the line trigger releases the plan once.
  UPDATE public.partner_self_funding_lines
     SET status = 'cancelled', end_reason = v_reason, updated_at = now()
   WHERE co_support_id = v.id AND status <> 'cancelled';

  SELECT status INTO v_after FROM public.co_support_invites WHERE id = v.id;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
  VALUES (v_caller, 'co_support_staff_cancel', 'co_support_invites', v.id::text, btrim(p_reason),
          jsonb_build_object('rent_request_id', v.rent_request_id,
                             'lead_partner_id', v.lead_partner_id, 'invitee_id', v.invitee_id));

  RETURN jsonb_build_object(
    'success', v_after = 'cancelled',
    'rent_request_id', v.rent_request_id,
    'plan_released', v_after = 'cancelled',
    'refunds_due', (
      SELECT jsonb_agg(jsonb_build_object('partner_id', l.partner_id,
                                          'partner_first_name', public._co_support_first_name(l.partner_id),
                                          'amount', l.principal, 'commitment_id', l.commitment_id)
                       ORDER BY (l.partner_id = v.lead_partner_id) DESC)
        FROM public.partner_self_funding_lines l WHERE l.co_support_id = v.id),
    'note', 'Both halves are cancelled and the plan is back on the list. Refund each partner their half through the usual finance step.');
END;
$$;

CREATE OR REPLACE FUNCTION public.co_support_integrity_check()
RETURNS TABLE (invite_id uuid, rent_request_id uuid, problem text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  WITH done AS (
    SELECT i.* FROM public.co_support_invites i WHERE i.status = 'completed'
  ), lines AS (
    SELECT d.id, count(l.id) AS n,
           COALESCE(sum(l.rent_amount), 0) AS rent,
           COALESCE(sum(l.principal), 0) AS principal,
           count(l.id) FILTER (WHERE l.status NOT IN ('active', 'completed')) AS not_live
      FROM done d
      LEFT JOIN public.partner_self_funding_lines l ON l.co_support_id = d.id AND l.status <> 'cancelled'
     GROUP BY d.id
  )
  SELECT d.id, d.rent_request_id, 'expected 2 funding lines, found ' || l.n
    FROM done d JOIN lines l ON l.id = d.id WHERE l.n <> 2
  UNION ALL
  SELECT d.id, d.rent_request_id, 'line rent ' || l.rent || ' <> plan rent ' || d.rent_amount
    FROM done d JOIN lines l ON l.id = d.id WHERE l.n = 2 AND l.rent <> d.rent_amount
  UNION ALL
  SELECT d.id, d.rent_request_id, 'line principal ' || l.principal || ' <> agreed ' || d.gross_amount
    FROM done d JOIN lines l ON l.id = d.id WHERE l.n = 2 AND l.principal <> d.gross_amount
  UNION ALL
  SELECT d.id, d.rent_request_id, l.not_live || ' funding line(s) not earning'
    FROM done d JOIN lines l ON l.id = d.id WHERE l.not_live > 0
  UNION ALL
  SELECT d.id, d.rent_request_id, 'no landlord float allocation for the full rent'
    FROM done d
   WHERE NOT EXISTS (
     SELECT 1 FROM public.agent_landlord_float_allocations a
      WHERE a.rent_request_id = d.rent_request_id AND a.source = 'partner_self_funding'
        AND a.status NOT IN ('cancelled', 'reversed') AND a.allocated_amount = d.rent_amount)
  UNION ALL
  SELECT d.id, d.rent_request_id, 'a half was never debited'
    FROM done d
   WHERE (SELECT count(*) FROM public.general_ledger g
           WHERE g.ledger_scope = 'wallet' AND g.direction = 'cash_out'
             AND g.idempotency_key IN ('psm-commit-' || d.lead_commitment_id::text,
                                       'psm-commit-' || d.invitee_commitment_id::text)) <> 2
  UNION ALL
  SELECT l.co_support_id, l.rent_request_id, 'funding line on an invite that is not completed'
    FROM public.partner_self_funding_lines l
    JOIN public.co_support_invites i ON i.id = l.co_support_id
   WHERE l.status <> 'cancelled' AND i.status <> 'completed';
$$;

-- 3. House-only objects
DROP TRIGGER IF EXISTS trg_co_support_house_row_status ON public.partner_supported_houses;
DROP FUNCTION IF EXISTS public._co_support_house_row_status();
DROP TRIGGER IF EXISTS trg_psh_no_mixed_support ON public.partner_supported_houses;
DROP FUNCTION IF EXISTS public._psh_no_mixed_support();
DROP FUNCTION IF EXISTS public.co_support_create_house(uuid);
DROP FUNCTION IF EXISTS public.co_support_staff_list(integer);
DROP FUNCTION IF EXISTS public._co_support_pair_pending_portfolios(uuid);
DROP FUNCTION IF EXISTS public._co_support_open_house_half(uuid, uuid, numeric, numeric, text);
DROP FUNCTION IF EXISTS public._co_support_house_lead_checks(uuid, uuid);
DROP FUNCTION IF EXISTS public._co_support_house_problem(uuid);
DROP FUNCTION IF EXISTS public._co_support_require_partner_house(uuid);

-- 4. Supported-house rows back to one per house
DROP INDEX IF EXISTS public.ux_psh_house_live_co_support;
DROP INDEX IF EXISTS public.idx_psh_co_support;
DROP INDEX IF EXISTS public.ux_psh_house_live;
CREATE UNIQUE INDEX ux_psh_house_live ON public.partner_supported_houses USING btree (house_id) WHERE (status = ANY (ARRAY['pending'::text, 'active'::text]));
ALTER TABLE public.partner_supported_houses DROP COLUMN IF EXISTS co_support_id;

-- 5. Invitations back to Rent Plans only
ALTER TABLE public.co_support_invites DROP CONSTRAINT IF EXISTS co_support_invites_house_id_fkey;
DROP INDEX IF EXISTS public.ux_co_support_one_open_per_house;
ALTER TABLE public.co_support_invites DROP CONSTRAINT IF EXISTS co_support_one_target;
ALTER TABLE public.co_support_invites DROP COLUMN IF EXISTS house_id;
ALTER TABLE public.co_support_invites ALTER COLUMN rent_request_id SET NOT NULL;
