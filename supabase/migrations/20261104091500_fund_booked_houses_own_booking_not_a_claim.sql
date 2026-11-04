-- funder_fund_booked_houses: a funder's own booking must not block its own funding.
--
-- Since 20261005190000 partner_support_houses skips any house where
-- house_has_live_claim() is true, and that counts promissory-note intents in
-- status 'reserved' OR 'funded'. This function flipped the funder's own
-- intents to 'funded' *before* calling partner_support_houses, so every house
-- looked claimed and the call raised HOUSES_UNAVAILABLE. No booked house has
-- been funded through this path since 30 Sep 2026.
--
-- Fix: move the funder's intents to a transient 'funding' status (not counted
-- by house_has_live_claim) for the duration of the support call, then mark
-- them 'funded'. One transaction: any failure rolls the intents back to
-- 'reserved'. CREATE OR REPLACE keeps the existing grants.

CREATE OR REPLACE FUNCTION public.funder_fund_booked_houses(p_house_ids uuid[], p_term_months integer DEFAULT 1, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_note_ids uuid[];
  v_intent_ids uuid[];
  v_count integer := 0;
  v_result jsonb;
  v_note uuid;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501'; END IF;
  IF p_house_ids IS NULL OR array_length(p_house_ids,1) IS NULL THEN
    RAISE EXCEPTION 'NO_HOUSES_SELECTED' USING ERRCODE = '22023';
  END IF;

  SELECT COUNT(*), array_agg(DISTINCT i.note_id), array_agg(i.id)
    INTO v_count, v_note_ids, v_intent_ids
    FROM public.promissory_note_house_intents i
    JOIN public.promissory_notes n ON n.id = i.note_id
   WHERE i.house_id = ANY(p_house_ids)
     AND i.status = 'reserved'
     AND n.partner_user_id = v_uid;

  IF v_count <> array_length(p_house_ids,1) THEN
    RAISE EXCEPTION 'BOOKING_NOT_FOUND: some of these houses are no longer held for you. Refresh and try again.'
      USING ERRCODE = '23514';
  END IF;

  -- Step the funder's own holds aside so partner_support_houses does not read
  -- them as someone else's live claim. Only this funder's intents are touched.
  UPDATE public.promissory_note_house_intents
     SET status = 'funding', updated_at = now()
   WHERE id = ANY(v_intent_ids);

  v_result := public.partner_support_houses(
    p_house_ids := p_house_ids,
    p_term_months := p_term_months,
    p_idempotency_key := p_idempotency_key,
    p_commitment_id := NULL
  );

  UPDATE public.promissory_note_house_intents
     SET status = 'funded', funded_at = now(), updated_at = now()
   WHERE id = ANY(v_intent_ids);

  FOREACH v_note IN ARRAY COALESCE(v_note_ids, '{}'::uuid[]) LOOP
    PERFORM public.psm_queue_house_booking_notice(v_note, 'funded');
  END LOOP;

  RETURN v_result || jsonb_build_object('houses_funded', v_count, 'note_ids', to_jsonb(v_note_ids));
END;
$function$;
