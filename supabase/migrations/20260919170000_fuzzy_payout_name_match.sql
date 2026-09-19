-- Real incident 2026-09-18/19: Kwenseri Rogers' payout destination was
-- verified once, then silently demoted back to 'waiting' ("Registered name
-- no longer matches the verified identity") on EVERY subsequent withdrawal
-- attempt, because ensure_payout_destination's "still matches" check
-- requires payout_name_match_report to return a perfect score of 1 — and his
-- registered mobile money name ("kwenseri Rodgers") will never exactly-match
-- his National ID name ("KWENSERI ROGERS") under the old exact-token
-- comparison. This is the same class of gap flagged earlier for
-- "Immeculate"/"Immaculate": ordinary spelling variance in Ugandan names
-- gets treated as a hard mismatch, forcing a manual Financial Ops re-review
-- every single time instead of once.
--
-- payout_name_match_report now scores a token pair as matching when they are
-- either identical OR sufficiently similar by trigram similarity (pg_trgm,
-- already installed). Threshold 0.45 chosen from live samples on this
-- database: rogers/rodgers=0.50, immeculate/immaculate=0.57,
-- ssebunya/sebunya=0.70, joshuah/joshua=0.67, peters/peter=0.63 all clear it;
-- genuinely different names stay well below it (john/james=0.10,
-- moses/moris=0.20, mary/mercy=0.10, brian/brain=0.20).
--
-- This function is the single source of truth for six call sites
-- (auto_verify_matching_payout_destinations, ensure_payout_destination,
-- finops_decide_payout_destination, submit_identity_photos,
-- submit_national_id, submit_national_id_details) — fixing it here fixes the
-- re-verification-demotion bug AND raises auto-verify coverage for this
-- class of name everywhere at once.
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
  bt text;
  best_sim numeric;
BEGIN
  IF coalesce(btrim(p_a),'') = '' OR coalesce(btrim(p_b),'') = '' THEN
    RETURN jsonb_build_object('score', NULL, 'diff', '[]'::jsonb);
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
    RETURN jsonb_build_object('score', NULL, 'diff', '[]'::jsonb);
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

  RETURN jsonb_build_object(
    'score', round((v_common / greatest(array_length(a_tokens,1), array_length(b_tokens,1)))::numeric, 2),
    'diff', to_jsonb(v_diff)
  );
END;
$function$;
