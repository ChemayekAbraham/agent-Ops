CREATE OR REPLACE FUNCTION public.get_agent_proxy_roi_payouts(p_agent_id uuid DEFAULT auth.uid())
 RETURNS TABLE(id uuid, amount numeric, linked_party text, source_id uuid, target_wallet_user_id uuid, description text, metadata jsonb, created_at timestamp with time zone, reviewed_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH settled AS (
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
      wr.created_at,
      substring(wr.reason FROM 'Route:\s*portfolio\s*([0-9a-fA-F-]{36})')::uuid AS portfolio_id
    FROM public.withdrawal_requests wr
    WHERE wr.agent_id = p_agent_id
      AND wr.status = ANY (ARRAY[
        'pending','requested','manager_approved','cfo_approved','processing',
        'approved','fin_ops_approved','completed','processed','paid'
      ])
      AND substring(wr.reason FROM 'Route:\s*portfolio\s*([0-9a-fA-F-]{36})') IS NOT NULL
  )
  SELECT
    pwo.id, pwo.amount, pwo.linked_party, pwo.source_id, pwo.target_wallet_user_id,
    pwo.description, pwo.metadata, pwo.created_at, pwo.reviewed_at
  FROM public.pending_wallet_operations pwo
  JOIN public.investor_portfolios ip
    ON ip.id = pwo.source_id
  JOIN public.proxy_agent_assignments paa
    ON paa.beneficiary_id = ip.investor_id
   AND paa.agent_id = p_agent_id
   AND paa.is_active = true
   AND paa.approval_status = 'approved'
   AND paa.beneficiary_role = 'supporter'
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
    AND COALESCE(s.amount_settled, 0) < pwo.amount - 1
    AND NOT EXISTS (
      SELECT 1
      FROM routed_withdrawals wr
      WHERE wr.user_id = ip.investor_id
        AND wr.portfolio_id = ip.id
        -- Only suppress if the routed withdrawal is FOR this specific approval
        -- (created at/after the approval was made). Historical completed
        -- withdrawals for prior approvals must not permanently hide new
        -- CFO-approved payouts for the same partner+portfolio.
        AND wr.created_at >= pwo.reviewed_at - interval '5 minutes'
    )
    AND (
      pwo.target_wallet_user_id IS NULL
      OR pwo.target_wallet_user_id = p_agent_id
      OR pwo.target_wallet_user_id = ip.investor_id
    )
  ORDER BY pwo.created_at DESC;
$function$;