-- Follow-up hardening after the Kwenseri incident (docs: fuzzy name match,
-- 20260919170000). That fix handles spelling variance within the SAME
-- number of name tokens. It does not handle a name with one extra or
-- missing part (e.g. a middle name present on only one side) — the score
-- formula divides by the LARGER token count, so "KWENSERI ROGERS" vs
-- "KWENSERI ROGERS MICHAEL" caps at 2/3 = 0.67 even though every word that
-- IS present matches exactly. ensure_payout_destination's "still matches,
-- don't reopen" check requires a perfect 1.0, so this would silently demote
-- an already-verified destination again, same failure mode as yesterday,
-- different trigger.
--
-- payout_name_match_report now also returns `subset_match`: true when every
-- token of the SHORTER name has a good (exact or fuzzy) match among the
-- LONGER name's tokens. An extra/missing name part no longer counts as a
-- mismatch on its own. `score` and `diff` are unchanged — subset_match is
-- additive, so the auto-verify (>=0.9) and other existing callers keep their
-- current behavior; only ensure_payout_destination's re-verification check
-- is switched to use it.
CREATE OR REPLACE FUNCTION public.payout_name_match_report(p_a text, p_b text)
 RETURNS jsonb
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  a_tokens text[];
  b_tokens text[];
  v_common numeric := 0;
  v_diff text[] := '{}';
  t text;
  best_sim numeric;
  v_subset_match boolean;
  shorter text[];
  longer text[];
BEGIN
  IF coalesce(btrim(p_a),'') = '' OR coalesce(btrim(p_b),'') = '' THEN
    RETURN jsonb_build_object('score', NULL, 'diff', '[]'::jsonb, 'subset_match', NULL);
  END IF;

  SELECT array_agg(x) INTO a_tokens FROM (
    SELECT DISTINCT x FROM unnest(
      regexp_split_to_array(regexp_replace(lower(btrim(p_a)), '[^a-z0-9 ]', ' ', 'g'), '\s+')
    ) AS x WHERE length(x) > 1
  ) s;
  SELECT array_agg(x) INTO b_tokens FROM (
    SELECT DISTINCT x FROM unnest(
      regexp_split_to_array(regexp_replace(lower(btrim(p_b)), '[^a-z0-9 ]', ' ', 'g'), '\s+')
    ) AS x WHERE length(x) > 1
  ) s;

  IF a_tokens IS NULL OR b_tokens IS NULL THEN
    RETURN jsonb_build_object('score', NULL, 'diff', '[]'::jsonb, 'subset_match', NULL);
  END IF;

  FOREACH t IN ARRAY a_tokens LOOP
    IF t = ANY (b_tokens) THEN
      v_common := v_common + 1;
    ELSE
      SELECT max(similarity(t, x)) INTO best_sim FROM unnest(b_tokens) AS x;
      IF coalesce(best_sim, 0) >= 0.45 THEN
        v_common := v_common + 1;
      ELSE
        v_diff := v_diff || t;
      END IF;
    END IF;
  END LOOP;

  FOREACH t IN ARRAY b_tokens LOOP
    IF NOT (t = ANY (a_tokens)) THEN
      SELECT max(similarity(t, x)) INTO best_sim FROM unnest(a_tokens) AS x;
      IF coalesce(best_sim, 0) < 0.45 THEN
        v_diff := v_diff || t;
      END IF;
    END IF;
  END LOOP;

  IF array_length(a_tokens,1) <= array_length(b_tokens,1) THEN
    shorter := a_tokens; longer := b_tokens;
  ELSE
    shorter := b_tokens; longer := a_tokens;
  END IF;
  v_subset_match := true;
  FOREACH t IN ARRAY shorter LOOP
    IF t = ANY (longer) THEN
      CONTINUE;
    END IF;
    SELECT max(similarity(t, x)) INTO best_sim FROM unnest(longer) AS x;
    IF coalesce(best_sim, 0) < 0.45 THEN
      v_subset_match := false;
      EXIT;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'score', round((v_common / greatest(array_length(a_tokens,1), array_length(b_tokens,1)))::numeric, 2),
    'diff', to_jsonb(v_diff),
    'subset_match', v_subset_match
  );
END;
$function$;

