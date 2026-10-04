
-- Saved rent request drafts: agents can prepare requests above their current
-- per-tenant tier limit and push them later when their tier qualifies.
CREATE TABLE public.rent_request_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL,
  tenant_name text NOT NULL,
  tenant_phone text NOT NULL,
  rent_amount numeric NOT NULL CHECK (rent_amount > 0),
  required_per_tenant_max numeric NOT NULL DEFAULT 0,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','submitted','cancelled')),
  submitted_rent_request_id uuid,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_rent_request_drafts_agent ON public.rent_request_drafts(agent_id, status, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.rent_request_drafts TO authenticated;
GRANT ALL ON public.rent_request_drafts TO service_role;

ALTER TABLE public.rent_request_drafts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Agents manage own drafts"
ON public.rent_request_drafts FOR ALL
TO authenticated
USING (agent_id = auth.uid())
WITH CHECK (agent_id = auth.uid());

CREATE POLICY "Staff read all drafts"
ON public.rent_request_drafts FOR SELECT
TO authenticated
USING (
  public.has_role(auth.uid(), 'manager'::app_role)
  OR public.has_role(auth.uid(), 'super_admin'::app_role)
  OR public.has_role(auth.uid(), 'coo'::app_role)
  OR public.has_role(auth.uid(), 'operations'::app_role)
);

-- updated_at trigger
CREATE TRIGGER trg_rent_request_drafts_updated_at
BEFORE UPDATE ON public.rent_request_drafts
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Server-side per-tenant max so UI + edge can rank readiness consistently.
-- Mirrors classifyAgent thresholds in src/hooks/useAgentCapacityMap.ts.
CREATE OR REPLACE FUNCTION public.agent_per_tenant_max(_agent_id uuid)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_active_count int := 0;
  v_expected_tenant_days int := 0;
  v_responding_days int := 0;
  v_rate numeric := 0;
BEGIN
  SELECT COUNT(*) INTO v_active_count
  FROM rent_requests
  WHERE agent_id = _agent_id AND tenancy_status = 'active';

  IF v_active_count = 0 THEN
    RETURN 500000;  -- Starter
  END IF;

  v_expected_tenant_days := v_active_count * 7;

  SELECT COUNT(DISTINCT (rr.tenant_id, date(r.created_at AT TIME ZONE 'Africa/Kampala')))
  INTO v_responding_days
  FROM repayments r
  JOIN rent_requests rr ON rr.id = r.rent_request_id
  WHERE rr.agent_id = _agent_id
    AND r.created_at > now() - interval '7 days'
    AND r.amount > 0;

  v_rate := LEAST(1.0, v_responding_days::numeric / NULLIF(v_expected_tenant_days,0));

  IF v_rate >= 0.70 THEN RETURN 6000000;
  ELSIF v_rate >= 0.40 THEN RETURN 3000000;
  ELSIF v_rate >= 0.10 THEN RETURN 1000000;
  ELSE RETURN 0;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.agent_per_tenant_max(uuid) TO authenticated, service_role;
