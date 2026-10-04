-- Fix: finops_payout_verification_queue timing out again (57014, statement timeout)
-- on the FinOps payout verification queue, ~2 days after the last fix for it
-- (20260915160000_index_national_id_normalized_lookup.sql) landed.
--
-- Root cause (confirmed live via EXPLAIN ANALYZE against production, 96,651-row
-- profiles table): public.v_identity_double_users is a plain (non-materialized) view
-- that recomputes a full duplicate-identity sweep from scratch on every call --
-- national-ID fuzzy match, face-hash dedupe, ID-photo-hash dedupe, and phone-last-9
-- dedupe, each as its own window-function pass over ALL of public.profiles, plus a
-- correlated self-join for the national-ID branch. This is a *different* bottleneck
-- than the one the Sept 15 fix addressed (duplicate_national_id_owner() lookups),
-- and the indexes added then don't touch it -- it's CPU-bound (regexp/translate over
-- the whole table on every call), not a missing-index problem.
--
-- Both public.finops_payout_verification_queue AND public.finops_payout_verification_counts
-- LEFT JOIN this view, and finops_payout_verification_queue's own un-paginated
-- `counted` CTE forces a full evaluation of it regardless of page size. Measured in
-- isolation this view costs ~2.1-2.8s per call; combined with the rest of either
-- query it eats most of the `authenticated` role's 8s statement_timeout
-- (SELECT rolconfig FROM pg_roles WHERE rolname = 'authenticated' -> statement_timeout=8s),
-- and tips over under a cold cache or normal load, exactly as reported.
--
-- Fix: materialize the view and refresh it on a 5-minute cron cadence, following the
-- same pattern already used for mv_house_location_rollup / mv_ops_daily_summary /
-- wallet totals cache, then repoint both FinOps RPCs at the materialized view. This
-- trades up to 5 minutes of staleness on duplicate-identity flags for the payout
-- queue -- acceptable, since these are manual-review flags for FinOps staff, not a
-- real-time gate -- for the page actually loading inside the statement timeout.
-- Purely additive/repointing: no filtering logic, columns, or output shape changes.

CREATE MATERIALIZED VIEW public.mv_identity_double_users AS
SELECT * FROM public.v_identity_double_users;

CREATE UNIQUE INDEX idx_mv_identity_double_users_user_id
  ON public.mv_identity_double_users (user_id);

CREATE OR REPLACE FUNCTION public.refresh_mv_identity_double_users()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_identity_double_users;
END;
$function$;

SELECT cron.schedule(
  'refresh-identity-double-users-5m',
  '*/5 * * * *',
  $$SELECT public.refresh_mv_identity_double_users();$$
);

-- Repoint the two hot-path FinOps RPCs at the materialized view. Bodies are
-- otherwise byte-identical to the live versions confirmed via pg_get_functiondef --
-- only the LEFT JOIN target changes from v_identity_double_users to
-- mv_identity_double_users.

CREATE OR REPLACE FUNCTION public.finops_payout_verification_queue(p_status text DEFAULT 'waiting'::text, p_search text DEFAULT NULL::text, p_sort text DEFAULT 'ready_first'::text, p_limit integer DEFAULT 20, p_offset integer DEFAULT 0, p_date_from date DEFAULT NULL::date, p_date_to date DEFAULT NULL::date, p_user_type text DEFAULT NULL::text)
 RETURNS TABLE(id uuid, user_id uuid, full_name text, user_phone text, destination_type text, provider text, momo_number text, bank_name text, bank_account_number text, account_name text, national_id text, national_id_name text, name_match_score numeric, name_mismatch_tokens jsonb, status text, decision_reason text, call_outcome text, decided_by_name text, decided_at timestamp with time zone, first_seen_at timestamp with time zone, withdrawable_balance numeric, name_source text, duplicate_id_user_id uuid, duplicate_id_name text, duplicate_id_accounts jsonb, id_back_photo_ready boolean, double_submission boolean, double_kind text, double_of_user_id uuid, double_of_name text, total_count bigint, id_account_count integer, id_account_ordinal integer, payout_number_count integer, verified_payout_count integer, verified_payout_numbers jsonb)
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
          WHERE v.user_id = b.user_id AND v.status = 'verified' AND v.id <> b.id) AS verified_payout_numbers
  FROM page b CROSS JOIN counted c
  ORDER BY
    CASE WHEN v_sort = 'ready_first' THEN (b.photos_ready::int) END DESC,
    CASE WHEN v_sort IN ('ready_first','newest') THEN coalesce(b.national_id_submitted_at, b.first_seen_at) END DESC NULLS LAST,
    CASE WHEN v_sort = 'balance' THEN b.bal END DESC NULLS LAST,
    CASE WHEN v_sort = 'oldest' THEN b.first_seen_at END ASC NULLS LAST,
    b.first_seen_at ASC;
END;
$function$;

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

  WITH funders AS (
    SELECT DISTINCT ip.investor_id AS user_id
    FROM public.investor_portfolios ip
    WHERE lower(coalesce(ip.status, '')) NOT IN ('cancelled', 'rejected', 'deleted')
  ), rws AS (
    SELECT d.status,
           d.name_match_score,
           coalesce(w.withdrawable_balance, 0) AS bal,
           (p.national_id_photo_path IS NOT NULL AND p.selfie_photo_path IS NOT NULL) AS submitted,
           (f.user_id IS NOT NULL) AS exempt,
           (x.user_id IS NOT NULL) AS is_double
    FROM public.payout_destination_verifications d
    LEFT JOIN public.profiles p ON p.id = d.user_id
    LEFT JOIN public.wallets w ON w.user_id = d.user_id
    LEFT JOIN funders f ON f.user_id = d.user_id
    LEFT JOIN public.mv_identity_double_users x ON x.user_id = d.user_id
  )
  SELECT jsonb_build_object(
    'waiting',  count(*) FILTER (WHERE status = 'waiting' AND submitted AND NOT exempt AND NOT is_double),
    'verified', count(*) FILTER (WHERE status = 'verified'),
    'rejected', count(*) FILTER (WHERE status = 'rejected'),
    'mismatch', count(*) FILTER (WHERE status = 'waiting' AND NOT exempt AND NOT is_double
                                   AND name_match_score IS NOT NULL AND name_match_score < 0.5),
    'no_id',    count(*) FILTER (WHERE status = 'waiting' AND NOT exempt AND NOT is_double AND NOT submitted),
    'double',   count(*) FILTER (WHERE status = 'waiting' AND is_double),
    'waiting_balance', coalesce(sum(CASE WHEN status = 'waiting' AND submitted AND NOT exempt AND NOT is_double
                                        THEN bal END), 0)
  ) INTO v_out
  FROM rws;

  RETURN v_out;
END;
$function$;
