-- 1. Hold lifecycle columns on house bookings
ALTER TABLE public.promissory_note_house_intents
  ADD COLUMN IF NOT EXISTS reserved_until timestamptz,
  ADD COLUMN IF NOT EXISTS promised_funding_date date,
  ADD COLUMN IF NOT EXISTS warned_at timestamptz,
  ADD COLUMN IF NOT EXISTS released_at timestamptz,
  ADD COLUMN IF NOT EXISTS release_reason text,
  ADD COLUMN IF NOT EXISTS funded_at timestamptz,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

UPDATE public.promissory_note_house_intents
   SET reserved_until = created_at + interval '7 days'
 WHERE reserved_until IS NULL;

ALTER TABLE public.promissory_note_house_intents
  ALTER COLUMN reserved_until SET DEFAULT (now() + interval '7 days');

DROP TRIGGER IF EXISTS trg_pnhi_updated_at ON public.promissory_note_house_intents;
CREATE TRIGGER trg_pnhi_updated_at BEFORE UPDATE ON public.promissory_note_house_intents
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE UNIQUE INDEX IF NOT EXISTS ux_pnhi_house_reserved
  ON public.promissory_note_house_intents (house_id)
  WHERE status = 'reserved';

CREATE INDEX IF NOT EXISTS idx_pnhi_reserved_until
  ON public.promissory_note_house_intents (reserved_until)
  WHERE status = 'reserved';

-- Funder can read the bookings on their own notes
DROP POLICY IF EXISTS "pnhi_partner_read_own" ON public.promissory_note_house_intents;
CREATE POLICY "pnhi_partner_read_own"
ON public.promissory_note_house_intents
FOR SELECT
TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.promissory_notes n
   WHERE n.id = promissory_note_house_intents.note_id
     AND n.partner_user_id = auth.uid()
));

-- 2. Notice queue for house-booking messages (SMS + email)
CREATE TABLE IF NOT EXISTS public.promissory_house_booking_notices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  note_id uuid NOT NULL REFERENCES public.promissory_notes(id) ON DELETE CASCADE,
  partner_user_id uuid,
  kind text NOT NULL CHECK (kind = ANY (ARRAY['booked','funded','reminder','released','given_up'])),
  partner_name text,
  phone text,
  email text,
  house_count integer NOT NULL DEFAULT 0,
  total_rent numeric NOT NULL DEFAULT 0,
  promised_funding_date date,
  release_at timestamptz,
  days_left integer,
  houses jsonb NOT NULL DEFAULT '[]'::jsonb,
  sms_sent_at timestamptz,
  sms_error text,
  email_sent_at timestamptz,
  email_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (note_id, kind)
);

GRANT SELECT ON public.promissory_house_booking_notices TO authenticated;
GRANT ALL ON public.promissory_house_booking_notices TO service_role;

ALTER TABLE public.promissory_house_booking_notices ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "phbn_owner_or_ops_read" ON public.promissory_house_booking_notices;
CREATE POLICY "phbn_owner_or_ops_read"
ON public.promissory_house_booking_notices
FOR SELECT
TO authenticated
USING (partner_user_id = auth.uid() OR public.is_ops_role(auth.uid()));

DROP TRIGGER IF EXISTS trg_phbn_updated_at ON public.promissory_house_booking_notices;
CREATE TRIGGER trg_phbn_updated_at BEFORE UPDATE ON public.promissory_house_booking_notices
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE INDEX IF NOT EXISTS idx_phbn_pending
  ON public.promissory_house_booking_notices (created_at)
  WHERE sms_sent_at IS NULL OR email_sent_at IS NULL;

