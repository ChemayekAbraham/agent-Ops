CREATE OR REPLACE FUNCTION public.agent_list_empty_house_opportunities(
  p_search text DEFAULT NULL,
  p_limit integer DEFAULT 30,
  p_offset integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 30), 1), 100);
  v_offset integer := GREATEST(COALESCE(p_offset, 0), 0);
  v_search text := NULLIF(btrim(COALESCE(p_search, '')), '');
  v_total bigint := 0;
  v_rows jsonb := '[]'::jsonb;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501'; END IF;
  IF NOT (
    public.has_role(v_uid, 'agent') OR public.has_role(v_uid, 'senior_agent')
    OR public.has_role(v_uid, 'sub_agent') OR public.has_role(v_uid, 'supporter')
    OR public.is_ops_role(v_uid)
  ) THEN
    RAISE EXCEPTION 'Not authorised' USING ERRCODE = '42501';
  END IF;

  WITH base AS (
    SELECT h.id
    FROM public.house_listings h
    WHERE h.status = 'available'
      AND h.tenant_id IS NULL
      AND COALESCE(h.is_hidden, false) = false
      AND COALESCE(h.monthly_rent, 0) > 0
      AND NOT EXISTS (
        SELECT 1 FROM public.promissory_note_house_intents i
        WHERE i.house_id = h.id AND i.status = 'reserved'
      )
      AND (
        v_search IS NULL
        OR h.title ILIKE '%' || v_search || '%'
        OR h.district ILIKE '%' || v_search || '%'
        OR h.sub_county ILIKE '%' || v_search || '%'
        OR h.village ILIKE '%' || v_search || '%'
      )
  )
  SELECT COUNT(*) INTO v_total FROM base;

  WITH base AS (
    SELECT h.id, h.title, h.house_category, h.monthly_rent, h.district, h.sub_county,
           h.village, h.region, h.number_of_rooms, h.verified, h.created_at, h.agent_id,
           h.image_urls, h.latitude, h.longitude, h.landlord_id
    FROM public.house_listings h
    WHERE h.status = 'available'
      AND h.tenant_id IS NULL
      AND COALESCE(h.is_hidden, false) = false
      AND COALESCE(h.monthly_rent, 0) > 0
      AND NOT EXISTS (
        SELECT 1 FROM public.promissory_note_house_intents i
        WHERE i.house_id = h.id AND i.status = 'reserved'
      )
      AND (
        v_search IS NULL
        OR h.title ILIKE '%' || v_search || '%'
        OR h.district ILIKE '%' || v_search || '%'
        OR h.sub_county ILIKE '%' || v_search || '%'
        OR h.village ILIKE '%' || v_search || '%'
      )
    ORDER BY h.verified DESC NULLS LAST, h.created_at DESC
    LIMIT v_limit OFFSET v_offset
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'house_id', b.id,
    'title', b.title,
    'house_category', b.house_category,
    'monthly_rent', COALESCE(b.monthly_rent, 0),
    'district', b.district,
    'sub_county', b.sub_county,
    'village', b.village,
    'region', b.region,
    'number_of_rooms', b.number_of_rooms,
    'verified', COALESCE(b.verified, false),
    'listing_agent_id', b.agent_id,
    'listing_agent_name', p.full_name,
    'image_url', CASE WHEN b.image_urls IS NOT NULL AND array_length(b.image_urls, 1) > 0 THEN b.image_urls[1] ELSE NULL END,
    'image_urls', COALESCE(to_jsonb(b.image_urls), '[]'::jsonb),
    'latitude', b.latitude,
    'longitude', b.longitude,
    'landlord_id', b.landlord_id,
    'landlord_name', lp.full_name,
    'landlord_phone', lp.phone,
    'partner_monthly_return', round(COALESCE(b.monthly_rent, 0) * 0.15),
    'partner_annual_return', round(COALESCE(b.monthly_rent, 0) * 0.15 * 12),
    'created_at', b.created_at
  ) ORDER BY b.verified DESC, b.created_at DESC), '[]'::jsonb)
  INTO v_rows
  FROM base b
  LEFT JOIN public.profiles p ON p.id = b.agent_id
  LEFT JOIN public.profiles lp ON lp.id = b.landlord_id;

  RETURN jsonb_build_object('total', v_total, 'houses', v_rows);
