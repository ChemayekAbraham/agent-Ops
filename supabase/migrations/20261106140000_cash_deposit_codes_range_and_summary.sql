-- Cash Deposit Codes: server-side date range, filters, paging and totals.
--
-- WHY: fin_ops_recent_cash_codes returns at most 200 rows, so the screen time chips (Today / 7 days / 30 days / All time)
-- could not be honest and its totals only covered whatever 50 rows were loaded. These two functions filter and total in the
-- database over the whole range. They are read-only and leave fin_ops_recent_cash_codes untouched (the Overview tile and
-- older builds still call it).
--
--   fin_ops_cash_codes_page(from, to, status, location, search, limit, offset)   one page of deposits + total_count
--   fin_ops_cash_codes_summary(from, to)                                         totals, counts and a per-day series
--
-- Notes
--   * One row per deposit (the latest verification), same rule as fin_ops_recent_cash_codes.
--   * "expired" = still awaiting its code but past expires_at, or already marked expired.
--   * Days are Uganda days (Africa/Kampala).
--   * wallet_holder_phone is the phone of the wallet that is credited, NOT the phone of the person handing over cash: the
--     depositor name comes from the cash owner recorded on the deposit, the phone from the profile that owns the wallet.
--     The old column was labelled phone and looked like the depositor number, which is why it repeated on every row.
--   * The plain code is deliberately not returned.
-- Roll back with 20261106140000_cash_deposit_codes_range_and_summary.rollback.sql.

CREATE OR REPLACE FUNCTION public.fin_ops_cash_codes_page(
  p_from timestamptz DEFAULT NULL,
  p_to timestamptz DEFAULT NULL,
  p_status text DEFAULT NULL,        -- NULL = all, 'awaiting' = still awaiting a code (live or expired), 'verified'
  p_location text DEFAULT NULL,      -- NULL = all, 'cash_at_hand', 'bank'
  p_search text DEFAULT NULL,
  p_limit integer DEFAULT 25,
  p_offset integer DEFAULT 0
)
RETURNS TABLE(
  verification_id uuid, deposit_request_id uuid, depositor_name text, wallet_holder_name text, cash_owner_name text,
  wallet_holder_phone text, amount numeric, status text, attempts integer, max_attempts integer, deposit_purpose text,
  cash_location text, expires_at timestamptz, created_at timestamptz, total_count bigint
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_term text := nullif(btrim(coalesce(p_search, '')), '');
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'cfo') OR public.has_role(auth.uid(), 'coo') OR public.has_role(auth.uid(), 'manager')
    OR public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'operations') OR public.has_role(auth.uid(), 'financial_ops')
  ) THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  RETURN QUERY
  WITH latest AS (
    SELECT DISTINCT ON (v.deposit_request_id) v.id, v.deposit_request_id, v.user_id, v.amount, v.status, v.attempts, v.max_attempts, v.expires_at, v.created_at
    FROM public.cash_deposit_verifications v
    ORDER BY v.deposit_request_id, v.created_at DESC
  ), base AS (
    SELECT l.id AS vid, l.deposit_request_id AS did,
           COALESCE(NULLIF(TRIM(dr.purpose_audit->>'cash_owner_name'), ''), p.full_name) AS depositor_name,
           p.full_name AS wallet_holder_name,
           NULLIF(TRIM(dr.purpose_audit->>'cash_owner_name'), '') AS cash_owner_name,
           p.phone AS wallet_holder_phone, l.amount, l.status, l.attempts, l.max_attempts,
           dr.deposit_purpose::text AS deposit_purpose,
           COALESCE(dr.purpose_audit->>'cash_location', 'cash_at_hand') AS cash_location,
           l.expires_at, l.created_at
    FROM latest l
    LEFT JOIN public.profiles p ON p.id = l.user_id
    LEFT JOIN public.deposit_requests dr ON dr.id = l.deposit_request_id
    WHERE (p_from IS NULL OR l.created_at >= p_from) AND (p_to IS NULL OR l.created_at < p_to)
  ), filtered AS (
    SELECT * FROM base b
    WHERE (p_status IS NULL OR (p_status = 'awaiting' AND b.status = 'awaiting_code') OR (p_status = 'verified' AND b.status = 'verified'))
      AND (p_location IS NULL OR b.cash_location = p_location)
      AND (v_term IS NULL OR b.depositor_name ILIKE '%' || v_term || '%' OR b.wallet_holder_phone ILIKE '%' || v_term || '%'
           OR b.amount::text ILIKE '%' || v_term || '%' OR b.deposit_purpose ILIKE '%' || v_term || '%')
  )
  SELECT f.vid, f.did, f.depositor_name, f.wallet_holder_name, f.cash_owner_name, f.wallet_holder_phone, f.amount, f.status,
         f.attempts, f.max_attempts, f.deposit_purpose, f.cash_location, f.expires_at, f.created_at,
         count(*) OVER () AS total_count
  FROM filtered f
  ORDER BY f.created_at DESC
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 25), 200)) OFFSET GREATEST(0, COALESCE(p_offset, 0));
END;
$function$;

