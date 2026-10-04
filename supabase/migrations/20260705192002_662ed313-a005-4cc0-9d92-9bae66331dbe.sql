
-- Security-definer summary for the "tenant already in system" flow.
-- Lets an agent (who did NOT register this tenant) still see the tenant's
-- current outstanding balance and the previous/collecting agent, so they can
-- decide to renew instead of creating a duplicate rent plan.
CREATE OR REPLACE FUNCTION public.get_tenant_rent_summary(p_tenant_id uuid)
RETURNS TABLE (
  tenant_id uuid,
  outstanding_balance numeric,
  total_obligation numeric,
  total_repaid numeric,
  active_plan_count integer,
  latest_request_id uuid,
  latest_status text,
  latest_registration_type text,
  latest_daily_repayment numeric,
  latest_created_at timestamptz,
  previous_agent_id uuid,
  previous_agent_name text,
  previous_agent_phone text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_latest RECORD;
  v_agent_id uuid;
BEGIN
  -- Only agent/operations/executive roles may inspect other agents' tenants.
  IF NOT (
    has_role(auth.uid(), 'agent'::app_role)
    OR has_role(auth.uid(), 'manager'::app_role)
    OR has_role(auth.uid(), 'coo'::app_role)
    OR has_role(auth.uid(), 'cfo'::app_role)
    OR has_role(auth.uid(), 'ceo'::app_role)
  ) THEN
    RETURN;
  END IF;

  -- Aggregate outstanding across disbursed (active) plans.
  SELECT
    p_tenant_id,
    COALESCE(SUM(GREATEST(COALESCE(rr.total_repayment,0) - COALESCE(rr.amount_repaid,0), 0)), 0),
    COALESCE(SUM(COALESCE(rr.total_repayment,0)), 0),
    COALESCE(SUM(COALESCE(rr.amount_repaid,0)), 0),
    COUNT(*)::int
  INTO tenant_id, outstanding_balance, total_obligation, total_repaid, active_plan_count
  FROM public.rent_requests rr
  WHERE rr.tenant_id = p_tenant_id
    AND rr.status IN ('funded','repaying');

  -- Most recent rent plan for this tenant (any status) -> previous agent + terms.
  SELECT rr.id, rr.status, rr.registration_type, rr.daily_repayment, rr.created_at,
         COALESCE(rr.assigned_agent_id, rr.agent_id) AS agent_id
  INTO v_latest
  FROM public.rent_requests rr
  WHERE rr.tenant_id = p_tenant_id
  ORDER BY rr.created_at DESC
  LIMIT 1;

  IF FOUND THEN
    latest_request_id := v_latest.id;
    latest_status := v_latest.status;
    latest_registration_type := v_latest.registration_type;
    latest_daily_repayment := v_latest.daily_repayment;
    latest_created_at := v_latest.created_at;
    v_agent_id := v_latest.agent_id;

    IF v_agent_id IS NOT NULL THEN
      SELECT pr.id, pr.full_name, pr.phone
      INTO previous_agent_id, previous_agent_name, previous_agent_phone
      FROM public.profiles pr
      WHERE pr.id = v_agent_id;
    END IF;
  END IF;

  tenant_id := p_tenant_id;
  RETURN NEXT;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_tenant_rent_summary(uuid) TO authenticated;
