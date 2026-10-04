-- Anchor date control (read-only config; safe default)
INSERT INTO public.treasury_controls (control_key, enabled, value)
SELECT 'merchant_float_anchor_date', true, '2026-08-01'
WHERE NOT EXISTS (SELECT 1 FROM public.treasury_controls WHERE control_key = 'merchant_float_anchor_date');

CREATE OR REPLACE FUNCTION public.get_merchant_payout_float()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_withdrawable numeric := 0;
  v_landlord_float numeric := 0;
  v_claimed numeric := 0;
BEGIN
  SELECT COALESCE(SUM(GREATEST(withdrawable_balance, 0)), 0) INTO v_withdrawable FROM public.wallets;
  SELECT COALESCE(SUM(GREATEST(balance, 0)), 0) INTO v_landlord_float FROM public.agent_landlord_float;
  SELECT COALESCE(SUM(amount), 0) INTO v_claimed
  FROM public.withdrawal_requests
  WHERE status IN ('approved', 'processing')
    AND (assigned_cashout_agent_id IS NOT NULL OR dispatch_claimed_by IS NOT NULL);

  RETURN jsonb_build_object(
    'withdrawable_total', v_withdrawable,
    'landlord_float_total', v_landlord_float,
    'claimed_unsettled_total', v_claimed,
    'available_float', GREATEST(v_withdrawable + v_landlord_float - v_claimed, 0),
    'computed_at', now()
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_merchant_payout_float() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_merchant_payout_float() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_merchant_payout_float() TO service_role;

CREATE OR REPLACE FUNCTION public.get_merchant_float_positions()
RETURNS TABLE (
  desk_id uuid,
  agent_id uuid,
  agent_name text,
  agent_phone text,
  label text,
  is_active boolean,
  paid_out_total numeric,
  reimbursed_total numeric,
  float_credits_recorded numeric,
  owed_to_agent numeric,
  company_cash_with_agent numeric,
  last_payout_at timestamptz,
  last_reimbursed_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_anchor date;
  v_is_finance boolean;
BEGIN
  SELECT COALESCE(NULLIF(value, '')::date, '2026-08-01'::date) INTO v_anchor
  FROM public.treasury_controls WHERE control_key = 'merchant_float_anchor_date';
  v_anchor := COALESCE(v_anchor, '2026-08-01'::date);

  v_is_finance := public.has_role(auth.uid(), 'cfo')
    OR public.has_role(auth.uid(), 'financial_ops')
    OR public.has_role(auth.uid(), 'manager')
    OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'ceo')
    OR public.has_role(auth.uid(), 'coo');

  RETURN QUERY
  WITH desks AS (
    SELECT ca.id, ca.agent_id, ca.label, ca.is_active,
           p.full_name, p.phone,
           right(regexp_replace(COALESCE(p.phone, ''), '\D', '', 'g'), 9) AS phone9
    FROM public.cashout_agents ca
    LEFT JOIN public.profiles p ON p.id = ca.agent_id
    WHERE v_is_finance OR ca.agent_id = auth.uid()
  ),
  paid AS (
    SELECT d.id AS desk_id,
           COALESCE(SUM(w.amount), 0) AS total,
           MAX(w.processed_at) AS last_at
    FROM desks d
    LEFT JOIN public.withdrawal_requests w
      ON w.status = 'completed'
     AND COALESCE(w.processed_at, w.updated_at) >= v_anchor
     AND (w.assigned_cashout_agent_id = d.id OR w.processed_by = d.agent_id)
    GROUP BY d.id
  ),
  reimbursed AS (
    SELECT d.id AS desk_id,
           COALESCE(SUM(g.amount), 0) AS total,
           MAX(g.internal_date) AS last_at
    FROM desks d
    LEFT JOIN public.gmail_transactions g
      ON g.direction = 'out'
     AND g.channel IN ('mtn_momo', 'airtel_money')
     AND g.amount IS NOT NULL
     AND d.phone9 <> ''
     AND right(regexp_replace(COALESCE(g.counterparty, ''), '\D', '', 'g'), 9) = d.phone9
     AND g.internal_date >= v_anchor
    GROUP BY d.id
  ),
  credits AS (
    SELECT d.id AS desk_id, COALESCE(SUM(f.requested_amount), 0) AS total
    FROM desks d
    LEFT JOIN public.float_requests f
      ON f.agent_id = d.agent_id
     AND f.status = 'approved'
     AND f.approved_at >= v_anchor
    GROUP BY d.id
  )
  SELECT d.id, d.agent_id, d.full_name, d.phone, d.label, d.is_active,
         pd.total,
         rb.total,
         cr.total,
         GREATEST(pd.total - rb.total, 0),
         GREATEST(rb.total - pd.total, 0),
         pd.last_at,
         rb.last_at
  FROM desks d
  JOIN paid pd ON pd.desk_id = d.id
  JOIN reimbursed rb ON rb.desk_id = d.id
  JOIN credits cr ON cr.desk_id = d.id
  ORDER BY GREATEST(rb.total - pd.total, 0) DESC, GREATEST(pd.total - rb.total, 0) DESC;
END;
$$;

REVOKE ALL ON FUNCTION public.get_merchant_float_positions() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_merchant_float_positions() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_merchant_float_positions() TO service_role;