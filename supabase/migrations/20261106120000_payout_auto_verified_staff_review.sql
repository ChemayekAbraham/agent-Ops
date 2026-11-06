-- Payout destinations that the system verified on its own (decided_by is null) are now reviewed by a person after the fact,
-- so nobody's withdrawal waits on a call but nothing auto-verified goes unseen.
--
-- A separate review table, not a column on payout_destination_verifications: that table's triggers are in
-- critical_function_baselines and the queue/count functions are large and have drifted from the repo, so this
-- change touches none of them. The existing queue is unchanged; this adds one more list beside it.
--
--   finops_auto_verified_review_queue(search, limit, offset)   auto-verified, not yet reviewed, newest first
--   finops_auto_verified_review_count()                        how many are waiting for review
--   finops_mark_auto_verified_reviewed(destination_id, note)   a person confirms it; writes audit_logs
-- Roll back with 20261106120000_payout_auto_verified_staff_review.rollback.sql.

CREATE TABLE IF NOT EXISTS public.payout_destination_staff_reviews (
  destination_id uuid PRIMARY KEY REFERENCES public.payout_destination_verifications(id) ON DELETE CASCADE,
  reviewed_by    uuid NOT NULL,
  reviewed_at    timestamptz NOT NULL DEFAULT now(),
  note           text
);
ALTER TABLE public.payout_destination_staff_reviews ENABLE ROW LEVEL SECURITY;
-- No policies and no authenticated grant: the screen reads and writes only through the SECURITY DEFINER functions below.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.payout_destination_staff_reviews TO service_role;

CREATE OR REPLACE FUNCTION public.finops_auto_verified_review_count()
 RETURNS integer
 LANGUAGE plpgsql STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_uid uuid := auth.uid(); v_n integer;
BEGIN
  IF v_uid IS NULL OR NOT (public.has_role(v_uid, 'financial_ops') OR public.has_role(v_uid, 'cfo') OR public.has_role(v_uid, 'super_admin')) THEN
    RAISE EXCEPTION 'Financial Ops only.';
  END IF;
  SELECT count(*) INTO v_n
  FROM public.payout_destination_verifications d
  WHERE d.status = 'verified' AND d.decided_by IS NULL
    AND NOT EXISTS (SELECT 1 FROM public.payout_destination_staff_reviews r WHERE r.destination_id = d.id);
  RETURN v_n;
END $function$;

CREATE OR REPLACE FUNCTION public.finops_auto_verified_review_queue(p_search text DEFAULT NULL, p_limit integer DEFAULT 20, p_offset integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_uid uuid := auth.uid(); v_term text := nullif(btrim(coalesce(p_search, '')), ''); v_total integer; v_rows jsonb;
BEGIN
  IF v_uid IS NULL OR NOT (public.has_role(v_uid, 'financial_ops') OR public.has_role(v_uid, 'cfo') OR public.has_role(v_uid, 'super_admin')) THEN
    RAISE EXCEPTION 'Financial Ops only.';
  END IF;
  p_limit := least(greatest(coalesce(p_limit, 20), 1), 100);
  p_offset := greatest(coalesce(p_offset, 0), 0);

  WITH base AS (
    SELECT d.id, d.user_id, p.full_name, p.phone AS user_phone, d.destination_type, d.provider, d.momo_number,
           d.bank_name, d.bank_account_number, d.account_name, d.national_id_name, d.name_match_score,
           (d.ownership_code_confirmed_at IS NOT NULL) AS sms_code_confirmed,
           d.decided_at, d.first_seen_at, coalesce(w.withdrawable_balance, 0) AS withdrawable_balance
    FROM public.payout_destination_verifications d
    LEFT JOIN public.profiles p ON p.id = d.user_id
    LEFT JOIN public.wallets w ON w.user_id = d.user_id
    WHERE d.status = 'verified' AND d.decided_by IS NULL
      AND NOT EXISTS (SELECT 1 FROM public.payout_destination_staff_reviews r WHERE r.destination_id = d.id)
      AND (v_term IS NULL
           OR p.full_name ILIKE '%' || v_term || '%' OR p.phone ILIKE '%' || v_term || '%'
           OR d.account_name ILIKE '%' || v_term || '%' OR d.momo_number ILIKE '%' || v_term || '%'
           OR d.bank_account_number ILIKE '%' || v_term || '%')
  )
  SELECT (SELECT count(*) FROM base),
         coalesce(jsonb_agg(to_jsonb(pg)), '[]'::jsonb)
  INTO v_total, v_rows
  FROM (SELECT * FROM base ORDER BY decided_at DESC NULLS LAST, first_seen_at DESC LIMIT p_limit OFFSET p_offset) pg;

  RETURN jsonb_build_object('total', v_total, 'rows', v_rows);
END $function$;

CREATE OR REPLACE FUNCTION public.finops_mark_auto_verified_reviewed(p_destination_id uuid, p_note text DEFAULT NULL)
 RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_uid uuid := auth.uid(); v_user uuid;
BEGIN
  IF v_uid IS NULL OR NOT (public.has_role(v_uid, 'financial_ops') OR public.has_role(v_uid, 'cfo') OR public.has_role(v_uid, 'super_admin')) THEN
    RAISE EXCEPTION 'Financial Ops only.';
  END IF;
  SELECT user_id INTO v_user FROM public.payout_destination_verifications
   WHERE id = p_destination_id AND status = 'verified' AND decided_by IS NULL;
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'This number is not an auto-verified destination.';
  END IF;
  INSERT INTO public.payout_destination_staff_reviews (destination_id, reviewed_by, note)
  VALUES (p_destination_id, v_uid, nullif(btrim(coalesce(p_note, '')), ''))
  ON CONFLICT (destination_id) DO NOTHING;
  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, old_values, new_values)
  VALUES (v_uid, 'payout_auto_verified_reviewed', 'payout_destination_verifications', p_destination_id::text,
          coalesce(nullif(btrim(coalesce(p_note, '')), ''), 'Reviewed after automatic verification.'),
          jsonb_build_object('status', 'verified', 'decided_by', NULL),
          jsonb_build_object('holder_user_id', v_user, 'reviewed_by', v_uid));
END $function$;

REVOKE ALL ON FUNCTION public.finops_auto_verified_review_count(), public.finops_auto_verified_review_queue(text, integer, integer),
  public.finops_mark_auto_verified_reviewed(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.finops_auto_verified_review_count(), public.finops_auto_verified_review_queue(text, integer, integer),
  public.finops_mark_auto_verified_reviewed(uuid, text) TO authenticated;
