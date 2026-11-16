-- Author: SSENKAALI PIUS
-- Email: ssenkaali.pius@welileapp.com
-- Date: 2026-11-13
-- Website: welileapp.com

-- Rollback of 20261123090000_house_note_keeps_typed_partner: restores agent_create_promissory_note_for_houses exactly as it was on production on
-- 13 Nov 2026 (supporters without an active agent role get their own details on house notes again).

CREATE OR REPLACE FUNCTION public.agent_create_promissory_note_for_houses(p_payload jsonb, p_house_ids uuid[] DEFAULT '{}'::uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_ids uuid[] := COALESCE(p_house_ids, '{}'::uuid[]);
  v_amount numeric := COALESCE((p_payload->>'amount')::numeric, 0);
  v_name text := btrim(COALESCE(p_payload->>'partner_name', ''));
  v_whatsapp text := btrim(COALESCE(p_payload->>'whatsapp_number', ''));
  v_email text := lower(btrim(COALESCE(p_payload->>'email', '')));
  v_type text := COALESCE(NULLIF(btrim(p_payload->>'contribution_type'), ''), 'once_off');
  v_promised date := NULLIF(btrim(COALESCE(p_payload->>'promised_funding_date','')), '')::date;
  v_hold timestamptz := now() + interval '7 days';
  v_note public.promissory_notes;
  v_count integer := 0;
  v_rent_sum numeric := 0;
  v_is_agent boolean;
  v_is_supporter boolean;
  v_self boolean := false;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501'; END IF;

  v_is_agent := public.has_role(v_uid, 'agent') OR public.has_role(v_uid, 'senior_agent')
                OR public.has_role(v_uid, 'sub_agent') OR public.is_ops_role(v_uid);
  v_is_supporter := public.has_role(v_uid, 'supporter');

  IF NOT (v_is_agent OR v_is_supporter) THEN
    RAISE EXCEPTION 'Not authorised to create promissory notes' USING ERRCODE = '42501';
  END IF;

  v_self := (NOT v_is_agent) AND v_is_supporter;

  IF v_self THEN
    SELECT COALESCE(NULLIF(btrim(pr.full_name), ''), v_name),
           COALESCE(NULLIF(regexp_replace(COALESCE(pr.phone, ''), '\D', '', 'g'), ''), v_whatsapp),
           COALESCE(NULLIF(lower(btrim(COALESCE(pr.email, ''))), ''), v_email)
      INTO v_name, v_whatsapp, v_email
    FROM public.profiles pr WHERE pr.id = v_uid;
  END IF;

  IF length(v_name) < 3 THEN RAISE EXCEPTION 'Partner name is required' USING ERRCODE = '22023'; END IF;
  IF length(regexp_replace(v_whatsapp, '\D', '', 'g')) < 9 THEN RAISE EXCEPTION 'A valid WhatsApp number is required' USING ERRCODE = '22023'; END IF;
  -- Email is optional; validate only when one was supplied.
  IF COALESCE(v_email,'') <> '' AND (length(v_email) > 255 OR v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$') THEN
    RAISE EXCEPTION 'EMAIL_INVALID: enter a valid email address or leave it blank.' USING ERRCODE = '22023';
  END IF;
  IF v_amount <= 0 THEN RAISE EXCEPTION 'Promised amount must be greater than zero' USING ERRCODE = '22023'; END IF;
  IF COALESCE(array_length(v_ids, 1), 0) = 0 THEN
    RAISE EXCEPTION 'HOUSES_REQUIRED: select at least one empty house for this partner.' USING ERRCODE = '23514';
  END IF;
  IF v_promised IS NOT NULL AND v_promised < current_date THEN
    RAISE EXCEPTION 'PROMISED_DATE_PAST: the promised funding date cannot be in the past.' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.promissory_notes (
    agent_id, partner_name, whatsapp_number, phone_number, email,
    amount, contribution_type, deduction_day, next_deduction_date, support_mode,
    partner_user_id
  ) VALUES (
    v_uid, v_name, v_whatsapp,
    NULLIF(btrim(COALESCE(p_payload->>'phone_number','')), ''),
    NULLIF(COALESCE(v_email,''), ''),
    v_amount,
    CASE WHEN v_type = 'monthly' THEN 'monthly' ELSE 'once_off' END,
    CASE WHEN v_type = 'monthly' THEN NULLIF(p_payload->>'deduction_day','')::integer END,
    CASE WHEN v_type = 'monthly' THEN NULLIF(p_payload->>'next_deduction_date','')::date END,
    'self_support',
    CASE WHEN v_self THEN v_uid ELSE NULL END
  ) RETURNING * INTO v_note;

  INSERT INTO public.promissory_note_house_intents (
    note_id, house_id, agent_id, listing_agent_id, monthly_rent, reserved_until, promised_funding_date
  )
  SELECT v_note.id, h.id, v_uid, h.agent_id, COALESCE(h.monthly_rent, 0), v_hold, v_promised
  FROM public.house_listings h
  WHERE h.id = ANY(v_ids)
    AND h.status = 'available'
    AND h.tenant_id IS NULL
    AND NOT public.house_has_live_claim(h.id);

  SELECT COUNT(*), COALESCE(SUM(monthly_rent), 0) INTO v_count, v_rent_sum
  FROM public.promissory_note_house_intents
  WHERE note_id = v_note.id AND status = 'reserved';

  IF v_count <> array_length(v_ids, 1) THEN
    RAISE EXCEPTION 'HOUSES_UNAVAILABLE: some selected houses are no longer empty. Refresh and try again.' USING ERRCODE = '23514';
  END IF;

  PERFORM public.psm_queue_promissory_pledge_notice(v_note.id);
  PERFORM public.psm_queue_house_booking_notice(v_note.id, 'booked');

  RETURN jsonb_build_object(
    'house_count', v_count,
    'houses_monthly_rent', v_rent_sum,
    'reserved_until', v_hold,
    'promised_funding_date', v_promised
  ) || public._promissory_note_rate_json(v_note, v_uid);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.agent_create_promissory_note_for_houses(jsonb, uuid[]) TO authenticated, service_role;
