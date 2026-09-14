
CREATE OR REPLACE FUNCTION public.finops_unverified_withdrawals(
  p_search text DEFAULT '',
  p_limit integer DEFAULT 20,
  p_offset integer DEFAULT 0,
  p_filter text DEFAULT 'all',
  p_sort text DEFAULT 'newest'
)
RETURNS TABLE (
  id uuid,
  user_id uuid,
  full_name text,
  phone text,
  avatar_url text,
  amount numeric,
  status text,
  payout_method text,
  mobile_money_number text,
  mobile_money_provider text,
  bank_name text,
  bank_account_number text,
  created_at timestamptz,
  hidden_from_merchant_queue boolean,
  has_national_id boolean,
  has_id_photo boolean,
  has_selfie boolean,
  destination_verified boolean,
  badge text,
  total_count bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_search text := btrim(coalesce(p_search, ''));
  v_filter text := lower(btrim(coalesce(p_filter, 'all')));
  v_sort text := lower(btrim(coalesce(p_sort, 'newest')));
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'financial_ops')
    OR public.has_role(auth.uid(), 'cfo')
    OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'manager')
  ) THEN
    RAISE EXCEPTION 'Financial Ops only.';
  END IF;

  RETURN QUERY
  WITH open_w AS (
    SELECT w.*
    FROM public.withdrawal_requests w
    WHERE w.status IN ('pending','requested','manager_approved','cfo_approved','fin_ops_approved')
      AND w.processed_at IS NULL
      AND w.fin_ops_reference IS NULL
  ),
  checked AS (
    SELECT
      w.id, w.user_id, w.amount, w.status, w.payout_method,
      w.mobile_money_number, w.mobile_money_provider,
      w.bank_name, w.bank_account_number,
      w.created_at, w.hidden_from_merchant_queue,
      p.full_name, p.phone, p.avatar_url,
      (p.national_id IS NOT NULL AND btrim(p.national_id) <> '') AS has_national_id,
      (p.national_id_photo_path IS NOT NULL AND p.national_id_photo_path <> '') AS has_id_photo,
      (p.selfie_photo_path IS NOT NULL AND p.selfie_photo_path <> '') AS has_selfie,
      EXISTS (
        SELECT 1 FROM public.payout_destination_verifications v
        WHERE v.user_id = w.user_id
          AND v.status = 'verified'
          AND v.destination_key = CASE
            WHEN w.payout_method = 'bank_transfer'
              THEN 'bank:' || lower(coalesce(w.bank_name,'')) || ':' || coalesce(w.bank_account_number,'')
            ELSE 'momo:' || right(regexp_replace(coalesce(w.mobile_money_number,''), '\D', '', 'g'), 9)
          END
      ) AS destination_verified
    FROM open_w w
    LEFT JOIN public.profiles p ON p.id = w.user_id
  ),
  badged AS (
    SELECT c.*,
      CASE
        -- Verified would never appear here (those rows are excluded), but the
        -- badge is computed for completeness and future widening of the view.
        WHEN c.has_national_id AND c.has_id_photo AND c.has_selfie AND c.destination_verified THEN 'verified'
        -- Everything submitted; only the FinOps verification step is left.
        WHEN c.has_national_id AND c.has_id_photo AND c.has_selfie THEN 'needs_review'
        ELSE 'pending'
      END AS badge
    FROM checked c
  ),
  filtered AS (
    SELECT b.*
    FROM badged b
    WHERE b.badge <> 'verified'
      AND (v_filter = 'all' OR b.badge = v_filter)
      AND (
        v_search = ''
        OR b.full_name ILIKE '%' || v_search || '%'
        OR b.phone ILIKE '%' || v_search || '%'
        OR b.mobile_money_number ILIKE '%' || v_search || '%'
        OR b.bank_account_number ILIKE '%' || v_search || '%'
      )
  )
  SELECT
    f.id, f.user_id, f.full_name, f.phone, f.avatar_url,
    f.amount, f.status, f.payout_method,
    f.mobile_money_number, f.mobile_money_provider,
    f.bank_name, f.bank_account_number,
    f.created_at, f.hidden_from_merchant_queue,
    f.has_national_id, f.has_id_photo, f.has_selfie, f.destination_verified,
    f.badge,
    COUNT(*) OVER () AS total_count
  FROM filtered f
  ORDER BY
    CASE WHEN v_sort = 'oldest'  THEN f.created_at END ASC NULLS FIRST,
    CASE WHEN v_sort = 'biggest' THEN f.amount END DESC NULLS LAST,
    CASE WHEN v_sort = 'smallest' THEN f.amount END ASC NULLS LAST,
    CASE WHEN v_sort NOT IN ('oldest','biggest','smallest') THEN f.created_at END DESC NULLS LAST,
    f.created_at DESC
  LIMIT GREATEST(1, LEAST(p_limit, 100))
  OFFSET GREATEST(0, p_offset);
END;
$$;

REVOKE ALL ON FUNCTION public.finops_unverified_withdrawals(text, integer, integer, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.finops_unverified_withdrawals(text, integer, integer, text, text) TO authenticated;