-- 3. Queue helper
CREATE OR REPLACE FUNCTION public.psm_queue_house_booking_notice(p_note_id uuid, p_kind text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_note public.promissory_notes;
  v_count integer := 0;
  v_rent numeric := 0;
  v_release timestamptz;
  v_promised date;
  v_houses jsonb := '[]'::jsonb;
BEGIN
  SELECT * INTO v_note FROM public.promissory_notes WHERE id = p_note_id;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT COUNT(*), COALESCE(SUM(i.monthly_rent),0), MIN(i.reserved_until), MIN(i.promised_funding_date),
         COALESCE(jsonb_agg(jsonb_build_object(
           'house_id', i.house_id,
           'title', COALESCE(h.title, 'Empty house'),
           'district', COALESCE(h.district, h.region, ''),
           'monthly_rent', i.monthly_rent
         ) ORDER BY i.monthly_rent DESC), '[]'::jsonb)
    INTO v_count, v_rent, v_release, v_promised, v_houses
    FROM public.promissory_note_house_intents i
    LEFT JOIN public.house_listings h ON h.id = i.house_id
   WHERE i.note_id = p_note_id
     AND i.status = CASE p_kind
                      WHEN 'funded' THEN 'funded'
                      WHEN 'released' THEN 'released'
                      WHEN 'given_up' THEN 'released'
                      ELSE 'reserved'
                    END;

  IF COALESCE(v_count,0) = 0 THEN RETURN; END IF;

  INSERT INTO public.promissory_house_booking_notices (
    note_id, partner_user_id, kind, partner_name, phone, email,
    house_count, total_rent, promised_funding_date, release_at, days_left, houses
  ) VALUES (
    p_note_id, v_note.partner_user_id, p_kind, v_note.partner_name,
    COALESCE(NULLIF(btrim(v_note.whatsapp_number),''), NULLIF(btrim(v_note.phone_number),'')),
    NULLIF(btrim(v_note.email),''),
    v_count, v_rent, v_promised, v_release,
    CASE WHEN v_release IS NULL THEN NULL
         ELSE GREATEST(0, CEIL(EXTRACT(EPOCH FROM (v_release - now())) / 86400))::int END,
    v_houses
  )
  ON CONFLICT (note_id, kind) DO NOTHING;
END;
$$;

REVOKE ALL ON FUNCTION public.psm_queue_house_booking_notice(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.psm_queue_house_booking_notice(uuid, text) TO service_role;

-- 4. Booking creation carries the promised funding date and queues the booked notice
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
    NULLIF(btrim(COALESCE(p_payload->>'email','')), ''),
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
  PERFORM public.psm_queue_house_booking_notice(v_note.id, 'booked');

  RETURN jsonb_build_object(
    'note', to_jsonb(v_note),
    'house_count', v_count,
    'houses_monthly_rent', v_rent_sum,
    'reserved_until', v_hold,
    'promised_funding_date', v_promised,
    'monthly_return', round(v_amount * 0.15),
    'annual_return', round(v_amount * 0.15 * 12)
  );
END;
$function$;

-- 5. Funder funds booked houses now (routes through the existing house-support approval flow)
CREATE OR REPLACE FUNCTION public.funder_fund_booked_houses(
  p_house_ids uuid[],
  p_term_months integer DEFAULT 1,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_note_ids uuid[];
  v_count integer := 0;
  v_result jsonb;
  v_note uuid;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501'; END IF;
  IF p_house_ids IS NULL OR array_length(p_house_ids,1) IS NULL THEN
    RAISE EXCEPTION 'NO_HOUSES_SELECTED' USING ERRCODE = '22023';
  END IF;

  SELECT COUNT(*), array_agg(DISTINCT i.note_id)
    INTO v_count, v_note_ids
    FROM public.promissory_note_house_intents i
    JOIN public.promissory_notes n ON n.id = i.note_id
   WHERE i.house_id = ANY(p_house_ids)
     AND i.status = 'reserved'
     AND n.partner_user_id = v_uid;

  IF v_count <> array_length(p_house_ids,1) THEN
    RAISE EXCEPTION 'BOOKING_NOT_FOUND: some of these houses are no longer held for you. Refresh and try again.'
      USING ERRCODE = '23514';
  END IF;

  -- Free the hold inside this transaction so the house-support path sees the houses as available.
  UPDATE public.promissory_note_house_intents
     SET status = 'funded', funded_at = now(), updated_at = now()
   WHERE house_id = ANY(p_house_ids) AND status = 'reserved';

  v_result := public.partner_support_houses(
    p_house_ids := p_house_ids,
    p_term_months := p_term_months,
    p_idempotency_key := p_idempotency_key,
    p_commitment_id := NULL
  );

  FOREACH v_note IN ARRAY COALESCE(v_note_ids, '{}'::uuid[]) LOOP
    PERFORM public.psm_queue_house_booking_notice(v_note, 'funded');
  END LOOP;

  RETURN v_result || jsonb_build_object('houses_funded', v_count, 'note_ids', to_jsonb(v_note_ids));
END;
$$;

REVOKE ALL ON FUNCTION public.funder_fund_booked_houses(uuid[], integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.funder_fund_booked_houses(uuid[], integer, text) TO authenticated, service_role;

-- 6. Funder gives up booked houses (back to the open empty-house list)
CREATE OR REPLACE FUNCTION public.funder_release_booked_houses(
  p_house_ids uuid[],
  p_reason text DEFAULT 'given_up_by_funder'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_released integer := 0;
  v_note_ids uuid[];
  v_note uuid;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501'; END IF;
  IF p_house_ids IS NULL OR array_length(p_house_ids,1) IS NULL THEN
    RAISE EXCEPTION 'NO_HOUSES_SELECTED' USING ERRCODE = '22023';
  END IF;

  WITH freed AS (
    UPDATE public.promissory_note_house_intents i
       SET status = 'released',
           released_at = now(),
           release_reason = COALESCE(NULLIF(btrim(p_reason),''), 'given_up_by_funder'),
           updated_at = now()
     WHERE i.house_id = ANY(p_house_ids)
       AND i.status = 'reserved'
       AND EXISTS (SELECT 1 FROM public.promissory_notes n
                    WHERE n.id = i.note_id AND n.partner_user_id = v_uid)
    RETURNING i.note_id
  )
  SELECT COUNT(*)::int, array_agg(DISTINCT note_id) INTO v_released, v_note_ids FROM freed;

  FOREACH v_note IN ARRAY COALESCE(v_note_ids, '{}'::uuid[]) LOOP
    PERFORM public.psm_queue_house_booking_notice(v_note, 'given_up');
  END LOOP;

  RETURN jsonb_build_object('released', COALESCE(v_released,0));
END;
$$;

REVOKE ALL ON FUNCTION public.funder_release_booked_houses(uuid[], text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.funder_release_booked_houses(uuid[], text) TO authenticated, service_role;

-- 7. Reminder queue (3 days before the hold lapses)
CREATE OR REPLACE FUNCTION public.psm_queue_house_release_warnings()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_queued integer := 0; v_note uuid;
BEGIN
  FOR v_note IN
    SELECT DISTINCT i.note_id
      FROM public.promissory_note_house_intents i
     WHERE i.status = 'reserved'
       AND i.warned_at IS NULL
       AND i.reserved_until > now()
       AND i.reserved_until <= now() + interval '3 days'
  LOOP
    PERFORM public.psm_queue_house_booking_notice(v_note, 'reminder');
    UPDATE public.promissory_note_house_intents
       SET warned_at = now(), updated_at = now()
     WHERE note_id = v_note AND status = 'reserved' AND warned_at IS NULL;
    v_queued := v_queued + 1;
  END LOOP;

  RETURN jsonb_build_object('queued', v_queued, 'ran_at', now());
END;
$$;

REVOKE ALL ON FUNCTION public.psm_queue_house_release_warnings() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.psm_queue_house_release_warnings() TO service_role;

-- 8. Release lapsed holds back to the open empty-house list
CREATE OR REPLACE FUNCTION public.psm_release_expired_house_intents()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_released integer := 0; v_amount numeric := 0; v_note uuid; v_notes uuid[];
BEGIN
  WITH expired AS (
    UPDATE public.promissory_note_house_intents i
       SET status = 'released',
           released_at = now(),
           release_reason = 'hold_expired_7_days',
           updated_at = now()
     WHERE i.status = 'reserved'
       AND i.reserved_until <= now()
    RETURNING i.note_id, i.house_id, i.monthly_rent, i.agent_id
  ), ev AS (
    INSERT INTO public.system_events (event_type, user_id, description, metadata)
    SELECT 'listing_created', e.agent_id,
           'Funder house booking expired: house returned to the empty-house list',
           jsonb_build_object('note_id', e.note_id, 'house_id', e.house_id,
                              'monthly_rent', e.monthly_rent, 'reason', 'hold_expired_7_days')
      FROM expired e
    RETURNING 1
  )
  SELECT COUNT(*)::int, COALESCE(SUM(monthly_rent),0), array_agg(DISTINCT note_id)
    INTO v_released, v_amount, v_notes
    FROM expired;

  FOREACH v_note IN ARRAY COALESCE(v_notes, '{}'::uuid[]) LOOP
    PERFORM public.psm_queue_house_booking_notice(v_note, 'released');
  END LOOP;

  RETURN jsonb_build_object('released', COALESCE(v_released,0),
                            'released_rent', COALESCE(v_amount,0), 'ran_at', now());
END;
$$;

REVOKE ALL ON FUNCTION public.psm_release_expired_house_intents() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.psm_release_expired_house_intents() TO service_role;

-- 9. Funder-facing list of their own bookings
CREATE OR REPLACE FUNCTION public.funder_booked_houses()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
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
           'created_at', i.created_at
         ) ORDER BY i.created_at DESC), '[]'::jsonb)
    INTO v_rows
    FROM public.promissory_note_house_intents i
    JOIN public.promissory_notes n ON n.id = i.note_id AND n.partner_user_id = v_uid
    LEFT JOIN public.house_listings h ON h.id = i.house_id
   WHERE i.created_at > now() - interval '120 days';

  RETURN jsonb_build_object('bookings', v_rows);
END;
$$;

REVOKE ALL ON FUNCTION public.funder_booked_houses() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.funder_booked_houses() TO authenticated, service_role;

-- 10. Daily backstops (reuse the existing promissory cron cadence)
SELECT cron.unschedule('psm-release-expired-house-bookings')
 WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'psm-release-expired-house-bookings');
SELECT cron.schedule(
  'psm-release-expired-house-bookings',
  '15 3 * * *',
  $$SELECT public.psm_release_expired_house_intents();$$
);

SELECT cron.unschedule('psm-queue-house-release-warnings')
 WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'psm-queue-house-release-warnings');
SELECT cron.schedule(
  'psm-queue-house-release-warnings',
  '10 6 * * *',
  $$SELECT public.psm_queue_house_release_warnings();$$
);