CREATE OR REPLACE FUNCTION public.partner_supported_house_returns()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_email text;
  v_phone text;
  v_rows jsonb := '[]'::jsonb;
  v_month_start date := date_trunc('month', (now() AT TIME ZONE 'Africa/Kampala'))::date;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501'; END IF;

  SELECT lower(btrim(COALESCE(p.email, ''))), regexp_replace(COALESCE(p.phone, ''), '\D', '', 'g')
    INTO v_email, v_phone
  FROM public.profiles p WHERE p.id = v_uid;

  WITH my_notes AS (
    SELECT n.*
    FROM public.promissory_notes n
    WHERE n.partner_user_id = v_uid
       OR (NULLIF(v_email, '') IS NOT NULL AND lower(btrim(COALESCE(n.email, ''))) = v_email)
       OR (
         NULLIF(v_phone, '') IS NOT NULL AND length(v_phone) >= 9 AND (
           right(regexp_replace(COALESCE(n.phone_number, ''), '\D', '', 'g'), 9) = right(v_phone, 9)
           OR right(regexp_replace(COALESCE(n.whatsapp_number, ''), '\D', '', 'g'), 9) = right(v_phone, 9)
         )
       )
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'intent_id', i.id,
    'note_id', n.id,
    'house_id', h.id,
    'title', h.title,
    'district', h.district,
    'sub_county', h.sub_county,
    'village', h.village,
    'monthly_rent', COALESCE(i.monthly_rent, h.monthly_rent, 0),
    'monthly_return', round(COALESCE(i.monthly_rent, h.monthly_rent, 0) * 0.15),
    'annual_return', round(COALESCE(i.monthly_rent, h.monthly_rent, 0) * 0.15 * 12),
    'intent_status', i.status,
    'note_status', n.status,
    'promised_amount', COALESCE(n.amount, 0),
    'collected_amount', COALESCE(n.total_collected, 0),
    'is_funded', (n.status = 'activated' OR COALESCE(n.total_collected, 0) > 0),
    'tenant_activated', (h.tenant_id IS NOT NULL),
    'tenant_name', tp.full_name,
    'listing_agent_name', ap.full_name,
    'monthly_paid_this_month', EXISTS (
      SELECT 1 FROM public.agent_landlord_payouts pay
      WHERE pay.tenant_id = h.tenant_id
        AND pay.cfo_approved_at IS NOT NULL
        AND (pay.cfo_approved_at AT TIME ZONE 'Africa/Kampala')::date >= v_month_start
    ),
    'last_paid_at', (
      SELECT max(pay.cfo_approved_at) FROM public.agent_landlord_payouts pay
      WHERE pay.tenant_id = h.tenant_id AND pay.cfo_approved_at IS NOT NULL
    ),
    'created_at', i.created_at
  ) ORDER BY i.created_at DESC), '[]'::jsonb)
  INTO v_rows
  FROM public.promissory_note_house_intents i
  JOIN my_notes n ON n.id = i.note_id
  JOIN public.house_listings h ON h.id = i.house_id
  LEFT JOIN public.profiles tp ON tp.id = h.tenant_id
  LEFT JOIN public.profiles ap ON ap.id = i.listing_agent_id;

  RETURN jsonb_build_object(
    'houses', v_rows,
    'total_monthly_return', COALESCE((SELECT SUM((x->>'monthly_return')::numeric) FROM jsonb_array_elements(v_rows) x), 0),
    'total_annual_return', COALESCE((SELECT SUM((x->>'annual_return')::numeric) FROM jsonb_array_elements(v_rows) x), 0),
    'house_count', jsonb_array_length(v_rows)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.partner_supported_house_returns() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.partner_supported_house_returns() TO authenticated;