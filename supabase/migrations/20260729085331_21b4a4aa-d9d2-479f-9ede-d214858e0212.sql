
-- 1. Idle state table
CREATE TABLE IF NOT EXISTS public.tenant_idle_states (
  rent_request_id uuid PRIMARY KEY REFERENCES public.rent_requests(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  cadence text NOT NULL DEFAULT 'unknown' CHECK (cadence IN ('daily','weekly','unknown')),
  last_collection_at timestamptz,
  days_idle integer NOT NULL DEFAULT 0,
  state text NOT NULL DEFAULT 'healthy' CHECK (state IN ('healthy','warn','at_risk','reassign_ready')),
  warned_at timestamptz,
  at_risk_at timestamptz,
  reassign_ready_at timestamptz,
  resolved_at timestamptz,
  resolved_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tenant_idle_states_agent ON public.tenant_idle_states(agent_id) WHERE state <> 'healthy';
CREATE INDEX IF NOT EXISTS idx_tenant_idle_states_state ON public.tenant_idle_states(state) WHERE state IN ('at_risk','reassign_ready');

GRANT SELECT ON public.tenant_idle_states TO authenticated;
GRANT ALL ON public.tenant_idle_states TO service_role;
ALTER TABLE public.tenant_idle_states ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Agents see their own idle rows"
  ON public.tenant_idle_states FOR SELECT TO authenticated
  USING (
    agent_id = auth.uid()
    OR public.has_role(auth.uid(), 'agent_ops')
    OR public.has_role(auth.uid(), 'coo')
    OR public.has_role(auth.uid(), 'manager')
    OR public.has_role(auth.uid(), 'super_admin')
  );

-- 2. Reassignment audit
CREATE TABLE IF NOT EXISTS public.tenant_reassignment_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rent_request_id uuid NOT NULL REFERENCES public.rent_requests(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL,
  old_agent_id uuid NOT NULL,
  new_agent_id uuid NOT NULL,
  reason text NOT NULL,
  actor_id uuid NOT NULL,
  days_idle integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tenant_reassignment_audit_tenant ON public.tenant_reassignment_audit(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tenant_reassignment_audit_old_agent ON public.tenant_reassignment_audit(old_agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tenant_reassignment_audit_new_agent ON public.tenant_reassignment_audit(new_agent_id, created_at DESC);

GRANT SELECT ON public.tenant_reassignment_audit TO authenticated;
GRANT ALL ON public.tenant_reassignment_audit TO service_role;
ALTER TABLE public.tenant_reassignment_audit ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Agents see audit rows involving them; ops see all"
  ON public.tenant_reassignment_audit FOR SELECT TO authenticated
  USING (
    old_agent_id = auth.uid()
    OR new_agent_id = auth.uid()
    OR public.has_role(auth.uid(), 'agent_ops')
    OR public.has_role(auth.uid(), 'coo')
    OR public.has_role(auth.uid(), 'manager')
    OR public.has_role(auth.uid(), 'super_admin')
  );

-- 3. Refresh RPC (rebuild idle state from agent_collections)
CREATE OR REPLACE FUNCTION public.refresh_tenant_idle_states()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rows integer := 0;
BEGIN
  -- Upsert one row per active rent_request, computing cadence + state.
  WITH active AS (
    SELECT rr.id AS rent_request_id,
           rr.tenant_id,
           COALESCE(rr.assigned_agent_id, rr.agent_id) AS agent_id
    FROM public.rent_requests rr
    WHERE rr.tenancy_status = 'active'
      AND rr.status IN ('funded','disbursed','repaying')
      AND COALESCE(rr.assigned_agent_id, rr.agent_id) IS NOT NULL
  ),
  last_col AS (
    SELECT a.rent_request_id,
           MAX(ac.created_at) AS last_at
    FROM active a
    LEFT JOIN public.agent_collections ac
      ON ac.tenant_id = a.tenant_id AND ac.agent_id = a.agent_id
    GROUP BY a.rent_request_id
  ),
  gaps AS (
    -- Median gap in days from last 5 collections per (tenant, agent)
    SELECT tenant_id, agent_id,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY gap_days) AS median_gap,
           COUNT(*) AS gap_count
    FROM (
      SELECT ac.tenant_id, ac.agent_id,
             EXTRACT(EPOCH FROM (ac.created_at - LEAD(ac.created_at) OVER (
               PARTITION BY ac.tenant_id, ac.agent_id ORDER BY ac.created_at DESC
             ))) / 86400.0 AS gap_days,
             ROW_NUMBER() OVER (PARTITION BY ac.tenant_id, ac.agent_id ORDER BY ac.created_at DESC) AS rn
      FROM public.agent_collections ac
    ) g
    WHERE rn <= 5 AND gap_days IS NOT NULL
    GROUP BY tenant_id, agent_id
  ),
  computed AS (
    SELECT a.rent_request_id,
           a.tenant_id,
           a.agent_id,
           lc.last_at,
           CASE
             WHEN sc.frequency = 'weekly' THEN 'weekly'
             WHEN sc.frequency = 'daily'  THEN 'daily'
             WHEN gp.median_gap IS NOT NULL AND gp.gap_count >= 2 AND gp.median_gap >= 4 THEN 'weekly'
             WHEN gp.median_gap IS NOT NULL AND gp.gap_count >= 2 THEN 'daily'
             ELSE 'unknown'
           END AS cadence,
           GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - lc.last_at)) / 86400.0))::int AS days_idle
    FROM active a
    LEFT JOIN last_col lc ON lc.rent_request_id = a.rent_request_id
    LEFT JOIN gaps gp ON gp.tenant_id = a.tenant_id AND gp.agent_id = a.agent_id
    LEFT JOIN LATERAL (
      SELECT frequency FROM public.subscription_charges
      WHERE rent_request_id = a.rent_request_id
      ORDER BY created_at DESC LIMIT 1
    ) sc ON TRUE
  ),
  classified AS (
    SELECT c.*,
           CASE cadence WHEN 'weekly' THEN 10 ELSE 5 END AS warn_at,
           CASE cadence WHEN 'weekly' THEN 15 ELSE 8 END AS risk_at,
           CASE cadence WHEN 'weekly' THEN 20 ELSE 12 END AS ready_at
      FROM computed c
  ),
  final AS (
    SELECT rent_request_id, tenant_id, agent_id, cadence, last_at AS last_collection_at, days_idle,
           CASE
             WHEN cadence = 'unknown' AND days_idle >= warn_at THEN 'warn'
             WHEN days_idle >= ready_at AND cadence <> 'unknown' THEN 'reassign_ready'
             WHEN days_idle >= risk_at  AND cadence <> 'unknown' THEN 'at_risk'
             WHEN days_idle >= warn_at THEN 'warn'
             ELSE 'healthy'
           END AS state
      FROM classified
  )
  INSERT INTO public.tenant_idle_states AS t (
    rent_request_id, tenant_id, agent_id, cadence, last_collection_at, days_idle, state,
    warned_at, at_risk_at, reassign_ready_at, updated_at
  )
  SELECT f.rent_request_id, f.tenant_id, f.agent_id, f.cadence, f.last_collection_at, f.days_idle, f.state,
         CASE WHEN f.state IN ('warn','at_risk','reassign_ready') THEN now() END,
         CASE WHEN f.state IN ('at_risk','reassign_ready') THEN now() END,
         CASE WHEN f.state = 'reassign_ready' THEN now() END,
         now()
    FROM final f
  ON CONFLICT (rent_request_id) DO UPDATE
    SET tenant_id          = EXCLUDED.tenant_id,
        agent_id           = EXCLUDED.agent_id,
        cadence            = EXCLUDED.cadence,
        last_collection_at = EXCLUDED.last_collection_at,
        days_idle          = EXCLUDED.days_idle,
        state              = EXCLUDED.state,
        warned_at          = COALESCE(t.warned_at, EXCLUDED.warned_at),
        at_risk_at         = CASE WHEN EXCLUDED.state IN ('at_risk','reassign_ready')
                                   THEN COALESCE(t.at_risk_at, EXCLUDED.at_risk_at) END,
        reassign_ready_at  = CASE WHEN EXCLUDED.state = 'reassign_ready'
                                   THEN COALESCE(t.reassign_ready_at, EXCLUDED.reassign_ready_at) END,
        resolved_at        = CASE WHEN EXCLUDED.state = 'healthy' THEN now() ELSE NULL END,
        updated_at         = now();

  GET DIAGNOSTICS v_rows = ROW_COUNT;

  -- Delete stale rows for rent_requests no longer active.
  DELETE FROM public.tenant_idle_states t
   WHERE NOT EXISTS (
     SELECT 1 FROM public.rent_requests rr
      WHERE rr.id = t.rent_request_id
        AND rr.tenancy_status = 'active'
        AND rr.status IN ('funded','disbursed','repaying')
   );

  RETURN v_rows;