CREATE OR REPLACE FUNCTION public.fin_ops_cash_codes_summary(p_from timestamptz DEFAULT NULL, p_to timestamptz DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_out jsonb;
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'cfo') OR public.has_role(auth.uid(), 'coo') OR public.has_role(auth.uid(), 'manager')
    OR public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'operations') OR public.has_role(auth.uid(), 'financial_ops')
  ) THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  WITH latest AS (
    SELECT DISTINCT ON (v.deposit_request_id) v.deposit_request_id, v.amount, v.status, v.expires_at, v.created_at
    FROM public.cash_deposit_verifications v
    ORDER BY v.deposit_request_id, v.created_at DESC
  ), r AS (
    SELECT l.*, (l.status = 'awaiting_code' AND (l.expires_at IS NULL OR l.expires_at > now())) AS is_live,
           (l.status = 'expired' OR (l.status = 'awaiting_code' AND l.expires_at IS NOT NULL AND l.expires_at <= now())) AS is_expired,
           (l.created_at AT TIME ZONE 'Africa/Kampala')::date AS day
    FROM latest l
    WHERE (p_from IS NULL OR l.created_at >= p_from) AND (p_to IS NULL OR l.created_at < p_to)
  )
  SELECT jsonb_build_object(
    'deposits_total',       (SELECT count(*) FROM r),
    'verified_count',       (SELECT count(*) FROM r WHERE status = 'verified'),
    'verified_total',       (SELECT coalesce(sum(amount), 0) FROM r WHERE status = 'verified'),
    'awaiting_count',       (SELECT count(*) FROM r WHERE status = 'awaiting_code'),
    'awaiting_live_count',  (SELECT count(*) FROM r WHERE is_live),
    'awaiting_live_total',  (SELECT coalesce(sum(amount), 0) FROM r WHERE is_live),
    'expired_count',        (SELECT count(*) FROM r WHERE is_expired),
    'by_day', coalesce((
      SELECT jsonb_agg(jsonb_build_object('day', d.day, 'verified', d.verified, 'awaiting', d.awaiting) ORDER BY d.day)
      FROM (
        SELECT day,
               coalesce(sum(amount) FILTER (WHERE status = 'verified'), 0) AS verified,
               coalesce(sum(amount) FILTER (WHERE is_live), 0) AS awaiting
        FROM r GROUP BY day
      ) d
    ), '[]'::jsonb)
  ) INTO v_out;
  RETURN v_out;
END;
$function$;

REVOKE ALL ON FUNCTION public.fin_ops_cash_codes_page(timestamptz, timestamptz, text, text, text, integer, integer),
  public.fin_ops_cash_codes_summary(timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fin_ops_cash_codes_page(timestamptz, timestamptz, text, text, text, integer, integer),
  public.fin_ops_cash_codes_summary(timestamptz, timestamptz) TO authenticated;
