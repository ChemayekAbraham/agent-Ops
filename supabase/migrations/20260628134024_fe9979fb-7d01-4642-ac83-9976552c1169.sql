-- Cashout settlement timeline: pairs each cash-out withdrawal with its merchant
-- reimbursement (principal back to merchant withdrawable) and the 0.5% commission,
-- for the Financial Ops auditable ledger view.
CREATE OR REPLACE FUNCTION public.get_cashout_settlement_timeline(
  p_search text DEFAULT NULL,
  p_limit int DEFAULT 50,
  p_offset int DEFAULT 0
)
RETURNS TABLE (
  withdrawal_id uuid,
  settled_at timestamptz,
  customer_id uuid,
  customer_name text,
  customer_phone text,
  withdrawal_amount numeric,
  withdrawal_status text,
  merchant_id uuid,
  merchant_name text,
  merchant_phone text,
  reimbursement_amount numeric,
  commission_amount numeric,
  total_credited numeric,
  total_count bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH settlements AS (
    SELECT
      gl.reference_id,
      split_part(gl.reference_id, '-', 1) AS dummy, -- unused, keep base via replace below
      regexp_replace(gl.reference_id, '-(merchant-reimbursement|cashout-commission)$', '') AS base_id,
      gl.user_id AS merchant_id,
      MAX(gl.transaction_date) AS settled_at,
      SUM(CASE WHEN gl.reference_id LIKE '%-merchant-reimbursement' THEN gl.amount ELSE 0 END) AS reimbursement_amount,
      SUM(CASE WHEN gl.reference_id LIKE '%-cashout-commission' THEN gl.amount ELSE 0 END) AS commission_amount
    FROM public.general_ledger gl
    WHERE gl.ledger_scope = 'wallet'
      AND gl.direction = 'cash_in'
      AND (gl.reference_id LIKE '%-merchant-reimbursement' OR gl.reference_id LIKE '%-cashout-commission')
    GROUP BY 1, 3, 4
  ),
  joined AS (
    SELECT
      (s.base_id)::uuid AS withdrawal_id,
      s.settled_at,
      wr.user_id AS customer_id,
      cp.full_name AS customer_name,
      cp.phone AS customer_phone,
      wr.amount AS withdrawal_amount,
      wr.status AS withdrawal_status,
      s.merchant_id,
      mp.full_name AS merchant_name,
      mp.phone AS merchant_phone,
      s.reimbursement_amount,
      s.commission_amount,
      (s.reimbursement_amount + s.commission_amount) AS total_credited
    FROM settlements s
    LEFT JOIN public.withdrawal_requests wr ON wr.id = (s.base_id)::uuid
    LEFT JOIN public.profiles cp ON cp.id = wr.user_id
    LEFT JOIN public.profiles mp ON mp.id = s.merchant_id
  ),
  filtered AS (
    SELECT * FROM joined j
    WHERE p_search IS NULL OR p_search = ''
       OR j.customer_name ILIKE '%' || p_search || '%'
       OR j.customer_phone ILIKE '%' || p_search || '%'
       OR j.merchant_name ILIKE '%' || p_search || '%'
       OR j.merchant_phone ILIKE '%' || p_search || '%'
       OR j.withdrawal_id::text ILIKE '%' || p_search || '%'
  )
  SELECT
    f.withdrawal_id,
    f.settled_at,
    f.customer_id,
    f.customer_name,
    f.customer_phone,
    f.withdrawal_amount,
    f.withdrawal_status,
    f.merchant_id,
    f.merchant_name,
    f.merchant_phone,
    f.reimbursement_amount,
    f.commission_amount,
    f.total_credited,
    COUNT(*) OVER() AS total_count
  FROM filtered f
  ORDER BY f.settled_at DESC
  LIMIT GREATEST(p_limit, 1) OFFSET GREATEST(p_offset, 0);
$$;

GRANT EXECUTE ON FUNCTION public.get_cashout_settlement_timeline(text, int, int) TO authenticated, service_role;