END;
$$;

REVOKE ALL ON FUNCTION public.refresh_tenant_idle_states() FROM public;
GRANT EXECUTE ON FUNCTION public.refresh_tenant_idle_states() TO service_role;

-- 4. Reassignment RPC
CREATE OR REPLACE FUNCTION public.agent_ops_reassign_idle_tenant(
  p_rent_request_id uuid,
  p_new_agent_id uuid,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_old_agent uuid;
  v_tenant uuid;
  v_days integer;
  v_new_recent boolean;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;

  IF NOT (
    public.has_role(v_actor, 'agent_ops')
    OR public.has_role(v_actor, 'coo')
    OR public.has_role(v_actor, 'manager')
    OR public.has_role(v_actor, 'super_admin')
  ) THEN
    RAISE EXCEPTION 'Only Agent Ops, COO or Manager may reassign tenants' USING ERRCODE = '42501';
  END IF;

  IF p_reason IS NULL OR length(trim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'Reason must be at least 10 characters' USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(assigned_agent_id, agent_id), tenant_id
    INTO v_old_agent, v_tenant
    FROM public.rent_requests
   WHERE id = p_rent_request_id
     FOR UPDATE;

  IF v_old_agent IS NULL THEN
    RAISE EXCEPTION 'Rent request not found' USING ERRCODE = 'P0002';
  END IF;

  IF v_old_agent = p_new_agent_id THEN
    RAISE EXCEPTION 'New agent must differ from current agent' USING ERRCODE = '22023';
  END IF;

  -- Target agent must have collected in the last 3 days.
  SELECT EXISTS (
    SELECT 1 FROM public.agent_collections
     WHERE agent_id = p_new_agent_id
       AND created_at >= now() - interval '3 days'
  ) INTO v_new_recent;

  IF NOT v_new_recent THEN
    RAISE EXCEPTION 'Target agent has no collections in the last 3 days' USING ERRCODE = '22023';
  END IF;

  SELECT days_idle INTO v_days FROM public.tenant_idle_states WHERE rent_request_id = p_rent_request_id;

  UPDATE public.rent_requests
     SET assigned_agent_id = p_new_agent_id,
         updated_at = now()
   WHERE id = p_rent_request_id;

  INSERT INTO public.tenant_reassignment_audit (
    rent_request_id, tenant_id, old_agent_id, new_agent_id, reason, actor_id, days_idle
  ) VALUES (
    p_rent_request_id, v_tenant, v_old_agent, p_new_agent_id, p_reason, v_actor, v_days
  );

  -- Clear idle-state row; the next cron tick will rebuild it under the new agent.
  DELETE FROM public.tenant_idle_states WHERE rent_request_id = p_rent_request_id;

  -- Emit system event for downstream SMS/notifications.
  BEGIN
    INSERT INTO public.system_events (event_type, actor_id, subject_id, payload)
    VALUES (
      'role_changed', v_actor, v_tenant,
      jsonb_build_object(
        'kind', 'tenant.reassigned',
        'rent_request_id', p_rent_request_id,
        'old_agent_id', v_old_agent,
        'new_agent_id', p_new_agent_id,
        'reason', p_reason,
        'days_idle', v_days
      )
    );
  EXCEPTION WHEN OTHERS THEN
    -- system_events shape can vary; never block the reassignment.
    NULL;
  END;

  RETURN jsonb_build_object(
    'success', true,
    'rent_request_id', p_rent_request_id,
    'old_agent_id', v_old_agent,
    'new_agent_id', p_new_agent_id,
    'days_idle', v_days
  );
END;
$$;

REVOKE ALL ON FUNCTION public.agent_ops_reassign_idle_tenant(uuid, uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION public.agent_ops_reassign_idle_tenant(uuid, uuid, text) TO authenticated, service_role;
