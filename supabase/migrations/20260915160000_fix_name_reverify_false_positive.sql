-- Bug: "THIS AGENT WAS NOT AUTO VERIFIED" — Nattu Sharifah's momo:781515171
-- destination was previously verified, then bounced back to 'waiting' with
-- reason "Account name changed after verification — needs re-verification",
-- even though payout_name_match_report('NATTU SHARIFAH', 'sharifah Nattu')
-- scores a perfect 1.00 (order/case-independent token match) — confirmed
-- live against production 2026-09-15.
--
-- Root cause: ensure_payout_destination() re-opens a verified destination
-- whenever the newly-submitted account name differs from the PREVIOUSLY
-- SUBMITTED name by a raw `lower(old) <> lower(new)` string comparison.
-- That catches a harmless re-entry of the same identity in a different
-- word order or case ("NATTU SHARIFAH" -> "sharifah Nattu") exactly the
-- same as a genuine identity change ("NATTU SHARIFAH" -> "JOHN DOE") —
-- the two are indistinguishable to a literal string comparison, so every
-- reformatting kicks a perfectly-fine, already-verified destination back
-- into the manual Financial Ops call queue for no reason.
--
-- Fix: re-open for re-verification based on whether the newly-submitted
-- name still matches the holder's National ID / profile name (the same
-- payout_name_match_report already computed a few lines above for
-- name_match_score) rather than whether it matches what was submitted
-- last time. This is also the more correct signal for what re-verification
-- is actually meant to catch: has this destination's registered name
-- drifted away from the verified identity, not "did the exact string
-- change". A harmless reordering keeps a perfect score and stays verified;
-- a genuine identity change breaks the match and correctly re-opens.

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
  -- verified destination; only a genuine mismatch against the ID does.
  v_still_matches := (v_report->>'score') IS NULL OR (v_report->>'score')::numeric >= 1;

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
          ELSE d.status END,
        decision_reason = CASE
          WHEN v_exempt AND d.status = 'waiting' THEN 'Auto-verified: partner with no agent activity is exempt from manual payout-destination verification.'
          WHEN d.status = 'verified'
               AND v_name IS NOT NULL
               AND NOT v_still_matches
               AND NOT v_exempt
          THEN 'Registered name no longer matches the verified identity — needs re-verification'
          ELSE d.decision_reason END
    WHERE d.id = v_id
    RETURNING d.status, d.decision_reason INTO v_status, v_reason;
  END IF;

  RETURN QUERY SELECT v_id, v_status, v_reason;
END;
$function$;

-- One-time repair: the one existing row this exact false-positive already
-- hit (Nattu Sharifah, momo:781515171) — its score is a confirmed perfect
-- match, so restore it to verified rather than leaving it stuck for a
-- Financial Ops call it doesn't need. Scoped tightly to rows carrying this
-- exact stale reason AND a perfect current name_match_score, so this can
-- never touch a destination with a genuine mismatch.
UPDATE public.payout_destination_verifications
SET status = 'verified',
    decision_reason = 'Auto-verified: re-checked after the name re-verification bug fix — name matches the verified identity (score 1.00).'
WHERE status = 'waiting'
  AND decision_reason = 'Account name changed after verification — needs re-verification'
  AND name_match_score = 1;
