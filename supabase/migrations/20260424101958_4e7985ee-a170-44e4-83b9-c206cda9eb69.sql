-- ============================================================
-- 1. agent_capabilities table — FK to auth.users (canonical)
-- ============================================================
CREATE TABLE public.agent_capabilities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  capability text NOT NULL,
  context_type text,
  context_id uuid,
  status text NOT NULL DEFAULT 'active',
  granted_by uuid REFERENCES auth.users(id),
  revoked_by uuid REFERENCES auth.users(id),
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_capability CHECK (capability IN (
    'collect_rent','onboard_tenants','onboard_landlords','capture_supporters',
    'act_as_proxy','process_cash_out','manage_subagents','approve_subagents',
    'request_float','view_agent_dashboard'
  )),
  CONSTRAINT chk_status CHECK (status IN ('active','suspended','revoked')),
  CONSTRAINT uniq_capability UNIQUE (agent_id, capability, context_type, context_id)
);

CREATE INDEX idx_agent_capabilities_agent ON public.agent_capabilities(agent_id) WHERE status = 'active';
CREATE INDEX idx_agent_capabilities_lookup ON public.agent_capabilities(agent_id, capability) WHERE status = 'active';

COMMENT ON TABLE public.agent_capabilities IS
  'Per-agent capability registry. Source of truth for fine-grained agent permissions, layered on top of broad roles. FK targets auth.users so it is never blocked by missing profile rows.';

CREATE TRIGGER trg_agent_capabilities_updated_at
BEFORE UPDATE ON public.agent_capabilities
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

-- ============================================================
-- 2. RLS — agents read own; staff manage all
-- ============================================================
ALTER TABLE public.agent_capabilities ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Agents can view own capabilities"
ON public.agent_capabilities FOR SELECT
USING (agent_id = auth.uid());

CREATE POLICY "Staff can view all capabilities"
ON public.agent_capabilities FOR SELECT
USING (
  public.has_role(auth.uid(), 'manager'::app_role)
  OR public.has_role(auth.uid(), 'coo'::app_role)
  OR public.has_role(auth.uid(), 'super_admin'::app_role)
);

CREATE POLICY "Staff can grant capabilities"
ON public.agent_capabilities FOR INSERT
WITH CHECK (
  public.has_role(auth.uid(), 'manager'::app_role)
  OR public.has_role(auth.uid(), 'coo'::app_role)
  OR public.has_role(auth.uid(), 'super_admin'::app_role)
);

CREATE POLICY "Staff can update capabilities"
ON public.agent_capabilities FOR UPDATE
USING (
  public.has_role(auth.uid(), 'manager'::app_role)
  OR public.has_role(auth.uid(), 'coo'::app_role)
  OR public.has_role(auth.uid(), 'super_admin'::app_role)
);

CREATE POLICY "Super admin can delete capabilities"
ON public.agent_capabilities FOR DELETE
USING (public.has_role(auth.uid(), 'super_admin'::app_role));

-- ============================================================
-- 3. agent_relationships VIEW (alias over agent_subagents)
-- ============================================================
CREATE VIEW public.agent_relationships AS
SELECT
  id,
  parent_agent_id,
  sub_agent_id,
  status,
  source,
  verified_by  AS approved_by,
  verified_at  AS approved_at,
  rejection_reason,
  NULL::uuid        AS revoked_by,
  NULL::timestamptz AS revoked_at,
  created_at,
  created_at AS updated_at
FROM public.agent_subagents;

COMMENT ON VIEW public.agent_relationships IS
  'Read-only alias over agent_subagents with normalized column names. Use this in new code; legacy code continues using agent_subagents directly.';

-- ============================================================
-- 4. RPC helpers (5, all SECURITY DEFINER STABLE)
-- ============================================================
CREATE OR REPLACE FUNCTION public.has_agent_capability(_agent_id uuid, _capability text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.agent_capabilities
    WHERE agent_id = _agent_id AND capability = _capability AND status = 'active'
  );
$$;

CREATE OR REPLACE FUNCTION public.is_sub_agent(_agent_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.agent_subagents
    WHERE sub_agent_id = _agent_id AND status = 'verified'
  );
$$;

CREATE OR REPLACE FUNCTION public.is_parent_agent(_agent_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.agent_subagents
    WHERE parent_agent_id = _agent_id AND status = 'verified'
  );
$$;

CREATE OR REPLACE FUNCTION public.is_proxy_for(_agent_id uuid, _beneficiary_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.proxy_agent_assignments
    WHERE agent_id = _agent_id
      AND beneficiary_id = _beneficiary_id
      AND is_active = true
  )
  AND public.has_agent_capability(_agent_id, 'act_as_proxy');
$$;

CREATE OR REPLACE FUNCTION public.can_process_cashout(_agent_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.cashout_agents
    WHERE agent_id = _agent_id AND is_active = true
  )
  AND public.has_agent_capability(_agent_id, 'process_cash_out');
$$;

-- ============================================================
-- 5. Auto-grant trigger
-- ============================================================
CREATE OR REPLACE FUNCTION public.grant_default_agent_capabilities()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NEW.role = 'agent' AND NEW.enabled = true THEN
    INSERT INTO public.agent_capabilities (agent_id, capability)
    SELECT NEW.user_id, cap
    FROM unnest(ARRAY[
      'collect_rent','onboard_tenants','onboard_landlords',
      'capture_supporters','view_agent_dashboard','request_float'
    ]) AS cap
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_grant_default_agent_capabilities
AFTER INSERT OR UPDATE OF enabled ON public.user_roles
FOR EACH ROW
EXECUTE FUNCTION public.grant_default_agent_capabilities();

-- ============================================================
-- 6. BACKFILL — ~35K rows, all idempotent
-- ============================================================

-- 6a. Field Agent kit for all active agents (≈ 35,166 rows for 5,841 agents w/ profile)
INSERT INTO public.agent_capabilities (agent_id, capability)
SELECT ur.user_id, cap
FROM public.user_roles ur
CROSS JOIN unnest(ARRAY[
  'collect_rent','onboard_tenants','onboard_landlords',
  'capture_supporters','view_agent_dashboard','request_float'
]) AS cap
WHERE ur.role = 'agent' AND ur.enabled = true
  AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = ur.user_id)
ON CONFLICT DO NOTHING;

-- 6b. Subagent management for verified parents
INSERT INTO public.agent_capabilities (agent_id, capability)
SELECT DISTINCT s.parent_agent_id, cap
FROM public.agent_subagents s
CROSS JOIN unnest(ARRAY['manage_subagents','approve_subagents']) AS cap
WHERE s.status = 'verified'
  AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = s.parent_agent_id)
ON CONFLICT DO NOTHING;

-- 6c. Proxy capability for active proxy agents
INSERT INTO public.agent_capabilities (agent_id, capability)
SELECT DISTINCT a.agent_id, 'act_as_proxy'
FROM public.proxy_agent_assignments a
WHERE a.is_active = true
  AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = a.agent_id)
ON CONFLICT DO NOTHING;

-- 6d. Cash-out capability for active cashout agents
INSERT INTO public.agent_capabilities (agent_id, capability)
SELECT DISTINCT c.agent_id, 'process_cash_out'
FROM public.cashout_agents c
WHERE c.is_active = true
  AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = c.agent_id)
ON CONFLICT DO NOTHING;