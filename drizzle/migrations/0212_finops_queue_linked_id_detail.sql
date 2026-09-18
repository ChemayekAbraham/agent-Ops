DROP FUNCTION public.finops_payout_verification_queue(text,text,text,integer,integer,date,date,text);

CREATE FUNCTION public.finops_payout_verification_queue(p_status text DEFAULT 'waiting'::text, p_search text DEFAULT NULL::text, p_sort text DEFAULT 'ready_first'::text, p_limit integer DEFAULT 20, p_offset integer DEFAULT 0, p_date_from date DEFAULT NULL::date, p_date_to date DEFAULT NULL::date, p_user_type text DEFAULT NULL::text)
 RETURNS TABLE(id uuid, user_id uuid, full_name text, user_phone text, destination_type text, provider text, momo_number text, bank_name text, bank_account_number text, account_name text, national_id text, national_id_name text, name_match_score numeric, name_mismatch_tokens jsonb, status text, decision_reason text, call_outcome text, decided_by_name text, decided_at timestamp with time zone, first_seen_at timestamp with time zone, withdrawable_balance numeric, name_source text, duplicate_id_user_id uuid, duplicate_id_name text, duplicate_id_accounts jsonb, id_back_photo_ready boolean, double_submission boolean, double_kind text, double_of_user_id uuid, double_of_name text, total_count bigint, id_account_count integer, id_account_ordinal integer, payout_number_count integer, verified_payout_count integer, verified_payout_numbers jsonb, is_linked_id boolean, linked_id_is_this_one boolean, linked_id_holder text)
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
  WITH funders AS (
    SELECT DISTINCT ip.investor_id AS user_id
    FROM public.investor_portfolios ip
    WHERE lower(coalesce(ip.status, '')) NOT IN ('cancelled', 'rejected', 'deleted')
  ), base AS (
    SELECT d.*, p.full_name, p.phone, p.created_at AS profile_created_at,
           p.linked_national_id AS profile_linked_id,
           coalesce(w.withdrawable_balance, 0) AS bal,
           (p.national_id_photo_path IS NOT NULL AND p.selfie_photo_path IS NOT NULL) AS photos_ready,
           (nullif(btrim(coalesce(p.national_id_back_photo_path,'')), '') IS NOT NULL) AS back_ready,
           (f.user_id IS NOT NULL) AS exempt,
           (x.user_id IS NOT NULL) AS is_double,
           x.kind AS dbl_kind,
           x.first_user_id AS dbl_first
    FROM public.payout_destination_verifications d
    LEFT JOIN public.profiles p ON p.id = d.user_id
    LEFT JOIN public.wallets w ON w.user_id = d.user_id
    LEFT JOIN funders f ON f.user_id = d.user_id
    LEFT JOIN public.mv_identity_double_users x ON x.user_id = d.user_id
    WHERE (
        v_status = 'all'
        OR (v_status = 'double' AND d.status = 'waiting' AND x.user_id IS NOT NULL)
        OR (v_status = 'mismatch' AND d.status = 'waiting' AND d.name_match_score IS NOT NULL
            AND d.name_match_score < 0.5 AND f.user_id IS NULL AND x.user_id IS NULL)
        OR (v_status = 'no_id' AND d.status = 'waiting' AND f.user_id IS NULL AND x.user_id IS NULL
            AND NOT (p.national_id_photo_path IS NOT NULL AND p.selfie_photo_path IS NOT NULL))
        OR (v_status = 'waiting' AND d.status = 'waiting' AND f.user_id IS NULL AND x.user_id IS NULL
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
        OR (v_type = 'funder' AND f.user_id IS NOT NULL)
        OR (v_type = 'tenant' AND public.has_role(d.user_id, 'tenant'))
        OR (v_type = 'other' AND f.user_id IS NULL AND NOT public.has_role(d.user_id, 'tenant'))
      )
  ), counted AS (
    SELECT count(*) AS n FROM base
  ), page AS (
    SELECT b.* FROM base b
    ORDER BY
      CASE WHEN v_sort = 'ready_first' THEN (b.photos_ready::int) END DESC,
      CASE WHEN v_sort IN ('ready_first','newest') THEN coalesce(b.national_id_submitted_at, b.first_seen_at) END DESC NULLS LAST,
      CASE WHEN v_sort = 'balance' THEN b.bal END DESC NULLS LAST,
      CASE WHEN v_sort = 'oldest' THEN b.first_seen_at END ASC NULLS LAST,
      b.first_seen_at ASC
    LIMIT greatest(1, least(coalesce(p_limit,20), 100))
    OFFSET greatest(0, coalesce(p_offset,0))
  )
  SELECT b.id, b.user_id, b.full_name, b.phone, b.destination_type, b.provider,
         b.momo_number, b.bank_name, b.bank_account_number, b.account_name,
         b.national_id, b.national_id_name, b.name_match_score, b.name_mismatch_tokens,
         b.status, b.decision_reason, b.call_outcome,
         (SELECT dp.full_name FROM public.profiles dp WHERE dp.id = b.decided_by),
         b.decided_at,
         b.first_seen_at, b.bal,
         CASE
           WHEN nullif(btrim(coalesce(b.final_name_override, '')), '') IS NOT NULL THEN 'verified'
           WHEN b.national_id_name IS NOT NULL AND btrim(b.national_id_name) <> ''
                AND lower(btrim(coalesce(b.full_name, ''))) = lower(btrim(b.national_id_name)) THEN 'national_id'
           ELSE NULL
         END AS name_source,
         public.duplicate_national_id_owner(b.user_id, b.national_id) AS dup_user,
         (SELECT dpp.full_name FROM public.profiles dpp
           WHERE dpp.id = public.duplicate_national_id_owner(b.user_id, b.national_id)),
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
         b.is_double,
         b.dbl_kind,
         b.dbl_first,
         (SELECT fp.full_name FROM public.profiles fp WHERE fp.id = b.dbl_first),
         c.n,
         CASE
           WHEN length(regexp_replace(upper(coalesce(b.national_id,'')), '[^A-Z0-9]', '', 'g')) >= 6 THEN (
             SELECT count(*)::int FROM public.profiles o
             WHERE regexp_replace(upper(coalesce(o.national_id,'')), '[^A-Z0-9]', '', 'g')
                 = regexp_replace(upper(coalesce(b.national_id,'')), '[^A-Z0-9]', '', 'g')
           )
           ELSE 1
         END AS id_account_count,
         CASE
           WHEN length(regexp_replace(upper(coalesce(b.national_id,'')), '[^A-Z0-9]', '', 'g')) >= 6 THEN (
             SELECT count(*)::int FROM public.profiles o
             WHERE regexp_replace(upper(coalesce(o.national_id,'')), '[^A-Z0-9]', '', 'g')
                 = regexp_replace(upper(coalesce(b.national_id,'')), '[^A-Z0-9]', '', 'g')
               AND o.created_at <= b.profile_created_at
           )
           ELSE 1
         END AS id_account_ordinal,
         (SELECT count(*)::int FROM public.payout_destination_verifications v
           WHERE v.user_id = b.user_id) AS payout_number_count,
         (SELECT count(*)::int FROM public.payout_destination_verifications v
           WHERE v.user_id = b.user_id AND v.status = 'verified' AND v.id <> b.id) AS verified_payout_count,
         (SELECT coalesce(jsonb_agg(jsonb_build_object(
                   'provider', v.provider,
                   'destination_type', v.destination_type,
                   'momo_number', v.momo_number,
                   'bank_name', v.bank_name,
                   'bank_account_number', v.bank_account_number,
                   'account_name', v.account_name,
                   'decided_at', v.decided_at
                 ) ORDER BY v.decided_at ASC NULLS LAST), '[]'::jsonb)
          FROM public.payout_destination_verifications v
          WHERE v.user_id = b.user_id AND v.status = 'verified' AND v.id <> b.id) AS verified_payout_numbers,
         (nullif(btrim(coalesce(b.profile_linked_id,'')), '') IS NOT NULL) AS is_linked_id,
         (nullif(btrim(coalesce(b.profile_linked_id,'')), '') IS NOT NULL
           AND public.normalize_national_id_fuzzy(b.profile_linked_id)
               = public.normalize_national_id_fuzzy(b.national_id)) AS linked_id_is_this_one,
         (SELECT hp.full_name FROM public.profiles hp
           WHERE nullif(btrim(coalesce(b.profile_linked_id,'')), '') IS NOT NULL
             AND public.normalize_national_id_fuzzy(hp.national_id)
                 = public.normalize_national_id_fuzzy(b.profile_linked_id)
           ORDER BY hp.created_at ASC
           LIMIT 1) AS linked_id_holder
  FROM page b CROSS JOIN counted c
  ORDER BY
    CASE WHEN v_sort = 'ready_first' THEN (b.photos_ready::int) END DESC,
    CASE WHEN v_sort IN ('ready_first','newest') THEN coalesce(b.national_id_submitted_at, b.first_seen_at) END DESC NULLS LAST,
    CASE WHEN v_sort = 'balance' THEN b.bal END DESC NULLS LAST,
    CASE WHEN v_sort = 'oldest' THEN b.first_seen_at END ASC NULLS LAST,
    b.first_seen_at ASC;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.finops_payout_verification_queue(text,text,text,integer,integer,date,date,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.finops_payout_verification_queue(text,text,text,integer,integer,date,date,text) TO service_role;