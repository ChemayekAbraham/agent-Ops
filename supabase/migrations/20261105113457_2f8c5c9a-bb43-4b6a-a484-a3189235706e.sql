CREATE OR REPLACE FUNCTION public.funder_booked_houses()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_uid uuid := auth.uid(); v_rows jsonb;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501'; END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'intent_id', i.id,
           'note_id', i.note_id,
           'house_id', i.house_id,
           'title', COALESCE(h.title, 'Empty house'),
           'district', COALESCE(h.district, h.region, ''),
           'image_urls', COALESCE(h.image_urls, '{}'::text[]),
           'verified', COALESCE(h.verified, false),
           'monthly_rent', i.monthly_rent,
           'status', i.status,
           'promised_funding_date', i.promised_funding_date,
           'reserved_until', i.reserved_until,
           'released_at', i.released_at,
           'release_reason', i.release_reason,
           'funded_at', i.funded_at,
           'days_left', CASE WHEN i.status = 'reserved' AND i.reserved_until IS NOT NULL
                             THEN GREATEST(0, CEIL(EXTRACT(EPOCH FROM (i.reserved_until - now())) / 86400))::int
                        END,
           'taken', CASE WHEN i.status = 'reserved' AND (
                          h.id IS NULL
                          OR h.tenant_id IS NOT NULL
                          OR h.status <> 'available'
                          OR COALESCE(h.is_hidden, false)
                          OR EXISTS (SELECT 1 FROM public.partner_supported_houses psh
                                      WHERE psh.house_id = i.house_id AND psh.status IN ('pending','active'))
                          OR EXISTS (SELECT 1 FROM public.portfolio_allocations a
                                      WHERE a.house_id = i.house_id AND a.status IN ('reserved','fulfilled'))
                          OR EXISTS (SELECT 1 FROM public.promissory_note_house_intents oi
                                      JOIN public.promissory_notes on2 ON on2.id = oi.note_id
                                      WHERE oi.house_id = i.house_id
                                        AND oi.status IN ('reserved','funded')
                                        AND on2.partner_user_id <> v_uid)
                        ) THEN true ELSE false END,
           'created_at', i.created_at
         ) ORDER BY i.created_at DESC), '[]'::jsonb)
    INTO v_rows
    FROM public.promissory_note_house_intents i
    JOIN public.promissory_notes n ON n.id = i.note_id AND n.partner_user_id = v_uid
    LEFT JOIN public.house_listings h ON h.id = i.house_id
   WHERE i.created_at > now() - interval '120 days';

  RETURN jsonb_build_object('bookings', v_rows);
END;
$function$;