END;
$function$;

REVOKE ALL ON FUNCTION public.agent_list_empty_house_opportunities(text, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.agent_list_empty_house_opportunities(text, integer, integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.agent_create_promissory_note_for_houses(
  p_payload jsonb,
  p_house_ids uuid[] DEFAULT '{}'::uuid[]
)
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
  v_type text := COALESCE(NULLIF(btrim(p_payload->>'contribution_type'), ''), 'once_off');
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
           COALESCE(NULLIF(regexp_replace(COALESCE(pr.phone, ''), '\D', '', 'g'), ''), v_whatsapp)
      INTO v_name, v_whatsapp
    FROM public.profiles pr WHERE pr.id = v_uid;
  END IF;

  IF length(v_name) < 3 THEN RAISE EXCEPTION 'Partner name is required' USING ERRCODE = '22023'; END IF;
  IF length(regexp_replace(v_whatsapp, '\D', '', 'g')) < 9 THEN RAISE EXCEPTION 'A valid WhatsApp number is required' USING ERRCODE = '22023'; END IF;
  IF v_amount <= 0 THEN RAISE EXCEPTION 'Promised amount must be greater than zero' USING ERRCODE = '22023'; END IF;
  IF COALESCE(array_length(v_ids, 1), 0) = 0 THEN
    RAISE EXCEPTION 'HOUSES_REQUIRED: select at least one empty house for this partner.' USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.promissory_notes (
    agent_id, partner_name, whatsapp_number, phone_number, email,
    amount, contribution_type, deduction_day, next_deduction_date, support_mode,
    partner_user_id
  ) VALUES (
    v_uid, v_name, v_whatsapp,
    NULLIF(btrim(COALESCE(p_payload->>'phone_number','')), ''),
    NULLIF(btrim(COALESCE(p_payload->>'email','')), ''),
    v_amount,
    CASE WHEN v_type = 'monthly' THEN 'monthly' ELSE 'once_off' END,
    CASE WHEN v_type = 'monthly' THEN NULLIF(p_payload->>'deduction_day','')::integer END,
    CASE WHEN v_type = 'monthly' THEN NULLIF(p_payload->>'next_deduction_date','')::date END,
    'self_support',
    CASE WHEN v_self THEN v_uid ELSE NULL END
  ) RETURNING * INTO v_note;

  INSERT INTO public.promissory_note_house_intents (note_id, house_id, agent_id, listing_agent_id, monthly_rent)
  SELECT v_note.id, h.id, v_uid, h.agent_id, COALESCE(h.monthly_rent, 0)
  FROM public.house_listings h
  WHERE h.id = ANY(v_ids)
    AND h.status = 'available'
    AND h.tenant_id IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.promissory_note_house_intents i
      WHERE i.house_id = h.id AND i.status = 'reserved'
    );

  SELECT COUNT(*), COALESCE(SUM(monthly_rent), 0) INTO v_count, v_rent_sum
  FROM public.promissory_note_house_intents
  WHERE note_id = v_note.id AND status = 'reserved';

  IF v_count <> array_length(v_ids, 1) THEN
    RAISE EXCEPTION 'HOUSES_UNAVAILABLE: some selected houses are no longer empty. Refresh and try again.' USING ERRCODE = '23514';
  END IF;

  PERFORM public.psm_queue_promissory_pledge_notice(v_note.id);

  RETURN jsonb_build_object(
    'note', to_jsonb(v_note),
    'house_count', v_count,
    'houses_monthly_rent', v_rent_sum,
    'monthly_return', round(v_amount * 0.15),
    'annual_return', round(v_amount * 0.15 * 12)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.agent_create_promissory_note_for_houses(jsonb, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.agent_create_promissory_note_for_houses(jsonb, uuid[]) TO authenticated;