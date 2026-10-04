CREATE OR REPLACE FUNCTION public.get_agent_proxy_roi_payouts(p_agent_id uuid DEFAULT auth.uid())
RETURNS TABLE (
  id uuid,
  amount numeric,
  linked_party text,
  source_id uuid,
  target_wallet_user_id uuid,
  description text,
  metadata jsonb,
  created_at timestamptz,
  reviewed_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH kampala_day AS (
    SELECT
      (date_trunc('day', now() AT TIME ZONE 'Africa/Kampala') AT TIME ZONE 'Africa/Kampala') AS start_at,
      ((date_trunc('day', now() AT TIME ZONE 'Africa/Kampala') + interval '1 day') AT TIME ZONE 'Africa/Kampala') AS end_at
  ), settled AS (
    SELECT
      approval_id,
      SUM(amount_settled) AS amount_settled
    FROM public.proxy_payout_settlements
    GROUP BY approval_id
  ), routed_withdrawals AS (
    SELECT
      wr.id,
      wr.user_id,
      wr.agent_id,
      wr.status,
      substring(wr.reason FROM 'Route:\s*portfolio\s*([0-9a-fA-F-]{36})')::uuid AS portfolio_id
    FROM public.withdrawal_requests wr
    WHERE wr.agent_id = p_agent_id
      AND wr.status = ANY (ARRAY[
        'pending',
        'requested',
        'manager_approved',
        'cfo_approved',
        'processing',
        'approved',
        'fin_ops_approved',
        'completed',
        'processed',
        'paid'
      ])
      AND substring(wr.reason FROM 'Route:\s*portfolio\s*([0-9a-fA-F-]{36})') IS NOT NULL
  )
  SELECT
    pwo.id,
    pwo.amount,
    pwo.linked_party,
    pwo.source_id,
    pwo.target_wallet_user_id,
    pwo.description,
    pwo.metadata,
    pwo.created_at,
    pwo.reviewed_at
  FROM public.pending_wallet_operations pwo
  JOIN public.investor_portfolios ip
    ON ip.id = pwo.source_id
  JOIN public.proxy_agent_assignments paa
    ON paa.beneficiary_id = ip.investor_id
   AND paa.agent_id = p_agent_id
   AND paa.is_active = true
   AND paa.approval_status = 'approved'
   AND paa.beneficiary_role = 'supporter'
  CROSS JOIN kampala_day kd
  LEFT JOIN settled s
    ON s.approval_id = pwo.id
  WHERE auth.uid() IS NOT NULL
    AND (
      p_agent_id = auth.uid()
      OR public.has_role(auth.uid(), 'manager')
      OR public.has_role(auth.uid(), 'super_admin')
      OR public.has_role(auth.uid(), 'ceo')
      OR public.has_role(auth.uid(), 'coo')
      OR public.has_role(auth.uid(), 'cfo')
      OR public.has_role(auth.uid(), 'operations')
    )
    AND pwo.category = 'roi_payout'
    AND pwo.status = 'approved'
    AND pwo.source_id IS NOT NULL
    AND pwo.metadata->>'coo_approved_by' IS NOT NULL
    AND COALESCE(pwo.reviewed_at, pwo.created_at) >= kd.start_at
    AND COALESCE(pwo.reviewed_at, pwo.created_at) < kd.end_at
    AND COALESCE(s.amount_settled, 0) < pwo.amount - 1
    AND NOT EXISTS (
      SELECT 1
      FROM routed_withdrawals wr
      WHERE wr.user_id = ip.investor_id
        AND wr.portfolio_id = ip.id
    )
    AND (
      pwo.target_wallet_user_id IS NULL
      OR pwo.target_wallet_user_id = p_agent_id
      OR pwo.target_wallet_user_id = ip.investor_id
    )
  ORDER BY pwo.created_at DESC;
$$;

GRANT EXECUTE ON FUNCTION public.get_agent_proxy_roi_payouts(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_agent_proxy_roi_payouts(uuid) TO service_role;