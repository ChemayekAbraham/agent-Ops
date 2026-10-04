-- ============================================================
-- Agent / Tenant rent request capacity engine
-- ============================================================
-- Per-tenant tier (from repayment rate over last 180 days of
-- non-rejected rent_requests):
--   defaulting (<60%)      => blocked
--   starter   (no history) => UGX   500,000
--   building  (60–79%)     => UGX 1,500,000
--   reliable  (80–94%)     => UGX 3,000,000
--   premium   (95–100%)    => UGX 6,000,000
--
-- Agent aggregate cap:
--   sum(remaining outstanding across active rent_requests) <= UGX 100,000,000
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_agent_rent_request_capacity(
  p_agent_id  uuid,
  p_tenant_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
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
BEGIN
  -- ---- Tenant repayment behaviour (last 180 days) ----
  SELECT
    COALESCE(SUM(COALESCE(total_repayment, 0)), 0),
    COALESCE(SUM(COALESCE(amount_repaid,   0)), 0),
    COUNT(*) FILTER (WHERE COALESCE(total_repayment, 0) > 0)
  INTO v_total_due, v_total_paid, v_history_count
  FROM public.rent_requests
  WHERE tenant_id = p_tenant_id
    AND status IN ('repaying','completed','funded')
    AND created_at >= now() - interval '180 days';

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
    'agent_exposure',        v_agent_exposure,
    'agent_cap',             v_agent_cap,
    'agent_headroom',        v_agent_headroom,
    'allowed_max',           v_allowed_max,
    'blocked',               v_blocked,
    'reason',                v_reason
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_agent_rent_request_capacity(uuid, uuid)
  TO authenticated, anon, service_role;

-- ============================================================
-- BEFORE INSERT trigger — server-side enforcement
-- ============================================================
CREATE OR REPLACE FUNCTION public.enforce_agent_rent_request_capacity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cap jsonb;
  v_allowed_max bigint;
  v_blocked     boolean;
  v_reason      text;
  v_tier        text;
BEGIN
  -- Only enforce when agent + tenant are present and rent_amount > 0.
  IF NEW.agent_id IS NULL OR NEW.tenant_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF COALESCE(NEW.rent_amount, 0) <= 0 THEN
    RETURN NEW;
  END IF;

  v_cap := public.get_agent_rent_request_capacity(NEW.agent_id, NEW.tenant_id);
  v_allowed_max := (v_cap->>'allowed_max')::bigint;
  v_blocked     := (v_cap->>'blocked')::boolean;
  v_reason      :=  v_cap->>'reason';
  v_tier        :=  v_cap->>'tenant_tier';

  IF v_blocked OR NEW.rent_amount > v_allowed_max THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = COALESCE(
        v_reason,
        format(
          'Rent amount %s exceeds your available capacity of %s for this tenant (tier: %s).',
          to_char(NEW.rent_amount, 'FM999,999,999'),
          to_char(v_allowed_max,   'FM999,999,999'),
          v_tier
        )
      ),
      HINT    = 'Reduce the rent amount, collect on existing rent requests, or help the tenant clear arrears.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_agent_rent_request_capacity ON public.rent_requests;
CREATE TRIGGER trg_enforce_agent_rent_request_capacity
  BEFORE INSERT ON public.rent_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_agent_rent_request_capacity();