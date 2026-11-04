-- A Rent Plan whose balance the CFO waived must not count against the tenant's repayment rate.
--
-- WHAT WAS WRONG
-- get_agent_rent_request_capacity (called by the BEFORE INSERT trigger
-- enforce_agent_rent_request_capacity, and therefore by renew_rent_request) rates a tenant
-- on SUM(amount_repaid) / SUM(total_repayment) over their plans of the last 180 days. Below
-- 60% the tenant is 'defaulting', tenant_max is 0 and every new plan or renewal is refused
-- with "This tenant is behind on rent (only N% paid back)".
--
-- Nakitende Jumeirah's plan 406ed7bc had its 336,000 balance waived by the CFO on 2026-11-02
-- (migration 20261102120000: the agent kept the collection and it was moved to her as an
-- advance). The plan is `completed` with amount_repaid 216,000 of 552,000, so her rate read
-- (216,000 + 90,000) / (552,000 + 90,000) = 48% -> defaulting -> every renewal blocked, even
-- though the plan is closed and she owes nothing.
--
-- THE FIX (minimal)
-- Plans that carry a CFO waiver audit row (action_type 'rent_plan_balance_waived%',
-- record_id = the plan id) are left out of the repayment-rate sum. The tenant is judged on
-- the plans she actually had to pay. Nothing else in the function changes; the body below is
-- the live production definition with only that filter added. CREATE OR REPLACE keeps grants.
-- Future waivers get the same treatment as long as they write an audit row with that prefix.

CREATE OR REPLACE FUNCTION public.get_agent_rent_request_capacity(p_agent_id uuid, p_tenant_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_total_due       numeric := 0;
  v_total_paid      numeric := 0;
  v_history_count   integer := 0;
  v_repayment_rate  numeric;
  v_tier            text;
  v_tenant_max      bigint;
  v_agent_exposure  bigint := 0;
  v_agent_cap       bigint := 100000000;  -- 100,000,000 UGX
  v_agent_headroom  bigint;
  v_allowed_max     bigint;
  v_reason          text   := NULL;
  v_blocked         boolean := false;
  v_active_tenants  integer := 0;
  v_small_agent_floor bigint := 2000000;  -- 2,000,000 UGX
begin /* advisor_guard */ if not (pg_trigger_depth() > 0 or public.can_view_staff_reports(auth.uid())) then raise exception 'not authorized' using errcode = '42501'; end if;
  -- ---- Tenant repayment behaviour (last 180 days) ----
  -- Plans whose balance the CFO waived are not the tenant's repayment history.
  SELECT
    COALESCE(SUM(COALESCE(total_repayment, 0)), 0),
    COALESCE(SUM(COALESCE(amount_repaid,   0)), 0),
    COUNT(*) FILTER (WHERE COALESCE(total_repayment, 0) > 0)
  INTO v_total_due, v_total_paid, v_history_count
  FROM public.rent_requests rr
  WHERE rr.tenant_id = p_tenant_id
    AND rr.status IN ('repaying','completed','funded')
    AND rr.created_at >= now() - interval '180 days'
    AND NOT EXISTS (
      SELECT 1 FROM public.audit_logs al
       WHERE al.table_name = 'rent_requests'
         AND al.record_id = rr.id::text
         AND al.action_type LIKE 'rent_plan_balance_waived%'
    );

  IF v_history_count = 0 OR v_total_due <= 0 THEN
    v_repayment_rate := NULL;  -- no history
    v_tier           := 'starter';
    v_tenant_max     := 500000;
  ELSE
    v_repayment_rate := LEAST(1.0, v_total_paid / NULLIF(v_total_due, 0));
    IF v_repayment_rate < 0.60 THEN
      v_tier := 'defaulting'; v_tenant_max := 0;
    ELSIF v_repayment_rate < 0.80 THEN
      v_tier := 'building';   v_tenant_max := 1500000;
    ELSIF v_repayment_rate < 0.95 THEN
      v_tier := 'reliable';   v_tenant_max := 3000000;
    ELSE
      v_tier := 'premium';    v_tenant_max := 6000000;
    END IF;
  END IF;

  -- ---- Agent aggregate exposure (active rent requests, not closed/rejected) ----
  SELECT COALESCE(SUM(
    GREATEST(
      COALESCE(total_repayment, 0) - COALESCE(amount_repaid, 0),
      0
    )
  ), 0)::bigint
  INTO v_agent_exposure
  FROM public.rent_requests
  WHERE agent_id = p_agent_id
    AND status IN (
      'pending','agent_verified','tenant_ops_approved',
      'agent_ops_approved','landlord_ops_approved',
      'coo_approved','funded','repaying'
    );

  -- ---- Agent active tenant count (distinct tenants on active rent requests) ----
  SELECT COUNT(DISTINCT tenant_id)
  INTO v_active_tenants
  FROM public.rent_requests
  WHERE agent_id = p_agent_id
    AND status IN (
      'pending','agent_verified','tenant_ops_approved',
      'agent_ops_approved','landlord_ops_approved',
      'coo_approved','funded','repaying'
    );

  -- Small / early agents (0–10 active tenants) get a 2,000,000 UGX request floor,
  -- but never for tenants who are seriously behind (defaulting tier stays blocked).
  IF v_active_tenants <= 10 AND v_tier <> 'defaulting' THEN
    v_tenant_max := GREATEST(v_tenant_max, v_small_agent_floor);
  END IF;

  v_agent_headroom := GREATEST(v_agent_cap - v_agent_exposure, 0);
  v_allowed_max    := LEAST(v_tenant_max, v_agent_headroom);

  -- ---- Block reasons (informative, machine-readable) ----
  IF v_tier = 'defaulting' THEN
    v_blocked := true;
    v_reason  := format(
      'This tenant is behind on rent (only %s%% paid back). Help them clear arrears before posting a new rent request.',
      ROUND(COALESCE(v_repayment_rate, 0) * 100)
    );
  ELSIF v_agent_headroom < 100000 THEN
    v_blocked := true;
    v_reason  := 'You have reached your UGX 100,000,000 active rent exposure cap. Collect on existing rent requests to free up headroom.';
  ELSIF v_allowed_max < 100000 THEN
    v_blocked := true;
    v_reason  := 'Available rent capacity is below the minimum request size of UGX 100,000.';
  END IF;

  RETURN jsonb_build_object(
    'tenant_repayment_rate', v_repayment_rate,
    'tenant_history_count',  v_history_count,
    'tenant_tier',           v_tier,
    'tenant_max',            v_tenant_max,
    'agent_active_tenants',  v_active_tenants,
    'agent_exposure',        v_agent_exposure,
    'agent_cap',             v_agent_cap,
    'agent_headroom',        v_agent_headroom,
    'allowed_max',           v_allowed_max,
    'blocked',               v_blocked,
    'reason',                v_reason
  );
END;
$function$;
