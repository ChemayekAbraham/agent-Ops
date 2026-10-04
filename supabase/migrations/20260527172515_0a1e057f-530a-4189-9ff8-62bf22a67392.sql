CREATE OR REPLACE FUNCTION public.diagnose_pending_proxy_withdrawals()
RETURNS TABLE (
  withdrawal_id uuid,
  partner_id uuid,
  partner_name text,
  agent_id uuid,
  proxy_agent_id uuid,
  proxy_agent_name text,
  amount numeric,
  payout_method text,
  status text,
  created_at timestamptz,
  proxy_available numeric,
  total_remaining_in_emails numeric,
  bulk_emails_open integer,
  already_allocated boolean,
  reason_code text,
  reason text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total_remaining numeric;
  v_open_emails integer;
BEGIN
  SELECT COALESCE(SUM(GREATEST(COALESCE(amount,0) - COALESCE(bulk_payout_allocated_total,0), 0)), 0),
         COUNT(*) FILTER (WHERE bulk_payout_settled_at IS NULL
                          AND GREATEST(COALESCE(amount,0) - COALESCE(bulk_payout_allocated_total,0), 0) > 0)
    INTO v_total_remaining, v_open_emails
  FROM gmail_transactions
  WHERE is_bulk_bank_payout = true;

  RETURN QUERY
  WITH wr AS (
    SELECT w.id, w.user_id AS partner_id, w.agent_id, w.proxy_partner_id,
           w.amount, w.payout_method, w.status, w.created_at
    FROM withdrawal_requests w
    WHERE w.status IN ('pending','manager_approved','cfo_approved')
  ),
  proxy AS (
    SELECT DISTINCT ON (paa.beneficiary_id) paa.beneficiary_id, paa.agent_id
    FROM proxy_agent_assignments paa
    WHERE paa.is_active = true
      AND paa.approval_status = 'approved'
    ORDER BY paa.beneficiary_id, paa.is_managed_account DESC NULLS LAST, paa.created_at DESC
  ),
  enriched AS (
    SELECT wr.*,
           p.agent_id AS resolved_proxy_id,
           pp.full_name AS partner_name,
           pap.full_name AS proxy_agent_name,
           EXISTS(SELECT 1 FROM bulk_bank_payout_allocations bba WHERE bba.withdrawal_request_id = wr.id) AS allocated,
           CASE WHEN p.agent_id IS NOT NULL
                THEN public.get_user_available_balance(p.agent_id)
                ELSE NULL END AS proxy_avail
    FROM wr
    LEFT JOIN proxy p ON p.beneficiary_id = wr.partner_id
    LEFT JOIN profiles pp ON pp.id = wr.partner_id
    LEFT JOIN profiles pap ON pap.id = p.agent_id
  )
  SELECT
    e.id,
    e.partner_id,
    e.partner_name,
    e.agent_id,
    e.resolved_proxy_id,
    e.proxy_agent_name,
    e.amount,
    e.payout_method,
    e.status,
    e.created_at,
    e.proxy_avail,
    v_total_remaining,
    v_open_emails,
    e.allocated,
    CASE
      WHEN e.allocated THEN 'already_allocated'
      WHEN e.payout_method IS NULL OR e.payout_method NOT ILIKE 'bank%' THEN 'not_bank_payout'
      WHEN e.resolved_proxy_id IS NULL THEN 'no_proxy_assignment'
      WHEN COALESCE(e.proxy_avail,0) < e.amount THEN 'proxy_insufficient_balance'
      WHEN v_total_remaining < e.amount THEN 'no_email_capacity'
      WHEN v_open_emails = 0 THEN 'no_open_bulk_email'
      ELSE 'eligible_pending_run'
    END,
    CASE
      WHEN e.allocated THEN 'Already linked to a bulk email — awaiting approve-withdrawal completion.'
      WHEN e.payout_method IS NULL OR e.payout_method NOT ILIKE 'bank%' THEN 'Payout method is not bank — auto-settle only handles bank transfers.'
      WHEN e.resolved_proxy_id IS NULL THEN 'No active approved proxy agent assigned to this partner.'
      WHEN COALESCE(e.proxy_avail,0) < e.amount THEN format('Proxy agent withdrawable (%s UGX) below request (%s UGX).', to_char(COALESCE(e.proxy_avail,0),'FM999,999,999'), to_char(e.amount,'FM999,999,999'))
      WHEN v_total_remaining < e.amount THEN format('All open SKYBUBBLES emails combined hold %s UGX remaining — below request.', to_char(v_total_remaining,'FM999,999,999'))
      WHEN v_open_emails = 0 THEN 'No SKYBUBBLES email currently has remaining capacity.'
      ELSE 'Eligible — will settle on next auto-settle trigger.'
    END
  FROM enriched e
  ORDER BY e.created_at ASC;
END;
$$;

GRANT EXECUTE ON FUNCTION public.diagnose_pending_proxy_withdrawals() TO authenticated, service_role;