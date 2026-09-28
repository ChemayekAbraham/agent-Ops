-- Agent self-track for overdue field-chase (Faith Collections).
-- TAPPED + CALLED on the same Africa/Kampala day = DONE.
-- Intentionally separate from tenant_call_reports / crm_call_sessions (ops RLS).

CREATE TABLE IF NOT EXISTS public.agent_overdue_tenant_touches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  rent_request_id uuid NOT NULL,
  tenant_id uuid NULL,
  -- Calendar day in EAT (Africa/Kampala). DONE requires both stamps same day.
  touch_day date NOT NULL,
  tapped_at timestamptz NULL,
  called_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_overdue_tenant_touches_uniq
    UNIQUE (agent_id, rent_request_id, touch_day)
);

CREATE INDEX IF NOT EXISTS idx_agent_overdue_touches_agent_day
  ON public.agent_overdue_tenant_touches (agent_id, touch_day);

CREATE INDEX IF NOT EXISTS idx_agent_overdue_touches_rr
  ON public.agent_overdue_tenant_touches (rent_request_id);

COMMENT ON TABLE public.agent_overdue_tenant_touches IS
  'Agent self-reported overdue chase touches. DONE = tapped_at AND called_at set for the same EAT touch_day. tel: alone does not write called_at.';

ALTER TABLE public.agent_overdue_tenant_touches ENABLE ROW LEVEL SECURITY;

-- Agents read/write only their own rows.
DROP POLICY IF EXISTS agent_overdue_touches_select_own ON public.agent_overdue_tenant_touches;
CREATE POLICY agent_overdue_touches_select_own
  ON public.agent_overdue_tenant_touches
  FOR SELECT TO authenticated
  USING (agent_id = auth.uid());

DROP POLICY IF EXISTS agent_overdue_touches_insert_own ON public.agent_overdue_tenant_touches;
CREATE POLICY agent_overdue_touches_insert_own
  ON public.agent_overdue_tenant_touches
  FOR INSERT TO authenticated
  WITH CHECK (agent_id = auth.uid());

DROP POLICY IF EXISTS agent_overdue_touches_update_own ON public.agent_overdue_tenant_touches;
CREATE POLICY agent_overdue_touches_update_own
  ON public.agent_overdue_tenant_touches
  FOR UPDATE TO authenticated
  USING (agent_id = auth.uid())
  WITH CHECK (agent_id = auth.uid());

-- Staff/admin read for coverage dashboards (optional surface).
DROP POLICY IF EXISTS agent_overdue_touches_staff_select ON public.agent_overdue_tenant_touches;
CREATE POLICY agent_overdue_touches_staff_select
  ON public.agent_overdue_tenant_touches
  FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'ceo')
    OR public.has_role(auth.uid(), 'coo')
    OR public.has_role(auth.uid(), 'cfo')
    OR public.has_role(auth.uid(), 'cto')
    OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'manager')
    OR public.has_role(auth.uid(), 'operations')
  );

CREATE OR REPLACE FUNCTION public.agent_overdue_touch_eat_day()
RETURNS date
LANGUAGE sql
STABLE
AS $$
  SELECT (now() AT TIME ZONE 'Africa/Kampala')::date;
$$;

-- Upsert a tap or call event for the signed-in agent on today's EAT day.
CREATE OR REPLACE FUNCTION public.agent_overdue_touch_mark(
  p_rent_request_id uuid,
  p_event text,
  p_tenant_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_agent uuid := auth.uid();
  v_day date := public.agent_overdue_touch_eat_day();
  v_row public.agent_overdue_tenant_touches%ROWTYPE;
BEGIN
  IF v_agent IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF p_rent_request_id IS NULL THEN
    RAISE EXCEPTION 'rent_request_id required';
  END IF;
  IF p_event IS DISTINCT FROM 'tapped' AND p_event IS DISTINCT FROM 'called' THEN
    RAISE EXCEPTION 'p_event must be tapped or called';
  END IF;

  INSERT INTO public.agent_overdue_tenant_touches AS t (
    agent_id, rent_request_id, tenant_id, touch_day,
    tapped_at, called_at
  ) VALUES (
    v_agent,
    p_rent_request_id,
    p_tenant_id,
    v_day,
    CASE WHEN p_event IN ('tapped', 'called') THEN now() ELSE NULL END,
    CASE WHEN p_event = 'called' THEN now() ELSE NULL END
  )
  ON CONFLICT (agent_id, rent_request_id, touch_day) DO UPDATE SET
    tenant_id = COALESCE(EXCLUDED.tenant_id, t.tenant_id),
    -- Explicit Call CTA / Mark called also stamps tap if missing.
    -- Raw tel: never reaches this RPC (client must call it).
    tapped_at = CASE
      WHEN p_event IN ('tapped', 'called') THEN COALESCE(t.tapped_at, now())
      ELSE t.tapped_at
    END,
    called_at = CASE
      WHEN p_event = 'called' THEN COALESCE(t.called_at, now())
      ELSE t.called_at
    END,
    updated_at = now()
  RETURNING * INTO v_row;

  RETURN jsonb_build_object(
    'id', v_row.id,
    'agent_id', v_row.agent_id,
    'rent_request_id', v_row.rent_request_id,
    'tenant_id', v_row.tenant_id,
    'touch_day', v_row.touch_day,
    'tapped_at', v_row.tapped_at,
    'called_at', v_row.called_at,
    'done', (v_row.tapped_at IS NOT NULL AND v_row.called_at IS NOT NULL)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.agent_overdue_touch_mark(uuid, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.agent_overdue_touch_mark(uuid, text, uuid) TO authenticated;

-- Today's touch map for the signed-in agent (or staff viewing p_agent_id).
CREATE OR REPLACE FUNCTION public.agent_overdue_touches_today(
  p_agent_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_agent uuid;
  v_day date := public.agent_overdue_touch_eat_day();
  v_rows jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  v_agent := COALESCE(p_agent_id, v_uid);

  IF v_agent <> v_uid AND NOT (
    public.has_role(v_uid, 'ceo')
    OR public.has_role(v_uid, 'coo')
    OR public.has_role(v_uid, 'cfo')
    OR public.has_role(v_uid, 'cto')
    OR public.has_role(v_uid, 'super_admin')
    OR public.has_role(v_uid, 'manager')
    OR public.has_role(v_uid, 'operations')
  ) THEN
    RAISE EXCEPTION 'not allowed';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'rent_request_id', t.rent_request_id,
    'tenant_id', t.tenant_id,
    'touch_day', t.touch_day,
    'tapped_at', t.tapped_at,
    'called_at', t.called_at,
    'done', (t.tapped_at IS NOT NULL AND t.called_at IS NOT NULL)
  ) ORDER BY t.updated_at DESC), '[]'::jsonb)
  INTO v_rows
  FROM public.agent_overdue_tenant_touches t
  WHERE t.agent_id = v_agent
    AND t.touch_day = v_day;

  RETURN jsonb_build_object(
    'agent_id', v_agent,
    'touch_day', v_day,
    'touches', v_rows
  );
END;
$$;

REVOKE ALL ON FUNCTION public.agent_overdue_touches_today(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.agent_overdue_touches_today(uuid) TO authenticated;
