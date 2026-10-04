-- One National ID and one phone number may verify exactly ONE account.
-- The first account holding that ID / number is the only verifiable one; every
-- later account is filed as a "double submission" and auto-rejected on verify.

CREATE OR REPLACE FUNCTION public.identity_double_submission(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_nid text;
  v_phone text;
  v_first uuid;
  v_kind text;
  v_name text;
  v_first_phone text;
  v_first_nid text;
  v_created timestamptz;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object('is_double', false);
  END IF;

  SELECT upper(regexp_replace(coalesce(p.national_id,''), '[^A-Za-z0-9]', '', 'g')),
         right(regexp_replace(coalesce(p.phone,''), '[^0-9]', '', 'g'), 9)
    INTO v_nid, v_phone
  FROM public.profiles p
  WHERE p.id = p_user_id;

  IF length(coalesce(v_nid,'')) >= 6 THEN
    SELECT p.id INTO v_first
    FROM public.profiles p
    WHERE upper(regexp_replace(coalesce(p.national_id,''), '[^A-Za-z0-9]', '', 'g')) = v_nid
    ORDER BY (EXISTS (SELECT 1 FROM public.payout_destination_verifications d
                      WHERE d.user_id = p.id AND d.status = 'verified')) DESC,
             p.created_at ASC NULLS LAST, p.id ASC
    LIMIT 1;
    IF v_first IS NOT NULL AND v_first <> p_user_id THEN
      v_kind := 'national_id';
    END IF;
  END IF;

  IF v_kind IS NULL AND length(coalesce(v_phone,'')) >= 9 THEN
    v_first := NULL;
    SELECT p.id INTO v_first
    FROM public.profiles p
    WHERE right(regexp_replace(coalesce(p.phone,''), '[^0-9]', '', 'g'), 9) = v_phone
    ORDER BY (EXISTS (SELECT 1 FROM public.payout_destination_verifications d
                      WHERE d.user_id = p.id AND d.status = 'verified')) DESC,
             p.created_at ASC NULLS LAST, p.id ASC
    LIMIT 1;
    IF v_first IS NOT NULL AND v_first <> p_user_id THEN
      v_kind := 'phone';
    END IF;
  END IF;

  IF v_kind IS NULL THEN
    RETURN jsonb_build_object('is_double', false);
  END IF;

  SELECT p.full_name, p.phone, p.national_id, p.created_at
    INTO v_name, v_first_phone, v_first_nid, v_created
  FROM public.profiles p WHERE p.id = v_first;

  RETURN jsonb_build_object(
    'is_double', true,
    'kind', v_kind,
    'first_user_id', v_first,
    'first_name', v_name,
    'first_phone', v_first_phone,
    'first_national_id', v_first_nid,
    'first_created_at', v_created
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.identity_double_submission(uuid) TO authenticated;

-- Queue: new 'double' bucket, doubles filtered out of the working lists.
DROP FUNCTION IF EXISTS public.finops_payout_verification_queue(text, text, text, integer, integer, date, date, text);

CREATE FUNCTION public.finops_payout_verification_queue(
  p_status text DEFAULT 'waiting'::text,
  p_search text DEFAULT NULL::text,
  p_sort text DEFAULT 'ready_first'::text,
  p_limit integer DEFAULT 20,
  p_offset integer DEFAULT 0,
  p_date_from date DEFAULT NULL::date,
  p_date_to date DEFAULT NULL::date,
  p_user_type text DEFAULT NULL::text
)
RETURNS TABLE(
  id uuid, user_id uuid, full_name text, user_phone text, destination_type text, provider text,
  momo_number text, bank_name text, bank_account_number text, account_name text, national_id text,
  national_id_name text, name_match_score numeric, name_mismatch_tokens jsonb, status text,
  decision_reason text, call_outcome text, decided_by_name text, decided_at timestamp with time zone,
  first_seen_at timestamp with time zone, withdrawable_balance numeric, name_source text,
  duplicate_id_user_id uuid, duplicate_id_name text, duplicate_id_accounts jsonb,
  id_back_photo_ready boolean, double_submission boolean, double_kind text, double_of_user_id uuid,
  double_of_name text, total_count bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_status text := lower(coalesce(nullif(btrim(p_status),''), 'waiting'));
  v_q text := nullif(btrim(coalesce(p_search,'')), '');
  v_sort text := lower(coalesce(nullif(btrim(p_sort),''), 'ready_first'));
  v_type text := lower(coalesce(nullif(btrim(p_user_type),''), ''));
BEGIN
  IF v_uid IS NULL OR NOT (
    public.has_role(v_uid, 'financial_ops') OR public.has_role(v_uid, 'cfo') OR public.has_role(v_uid, 'super_admin')
  ) THEN
    RAISE EXCEPTION 'Financial Ops only.';
  END IF;

  RETURN QUERY
  WITH base AS (
    SELECT d.*, p.full_name, p.phone,
           coalesce(w.withdrawable_balance, 0) AS bal,
           dp.full_name AS decider_name,
           (p.national_id_photo_path IS NOT NULL AND p.selfie_photo_path IS NOT NULL) AS photos_ready,
           (nullif(btrim(coalesce(p.national_id_back_photo_path,'')), '') IS NOT NULL) AS back_ready,
           public.user_is_funder_with_portfolio(d.user_id) AS exempt,
           public.has_role(d.user_id, 'tenant') AS is_tenant,
           public.duplicate_national_id_owner(d.user_id, d.national_id) AS dup_user,
           public.identity_double_submission(d.user_id) AS dbl
    FROM public.payout_destination_verifications d
    LEFT JOIN public.profiles p ON p.id = d.user_id
    LEFT JOIN public.profiles dp ON dp.id = d.decided_by
    LEFT JOIN public.wallets w ON w.user_id = d.user_id
    WHERE (
        v_status = 'all'
        OR (v_status = 'double' AND d.status = 'waiting'
            AND (public.identity_double_submission(d.user_id) ->> 'is_double')::boolean)
        OR (v_status = 'mismatch' AND d.status = 'waiting' AND d.name_match_score IS NOT NULL AND d.name_match_score < 0.5
            AND NOT public.user_is_funder_with_portfolio(d.user_id)
            AND NOT (public.identity_double_submission(d.user_id) ->> 'is_double')::boolean)
        OR (v_status = 'no_id' AND d.status = 'waiting'
            AND NOT public.user_is_funder_with_portfolio(d.user_id)
            AND NOT (public.identity_double_submission(d.user_id) ->> 'is_double')::boolean
            AND NOT (p.national_id_photo_path IS NOT NULL AND p.selfie_photo_path IS NOT NULL))
        OR (v_status = 'waiting' AND d.status = 'waiting'
            AND NOT public.user_is_funder_with_portfolio(d.user_id)
            AND NOT (public.identity_double_submission(d.user_id) ->> 'is_double')::boolean
            AND p.national_id_photo_path IS NOT NULL AND p.selfie_photo_path IS NOT NULL)
        OR (v_status IN ('verified','rejected') AND d.status = v_status)
      )
      AND (
        v_q IS NULL
        OR p.full_name ILIKE '%' || v_q || '%'
        OR coalesce(d.account_name,'') ILIKE '%' || v_q || '%'
        OR coalesce(d.national_id,'') ILIKE '%' || v_q || '%'
        OR coalesce(d.momo_number,'') ILIKE '%' || v_q || '%'
        OR coalesce(d.bank_account_number,'') ILIKE '%' || v_q || '%'
        OR coalesce(p.phone,'') ILIKE '%' || v_q || '%'
      )
      AND (p_date_from IS NULL OR d.first_seen_at >= p_date_from::timestamptz)
      AND (p_date_to IS NULL OR d.first_seen_at < (p_date_to + 1)::timestamptz)
      AND (
        v_type = ''
        OR (v_type = 'funder' AND public.user_is_funder_with_portfolio(d.user_id))
        OR (v_type = 'tenant' AND public.has_role(d.user_id, 'tenant'))
        OR (v_type = 'other'
            AND NOT public.user_is_funder_with_portfolio(d.user_id)
            AND NOT public.has_role(d.user_id, 'tenant'))
      )
  ), counted AS (
    SELECT count(*) AS n FROM base
  )
  SELECT b.id, b.user_id, b.full_name, b.phone, b.destination_type, b.provider,
         b.momo_number, b.bank_name, b.bank_account_number, b.account_name,
         b.national_id, b.national_id_name, b.name_match_score, b.name_mismatch_tokens,
         b.status, b.decision_reason, b.call_outcome, b.decider_name, b.decided_at,
         b.first_seen_at, b.bal,
         CASE
           WHEN nullif(btrim(coalesce(b.final_name_override, '')), '') IS NOT NULL THEN 'verified'
           WHEN b.national_id_name IS NOT NULL AND btrim(b.national_id_name) <> ''
                AND lower(btrim(coalesce(b.full_name, ''))) = lower(btrim(b.national_id_name)) THEN 'national_id'
           ELSE NULL
         END AS name_source,
         b.dup_user,
         (SELECT dpp.full_name FROM public.profiles dpp WHERE dpp.id = b.dup_user),
         CASE
           WHEN length(regexp_replace(upper(coalesce(b.national_id,'')), '[^A-Z0-9]', '', 'g')) >= 6 THEN (
             SELECT coalesce(jsonb_agg(jsonb_build_object(
                      'user_id', o.id,
                      'full_name', o.full_name,
                      'phone', o.phone,
                      'national_id', o.national_id,
                      'created_at', o.created_at
                    ) ORDER BY o.full_name NULLS LAST), '[]'::jsonb)
             FROM public.profiles o
             WHERE o.id <> b.user_id
               AND regexp_replace(upper(coalesce(o.national_id,'')), '[^A-Z0-9]', '', 'g')
                   = regexp_replace(upper(coalesce(b.national_id,'')), '[^A-Z0-9]', '', 'g')
           )
           ELSE '[]'::jsonb
         END AS duplicate_id_accounts,
         coalesce(b.back_ready, false),
         coalesce((b.dbl ->> 'is_double')::boolean, false),
         b.dbl ->> 'kind',
         nullif(b.dbl ->> 'first_user_id','')::uuid,
         b.dbl ->> 'first_name',
         c.n
  FROM base b CROSS JOIN counted c
  ORDER BY
    CASE WHEN v_sort = 'ready_first' THEN (b.photos_ready::int) END DESC,
    CASE WHEN v_sort IN ('ready_first','newest') THEN coalesce(b.national_id_submitted_at, b.first_seen_at) END DESC NULLS LAST,
    CASE WHEN v_sort = 'balance' THEN b.bal END DESC NULLS LAST,
    CASE WHEN v_sort = 'oldest' THEN b.first_seen_at END ASC NULLS LAST,
    b.first_seen_at ASC
  LIMIT greatest(1, least(coalesce(p_limit,20), 100))
  OFFSET greatest(0, coalesce(p_offset,0));
END;
$function$;

GRANT EXECUTE ON FUNCTION public.finops_payout_verification_queue(text, text, text, integer, integer, date, date, text) TO authenticated;

-- Counts: doubles get their own tally and leave the working buckets.
CREATE OR REPLACE FUNCTION public.finops_payout_verification_counts()
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_out jsonb;
BEGIN
  IF v_uid IS NULL OR NOT (
    public.has_role(v_uid, 'financial_ops') OR public.has_role(v_uid, 'cfo') OR public.has_role(v_uid, 'super_admin')
  ) THEN
    RAISE EXCEPTION 'Financial Ops only.';
  END IF;

  SELECT jsonb_build_object(
    'waiting', count(*) FILTER (WHERE d.status = 'waiting' AND submitted AND NOT exempt AND NOT is_double),
    'verified', count(*) FILTER (WHERE d.status = 'verified'),
    'rejected', count(*) FILTER (WHERE d.status = 'rejected'),
    'mismatch', count(*) FILTER (WHERE d.status = 'waiting' AND NOT exempt AND NOT is_double
                                   AND d.name_match_score IS NOT NULL AND d.name_match_score < 0.5),
    'no_id', count(*) FILTER (WHERE d.status = 'waiting' AND NOT exempt AND NOT is_double AND NOT submitted),
    'double', count(*) FILTER (WHERE d.status = 'waiting' AND is_double),
    'waiting_balance', coalesce(sum(CASE WHEN d.status = 'waiting' AND submitted AND NOT exempt AND NOT is_double
      THEN (SELECT coalesce(w.withdrawable_balance,0) FROM public.wallets w WHERE w.user_id = d.user_id) END), 0)
  ) INTO v_out
  FROM public.payout_destination_verifications d
  CROSS JOIN LATERAL (
    SELECT (p.national_id_photo_path IS NOT NULL AND p.selfie_photo_path IS NOT NULL) AS submitted,
           public.user_is_funder_with_portfolio(d.user_id) AS exempt,
           coalesce((public.identity_double_submission(d.user_id) ->> 'is_double')::boolean, false) AS is_double
    FROM public.profiles p WHERE p.id = d.user_id
  ) f;

  RETURN v_out;
END;
$function$;

-- Verify auto-rejects any account that is not the first holder of the ID / number.
CREATE OR REPLACE FUNCTION public.finops_decide_payout_destination(p_id uuid, p_decision text, p_reason text, p_call_outcome text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_decision text := lower(btrim(coalesce(p_decision,'')));
  v_reason text := btrim(coalesce(p_reason,''));
  v_row public.payout_destination_verifications;
  v_id_name text;
  v_old_name text;
  v_source text;
  v_dup uuid;
  v_dup_name text;
  v_unreadable boolean := false;
  v_back text;
  v_dbl jsonb;
  v_double boolean := false;
  v_back_cutoff constant timestamptz := timestamptz '2026-09-14 14:00:00+00';
BEGIN
  IF v_uid IS NULL OR NOT (
    public.has_role(v_uid, 'financial_ops') OR public.has_role(v_uid, 'cfo') OR public.has_role(v_uid, 'super_admin')
  ) THEN
    RAISE EXCEPTION 'Only Financial Ops can verify payout destinations.';
  END IF;
  IF v_decision NOT IN ('verified','rejected') THEN
    RAISE EXCEPTION 'Decision must be verified or rejected.';
  END IF;
  IF length(v_reason) < 10 THEN
    RAISE EXCEPTION 'Write at least 10 characters explaining the decision.';
  END IF;

  SELECT * INTO v_row FROM public.payout_destination_verifications WHERE id = p_id;
  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'Destination not found.';
  END IF;
  IF v_row.user_id = v_uid THEN
    RAISE EXCEPTION 'You cannot verify your own payout destination.';
  END IF;

  IF v_decision = 'verified'
     AND coalesce(v_row.national_id_submitted_at, v_row.first_seen_at) >= v_back_cutoff THEN
    SELECT nullif(btrim(coalesce(national_id_back_photo_path,'')), '') INTO v_back
    FROM public.profiles WHERE id = v_row.user_id;
    IF v_back IS NULL THEN
      RAISE EXCEPTION 'Cannot verify — the back of the National ID is missing. Ask the user to upload a photo of the back of their National ID.';
    END IF;
  END IF;

  -- Double submission: one National ID and one phone number verify one account only.
  v_dbl := public.identity_double_submission(v_row.user_id);
  IF v_decision = 'verified' AND coalesce((v_dbl ->> 'is_double')::boolean, false) THEN
    v_double := true;
    v_decision := 'rejected';
    v_reason := 'Automatically rejected as a double submission: this '
                || CASE WHEN v_dbl ->> 'kind' = 'phone' THEN 'phone number' ELSE 'National ID' END
                || ' already verifies another account ('
                || coalesce(nullif(btrim(coalesce(v_dbl ->> 'first_name','')), ''), 'unnamed account')
                || '). Only the first account may use it.';
  END IF;

  v_dup := public.duplicate_national_id_owner(v_row.user_id, v_row.national_id);
  IF v_dup IS NOT NULL AND v_decision = 'verified' THEN
    SELECT full_name INTO v_dup_name FROM public.profiles WHERE id = v_dup;
    v_decision := 'rejected';
    v_reason := 'Automatically rejected: this National ID is already recorded on another account ('
                || coalesce(v_dup_name, 'unnamed account') || '). One National ID may only be used by one account.';
  END IF;

  IF v_decision = 'verified' THEN
    v_id_name := btrim(coalesce(nullif(btrim(coalesce(v_row.final_name_override,'')), ''), v_row.national_id_name, ''));
    IF length(v_id_name) < 3 THEN
      v_unreadable := true;
      v_decision := 'rejected';
      v_reason := 'Automatically rejected: no name could be read on the National ID photo. Ask the user to submit a clearer photo of their National ID.';
    END IF;
  END IF;

  UPDATE public.payout_destination_verifications
  SET status = v_decision,
      decision_reason = v_reason,
      call_outcome = nullif(btrim(coalesce(p_call_outcome,'')), ''),
      decided_by = v_uid,
      decided_at = now()
  WHERE id = p_id;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, old_values, new_values)
  VALUES (v_uid, 'payout_destination_' || v_decision, 'payout_destination_verifications', p_id::text, v_reason,
          jsonb_build_object('status', v_row.status),
          jsonb_build_object('status', v_decision, 'call_outcome', p_call_outcome, 'owner', v_row.user_id,
                             'duplicate_of_user_id', v_dup,
                             'auto_rejected_double_submission', v_double,
                             'double_submission', v_dbl,
                             'auto_rejected_unreadable_id_name', v_unreadable));

  IF v_decision = 'verified' THEN
    v_id_name := btrim(coalesce(nullif(btrim(coalesce(v_row.final_name_override,'')), ''), v_row.national_id_name, ''));
    v_source := CASE WHEN nullif(btrim(coalesce(v_row.final_name_override,'')), '') IS NOT NULL
                     THEN 'financial_ops_manual_override' ELSE 'national_id_ocr' END;
    IF length(v_id_name) >= 3 THEN
      SELECT full_name INTO v_old_name FROM public.profiles WHERE id = v_row.user_id;
      IF v_old_name IS DISTINCT FROM v_id_name THEN
        UPDATE public.profiles SET full_name = v_id_name WHERE id = v_row.user_id;
        INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, old_values, new_values)
        VALUES (v_uid, 'payout_holder_name_from_national_id', 'profiles', v_row.user_id::text,
                'Verified holder name applied during payout verification.',
                jsonb_build_object('full_name', v_old_name),
                jsonb_build_object('full_name', v_id_name, 'source', v_source));
      END IF;
    END IF;
  END IF;

  BEGIN
    INSERT INTO public.system_events (event_type, user_id, metadata)
    VALUES ('account_flagged', v_row.user_id,
            jsonb_build_object('kind', 'payout_destination_' || v_decision,
                               'destination_key', v_row.destination_key,
                               'decided_by', v_uid));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN jsonb_build_object(
    'success', true,
    'status', v_decision,
    'auto_rejected_duplicate_id', v_dup IS NOT NULL,
    'auto_rejected_double_submission', v_double,
    'double_submission_kind', v_dbl ->> 'kind',
    'double_of_name', v_dbl ->> 'first_name',
    'auto_rejected_unreadable_id_name', v_unreadable,
    'duplicate_of_name', v_dup_name,
    'full_name', CASE WHEN v_decision = 'verified' AND length(coalesce(v_id_name,'')) >= 3 THEN v_id_name ELSE NULL END,
    'name_source', CASE WHEN v_decision = 'verified' AND length(coalesce(v_id_name,'')) >= 3
                        THEN CASE WHEN v_source = 'financial_ops_manual_override' THEN 'verified' ELSE 'national_id' END
                        ELSE NULL END
  );
END;
$function$;
