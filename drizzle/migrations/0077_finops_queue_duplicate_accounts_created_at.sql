CREATE OR REPLACE FUNCTION public.finops_payout_verification_queue(p_status text DEFAULT 'waiting'::text, p_search text DEFAULT NULL::text, p_sort text DEFAULT 'ready_first'::text, p_limit integer DEFAULT 20, p_offset integer DEFAULT 0)
 RETURNS TABLE(id uuid, user_id uuid, full_name text, user_phone text, destination_type text, provider text, momo_number text, bank_name text, bank_account_number text, account_name text, national_id text, national_id_name text, name_match_score numeric, name_mismatch_tokens jsonb, status text, decision_reason text, call_outcome text, decided_by_name text, decided_at timestamp with time zone, first_seen_at timestamp with time zone, withdrawable_balance numeric, name_source text, duplicate_id_user_id uuid, duplicate_id_name text, duplicate_id_accounts jsonb, total_count bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_status text := lower(coalesce(nullif(btrim(p_status),''), 'waiting'));
  v_q text := nullif(btrim(coalesce(p_search,'')), '');
  v_sort text := lower(coalesce(nullif(btrim(p_sort),''), 'ready_first'));
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
           public.duplicate_national_id_owner(d.user_id, d.national_id) AS dup_user
    FROM public.payout_destination_verifications d
    LEFT JOIN public.profiles p ON p.id = d.user_id
    LEFT JOIN public.profiles dp ON dp.id = d.decided_by
    LEFT JOIN public.wallets w ON w.user_id = d.user_id
    WHERE (
        v_status = 'all'
        OR (v_status = 'mismatch' AND d.status = 'waiting' AND d.name_match_score IS NOT NULL AND d.name_match_score < 0.5)
        OR (v_status = 'no_id' AND d.status = 'waiting' AND coalesce(btrim(d.national_id), '') = '')
        OR (v_status IN ('waiting','verified','rejected') AND d.status = v_status)
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