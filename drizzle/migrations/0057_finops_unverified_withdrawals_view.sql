
CREATE OR REPLACE FUNCTION public.finops_unverified_withdrawals(
  p_search text DEFAULT '',
  p_limit integer DEFAULT 20,
  p_offset integer DEFAULT 0
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
  total_count bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_search text := btrim(coalesce(p_search, ''));
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
  unverified AS (
    SELECT c.*
    FROM checked c
    WHERE NOT (c.has_national_id AND c.has_id_photo AND c.has_selfie AND c.destination_verified)
      AND (
        v_search = ''
        OR c.full_name ILIKE '%' || v_search || '%'
        OR c.phone ILIKE '%' || v_search || '%'
        OR c.mobile_money_number ILIKE '%' || v_search || '%'
        OR c.bank_account_number ILIKE '%' || v_search || '%'
      )
  )
  SELECT
    u.id, u.user_id, u.full_name, u.phone, u.avatar_url,
    u.amount, u.status, u.payout_method,
    u.mobile_money_number, u.mobile_money_provider,
    u.bank_name, u.bank_account_number,
    u.created_at, u.hidden_from_merchant_queue,
    u.has_national_id, u.has_id_photo, u.has_selfie, u.destination_verified,
    COUNT(*) OVER () AS total_count
  FROM unverified u
  ORDER BY u.created_at DESC
  LIMIT GREATEST(1, LEAST(p_limit, 100))
  OFFSET GREATEST(0, p_offset);
END;
$$;

REVOKE ALL ON FUNCTION public.finops_unverified_withdrawals(text, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.finops_unverified_withdrawals(text, integer, integer) TO authenticated;