-- ensure_payout_destination: use subset_match (not a perfect score) to decide
-- whether an already-verified destination should stay verified.
CREATE OR REPLACE FUNCTION public.ensure_payout_destination(p_user_id uuid, p_method text, p_momo_number text DEFAULT NULL::text, p_momo_name text DEFAULT NULL::text, p_provider text DEFAULT NULL::text, p_bank_name text DEFAULT NULL::text, p_bank_account_number text DEFAULT NULL::text, p_bank_account_name text DEFAULT NULL::text)
 RETURNS TABLE(id uuid, status text, decision_reason text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_key text := public.payout_destination_key(p_method, p_momo_number, p_bank_name, p_bank_account_number);
  v_type text := CASE WHEN lower(coalesce(p_method,'')) = 'mobile_money' THEN 'mobile_money' ELSE 'bank_transfer' END;
  v_name text := coalesce(nullif(btrim(coalesce(p_momo_name,'')), ''), nullif(btrim(coalesce(p_bank_account_name,'')), ''));
  v_id uuid;
  v_status text;
  v_reason text;
  v_prev_name text;
  v_id_name text;
  v_nid text;
  v_report jsonb;
  v_still_matches boolean;
  v_exempt boolean := public.is_partner_not_agent(p_user_id);
BEGIN
  IF v_key IS NULL THEN
    RETURN;
  END IF;

  SELECT p.national_id, coalesce(p.national_id_name, p.full_name)
    INTO v_nid, v_id_name
  FROM public.profiles p WHERE p.id = p_user_id;

  v_report := public.payout_name_match_report(v_id_name, v_name);
  -- A perfect (or unscored, e.g. no ID on file yet) match never re-opens a
  -- verified destination; only a genuine mismatch against the ID does. An
  -- extra/missing name part (subset_match) is not treated as a mismatch.
  v_still_matches := (v_report->>'score') IS NULL OR coalesce((v_report->>'subset_match')::boolean, false);

  SELECT d.id, d.status, d.account_name INTO v_id, v_status, v_prev_name
  FROM public.payout_destination_verifications d
  WHERE d.user_id = p_user_id AND d.destination_key = v_key;

  IF v_id IS NULL THEN
    INSERT INTO public.payout_destination_verifications (
      user_id, destination_type, destination_key, provider,
      momo_number, bank_name, bank_account_number, account_name,
      national_id, national_id_name, name_match_score, name_mismatch_tokens,
      status, decision_reason
    ) VALUES (
      p_user_id, v_type, v_key,
      CASE WHEN v_type = 'mobile_money' THEN lower(coalesce(p_provider,'')) ELSE 'bank' END,
      CASE WHEN v_type = 'mobile_money' THEN btrim(p_momo_number) END,
      CASE WHEN v_type = 'bank_transfer' THEN btrim(p_bank_name) END,
      CASE WHEN v_type = 'bank_transfer' THEN btrim(p_bank_account_number) END,
      v_name, v_nid, v_id_name,
      (v_report->>'score')::numeric, coalesce(v_report->'diff', '[]'::jsonb),
      CASE WHEN v_exempt THEN 'verified' ELSE 'waiting' END,
      CASE WHEN v_exempt THEN 'Auto-verified: partner with no agent activity is exempt from manual payout-destination verification.' ELSE NULL END
    )
    RETURNING payout_destination_verifications.id, payout_destination_verifications.status,
              payout_destination_verifications.decision_reason
      INTO v_id, v_status, v_reason;
  ELSE
    UPDATE public.payout_destination_verifications d
    SET account_name = coalesce(v_name, d.account_name),
        national_id = coalesce(v_nid, d.national_id),
        national_id_name = coalesce(v_id_name, d.national_id_name),
        name_match_score = (v_report->>'score')::numeric,
        name_mismatch_tokens = coalesce(v_report->'diff', '[]'::jsonb),
        status = CASE
          WHEN v_exempt AND d.status = 'waiting' THEN 'verified'
          WHEN d.status = 'verified'
               AND v_name IS NOT NULL
               AND NOT v_still_matches
               AND NOT v_exempt THEN 'waiting'
          WHEN d.status = 'rejected' AND NOT v_exempt THEN 'waiting'
          ELSE d.status END,
        decision_reason = CASE
          WHEN v_exempt AND d.status = 'waiting' THEN 'Auto-verified: partner with no agent activity is exempt from manual payout-destination verification.'
          WHEN d.status = 'verified'
               AND v_name IS NOT NULL
               AND NOT v_still_matches
               AND NOT v_exempt
          THEN 'Registered name no longer matches the verified identity — needs re-verification'
          WHEN d.status = 'rejected' AND NOT v_exempt
          THEN 'Resubmitted after rejection — needs Financial Ops re-review.'
          ELSE d.decision_reason END
    WHERE d.id = v_id
    RETURNING d.status, d.decision_reason INTO v_status, v_reason;
  END IF;

  RETURN QUERY SELECT v_id, v_status, v_reason;
END;
$function$;
