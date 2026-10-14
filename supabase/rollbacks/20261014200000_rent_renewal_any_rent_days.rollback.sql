-- Rollback for 20261014200000_rent_renewal_any_rent_days.sql
--
-- Puts the four live functions back to the bodies they had before the migration, and removes the new advice / preview / Rent Access Limit
-- functions, the reviewer read policy and the OTP binding columns.
--
-- KEPT on purpose (they hold data, and dropping them would destroy it):
--   * rent_requests.renewal_* columns and the write-once guard on them. Nothing writes them after this rollback.
--   * rent_request_review_notes and add_rent_request_review_note() (append-only reviewer notes).
--   * the system_config row 'rent_renewal_advice_params' and its two policies (harmless, tunable by admins).
-- To remove those as well, uncomment the block at the bottom: it is irreversible.
--
-- After this runs, the OTP edge function must be the version from before the change too (it calls rent_renewal_otp_context with the new
-- arguments); redeploy supabase/functions/rent-renewal-otp from the commit before this migration.

BEGIN;

-- 1. The Service Center queue without the renewal fields
CREATE OR REPLACE FUNCTION public.get_service_center_rent_queue(p_manager_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_manager uuid := COALESCE(p_manager_id, auth.uid());
  v_rows jsonb;
  v_reviewed jsonb;
BEGIN
  IF v_manager IS NULL THEN RAISE EXCEPTION 'manager required'; END IF;
  IF v_manager <> auth.uid() AND NOT public.is_ops_role(auth.uid()) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  SELECT COALESCE(jsonb_agg(x ORDER BY x->>'created_at'), '[]'::jsonb) INTO v_rows
  FROM (
    SELECT jsonb_build_object(
      'id', rr.id,
      'status', rr.status,
      'created_at', rr.created_at,
      'rent_amount', rr.rent_amount,
      'duration_days', rr.duration_days,
      'daily_repayment', rr.daily_repayment,
      'total_repayment', rr.total_repayment,
      'house_category', rr.house_category,
      'request_city', rr.request_city,
      'house_image_urls', rr.house_image_urls,
      'tenant_photo_url', rr.tenant_photo_url,
      'tenant_id', rr.tenant_id,
      'tenant_name', tp.full_name,
      'tenant_phone', tp.phone,
      'agent_id', rr.agent_id,
      'agent_name', ap.full_name,
      'agent_phone', ap.phone,
      'agent_avatar_url', ap.avatar_url,
      'landlord_name', lp.name,
      'landlord_phone', lp.phone
    ) AS x
    FROM public.rent_requests rr
    LEFT JOIN public.profiles tp ON tp.id = rr.tenant_id
    LEFT JOIN public.profiles ap ON ap.id = rr.agent_id
    LEFT JOIN public.landlords lp ON lp.id = rr.landlord_id
    WHERE rr.service_center_manager_id = v_manager
      AND rr.status = 'service_center_review'
  ) s;

  SELECT COALESCE(jsonb_agg(y ORDER BY y->>'service_center_reviewed_at' DESC), '[]'::jsonb) INTO v_reviewed
  FROM (
    SELECT jsonb_build_object(
      'id', rr.id,
      'status', rr.status,
      'rent_amount', rr.rent_amount,
      'tenant_name', tp.full_name,
      'agent_name', ap.full_name,
      'service_center_reviewed_at', rr.service_center_reviewed_at,
      'service_center_comment', rr.service_center_comment
    ) AS y
    FROM public.rent_requests rr
    LEFT JOIN public.profiles tp ON tp.id = rr.tenant_id
    LEFT JOIN public.profiles ap ON ap.id = rr.agent_id
    WHERE rr.service_center_manager_id = v_manager
      AND rr.service_center_reviewed_at IS NOT NULL
    ORDER BY rr.service_center_reviewed_at DESC
    LIMIT 25
  ) r;

  RETURN jsonb_build_object(
    'manager_id', v_manager,
    'is_service_center_manager', public.is_service_center_manager(v_manager),
    'pending_count', jsonb_array_length(v_rows),
    'pending', v_rows,
    'recent_reviewed', v_reviewed
  );
END; $function$;

-- 2. Reviewer read access added by the migration
DROP POLICY IF EXISTS "Pipeline reviewers can view rent requests" ON public.rent_requests;

-- 3. The tenant OTP: the original trigger (any verified, unconsumed code for the tenant and agent within 30 minutes) and one-argument context
CREATE OR REPLACE FUNCTION public.enforce_rent_renewal_otp()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_otp uuid; v_actor uuid := COALESCE(auth.uid(), NEW.agent_id);
BEGIN
  IF NEW.registration_type IS DISTINCT FROM 'renewal' THEN RETURN NEW; END IF;
  SELECT id INTO v_otp FROM rent_renewal_otps
   WHERE tenant_id = NEW.tenant_id AND agent_id = v_actor
     AND verified_at IS NOT NULL AND consumed_at IS NULL
     AND verified_at > now() - interval '30 minutes'
   ORDER BY verified_at DESC LIMIT 1 FOR UPDATE;
  IF v_otp IS NULL THEN
    RAISE EXCEPTION 'RENEWAL_OTP_REQUIRED: the tenant must confirm this renewal with the code sent to their phone' USING ERRCODE = '42501';
  END IF;
  UPDATE rent_renewal_otps SET consumed_at = now(), consumed_request_id = NEW.id WHERE id = v_otp;
  RETURN NEW;
END $function$;

DROP FUNCTION IF EXISTS public.rent_renewal_otp_context(uuid, numeric, integer);
CREATE OR REPLACE FUNCTION public.rent_renewal_otp_context(p_prev_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_actor uuid := auth.uid(); v_prev rent_requests%ROWTYPE; v_phone text; v_tname text; v_aname text;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'NOT_AUTHENTICATED'; END IF;
  SELECT * INTO v_prev FROM rent_requests WHERE id = p_prev_request_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'PREVIOUS_REQUEST_NOT_FOUND'; END IF;
  IF v_prev.status <> 'completed' THEN RAISE EXCEPTION 'PLAN_NOT_COMPLETED: only a completed Rent Plan can be renewed'; END IF;
  IF NOT _can_renew_rent_request(v_prev, v_actor) THEN RAISE EXCEPTION 'NOT_YOUR_REQUEST'; END IF;
  SELECT phone, full_name INTO v_phone, v_tname FROM profiles WHERE id = v_prev.tenant_id;
  SELECT full_name INTO v_aname FROM profiles WHERE id = v_actor;
  RETURN jsonb_build_object('tenant_id', v_prev.tenant_id, 'tenant_phone', v_phone, 'tenant_name', v_tname,
    'agent_id', v_actor, 'agent_name', v_aname);
END $function$;
REVOKE ALL ON FUNCTION public.rent_renewal_otp_context(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rent_renewal_otp_context(uuid) TO authenticated, service_role;

ALTER TABLE public.rent_renewal_otps
  DROP COLUMN IF EXISTS new_rent_amount,
  DROP COLUMN IF EXISTS new_duration_days,
  DROP COLUMN IF EXISTS new_daily_repayment,
  DROP COLUMN IF EXISTS new_total_repayment;

-- 4. renew_rent_request: back to (previous plan, latitude, longitude), always at the previous rent and days
DROP FUNCTION IF EXISTS public.renew_rent_request(uuid, numeric, numeric, numeric, integer, text, text, text);
CREATE OR REPLACE FUNCTION public.renew_rent_request(p_prev_request_id uuid, p_latitude numeric DEFAULT NULL::numeric, p_longitude numeric DEFAULT NULL::numeric)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_agent uuid := auth.uid();
  v_prev  public.rent_requests%ROWTYPE;
  v_new_id uuid;
  v_photo text;
  v_lat numeric;
  v_lng numeric;
  v_allowed boolean := false;
BEGIN
  IF v_agent IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED';
  END IF;
  SELECT * INTO v_prev FROM public.rent_requests WHERE id = p_prev_request_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'PREVIOUS_REQUEST_NOT_FOUND'; END IF;

  -- Who may renew: the agent who currently manages the tenant (assigned agent wins
  -- after a transfer), the agent who filed it, the manager of any of the tenant's
  -- plans, either side of a verified parent/sub-agent link, or ops/admin staff.
  v_allowed := (COALESCE(v_prev.assigned_agent_id, v_prev.agent_id) = v_agent)
            OR (v_prev.agent_id = v_agent);

  IF NOT v_allowed THEN
    SELECT true INTO v_allowed
    FROM public.rent_requests r
    WHERE r.tenant_id = v_prev.tenant_id
      AND (r.agent_id = v_agent OR r.assigned_agent_id = v_agent)
    LIMIT 1;
  END IF;

  IF NOT v_allowed THEN
    SELECT true INTO v_allowed
    FROM public.agent_subagents s
    WHERE s.status = 'verified'
      AND (
        (s.parent_agent_id = v_agent AND s.sub_agent_id IN (v_prev.agent_id, v_prev.assigned_agent_id))
        OR (s.sub_agent_id = v_agent AND s.parent_agent_id IN (v_prev.agent_id, v_prev.assigned_agent_id))
      )
    LIMIT 1;
  END IF;

  IF NOT v_allowed THEN
    v_allowed := public.has_role(v_agent, 'agent_ops')
      OR public.has_role(v_agent, 'tenant_ops')
      OR public.has_role(v_agent, 'operations')
      OR public.has_role(v_agent, 'manager')
      OR public.has_role(v_agent, 'super_admin');
  END IF;

  IF NOT COALESCE(v_allowed, false) THEN
    RAISE EXCEPTION 'NOT_YOUR_REQUEST: this tenant is handled by another agent — ask Agent Ops to transfer the tenant to you before renewing';
  END IF;

  IF v_prev.landlord_id IS NULL THEN RAISE EXCEPTION 'LANDLORD_MISSING'; END IF;

  IF p_latitude IS NOT NULL AND p_longitude IS NOT NULL THEN
    IF p_latitude < -1.6 OR p_latitude > 4.3 OR p_longitude < 29.4 OR p_longitude > 35.1 THEN
      RAISE EXCEPTION 'RENT_REQUEST_GPS_OUT_OF_RANGE: the captured GPS (%, %) is not inside Uganda — recapture it at the house',
        p_latitude, p_longitude USING ERRCODE = '23514';
    END IF;
    v_lat := p_latitude;
    v_lng := p_longitude;
  END IF;

  IF v_lat IS NULL OR v_lng IS NULL THEN
    v_lat := v_prev.request_latitude;
    v_lng := v_prev.request_longitude;
  END IF;

  IF v_lat IS NULL OR v_lng IS NULL THEN
    SELECT r.request_latitude, r.request_longitude
      INTO v_lat, v_lng
    FROM public.rent_requests r
    WHERE r.tenant_id = v_prev.tenant_id
      AND r.request_latitude IS NOT NULL
      AND r.request_longitude IS NOT NULL
    ORDER BY r.created_at DESC
    LIMIT 1;
  END IF;

  IF v_lat IS NULL OR v_lng IS NULL THEN
    SELECT h.latitude, h.longitude
      INTO v_lat, v_lng
    FROM public.house_listings h
    WHERE (h.tenant_id = v_prev.tenant_id OR h.suspended_tenant_id = v_prev.tenant_id)
      AND h.latitude IS NOT NULL
      AND h.longitude IS NOT NULL
    ORDER BY h.created_at DESC
    LIMIT 1;
  END IF;

  IF v_lat IS NULL OR v_lng IS NULL THEN
    SELECT h.latitude, h.longitude
      INTO v_lat, v_lng
    FROM public.house_listings h
    WHERE h.landlord_id = v_prev.landlord_id
      AND h.latitude IS NOT NULL
      AND h.longitude IS NOT NULL
    ORDER BY h.created_at DESC
    LIMIT 1;
  END IF;

  IF v_lat IS NULL OR v_lng IS NULL THEN
    SELECT l.latitude, l.longitude
      INTO v_lat, v_lng
    FROM public.landlords l
    WHERE l.id = v_prev.landlord_id;
  END IF;

  IF v_lat IS NULL OR v_lng IS NULL THEN
    RAISE EXCEPTION 'GPS_REQUIRED: no property GPS on record for this tenant — capture the GPS at the house to renew';
  END IF;

  SELECT tenant_photo_url INTO v_photo
  FROM public.rent_requests
  WHERE tenant_id = v_prev.tenant_id
    AND tenant_photo_url IS NOT NULL
    AND btrim(tenant_photo_url) <> ''
  ORDER BY created_at DESC
  LIMIT 1;

  PERFORM set_config('app.bypass_daily_eligibility', 'true', true);

  INSERT INTO public.rent_requests (
    tenant_id, agent_id, landlord_id, lc1_id,
    rent_amount, duration_days,
    access_fee, request_fee, total_repayment, daily_repayment,
    status, house_category, tenant_no_smartphone,
    request_latitude, request_longitude,
    tenant_photo_url, registration_type,
    agent_guarantor_consent, agent_guarantor_consent_at, agent_guarantor_consent_version
  ) VALUES (
    v_prev.tenant_id, v_agent, v_prev.landlord_id, v_prev.lc1_id,
    v_prev.rent_amount, v_prev.duration_days,
    0, 0, 0, 0,
    'pending', v_prev.house_category, COALESCE(v_prev.tenant_no_smartphone, false),
    v_lat, v_lng,
    v_photo, 'renewal',
    true, now(), 'v1'
  )
  RETURNING id INTO v_new_id;

  RETURN v_new_id;
END;
$function$;
REVOKE ALL ON FUNCTION public.renew_rent_request(uuid, numeric, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.renew_rent_request(uuid, numeric, numeric) TO authenticated, service_role;

-- 5. The new read-only functions
DROP FUNCTION IF EXISTS public.preview_renewal_amount(uuid, numeric, integer);
DROP FUNCTION IF EXISTS public.get_renewal_advice(uuid, integer);
DROP FUNCTION IF EXISTS public._renewal_advice_core(public.rent_requests, integer, date);
DROP FUNCTION IF EXISTS public._renewal_max_rent(integer, numeric, numeric, numeric);
DROP FUNCTION IF EXISTS public._renewal_band(numeric, boolean, jsonb);
DROP FUNCTION IF EXISTS public._renewal_plan_stats(uuid, date);
DROP FUNCTION IF EXISTS public._renewal_advice_params();
DROP FUNCTION IF EXISTS public.rent_access_limit_server(uuid);
DROP FUNCTION IF EXISTS public._rent_access_limit_core(uuid, timestamptz);
DROP FUNCTION IF EXISTS public._rent_access_limit_params();
DROP FUNCTION IF EXISTS public._rent_access_limit_calc(timestamptz[], timestamptz, numeric, numeric, numeric);
DROP FUNCTION IF EXISTS public.rent_allowed_days();
DROP FUNCTION IF EXISTS public._rent_days_allowed(integer);

COMMIT;

-- Irreversible: removes the stored renewal advice, reasons and explanations and every reviewer note.
-- BEGIN;
-- DROP TRIGGER IF EXISTS trg_guard_renewal_columns ON public.rent_requests;
-- DROP FUNCTION IF EXISTS public._guard_renewal_columns();
-- ALTER TABLE public.rent_requests DROP CONSTRAINT IF EXISTS rent_requests_renewal_reason_check,
--   DROP COLUMN IF EXISTS renewal_previous_rent, DROP COLUMN IF EXISTS renewal_previous_days, DROP COLUMN IF EXISTS renewal_advice_snapshot,
--   DROP COLUMN IF EXISTS renewal_above_suggestion, DROP COLUMN IF EXISTS renewal_above_by, DROP COLUMN IF EXISTS renewal_change_reason_code,
--   DROP COLUMN IF EXISTS renewal_change_explanation, DROP COLUMN IF EXISTS renewal_evidence_url;
-- DROP FUNCTION IF EXISTS public.add_rent_request_review_note(uuid, text, text, text);
-- DROP TABLE IF EXISTS public.rent_request_review_notes;
-- DROP FUNCTION IF EXISTS public._rent_request_review_notes_append_only();
-- DROP POLICY IF EXISTS "Authenticated read rent_renewal_advice_params" ON public.system_config;
-- DROP POLICY IF EXISTS "Executives update rent_renewal_advice_params" ON public.system_config;
-- DELETE FROM public.system_config WHERE key = 'rent_renewal_advice_params';
-- COMMIT;
