-- The previous column-level REVOKE had no effect because authenticated/anon
-- held a TABLE-level SELECT grant, which supersedes column-level revokes.
-- Fix: drop table-level SELECT, then re-grant SELECT on every column EXCEPT
-- total_payable. INSERT/UPDATE/DELETE remain intact (writes & ledger unaffected).

REVOKE SELECT ON public.agent_advance_requests FROM authenticated;
REVOKE SELECT ON public.agent_advance_requests FROM anon;

GRANT SELECT (
  id, agent_id, principal, cycle_days, monthly_rate, access_fee,
  registration_fee, daily_payment, reason, status,
  reviewed_by_agent_ops, agent_ops_reviewed_at, agent_ops_notes,
  reviewed_by_tenant_ops, tenant_ops_reviewed_at, tenant_ops_notes,
  reviewed_by_landlord_ops, landlord_ops_reviewed_at, landlord_ops_notes,
  approved_by_coo, coo_approved_at, coo_notes,
  paid_by_cfo, cfo_paid_at, cfo_adjusted_rate, cfo_notes,
  rejection_reason, created_at, updated_at,
  cfo_approved_by, cfo_approved_at
) ON public.agent_advance_requests TO authenticated;

-- service_role keeps full table access (ledger/edge functions); not altered.