CREATE TABLE IF NOT EXISTS public.service_centre_agent_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_centre_id uuid NOT NULL REFERENCES public.service_centre_setups(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL,
  role_note text,
  status text NOT NULL DEFAULT 'active',
  assigned_by uuid,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  unassigned_by uuid,
  unassigned_at timestamptz,
  unassign_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_sc_agent_assignment_active
  ON public.service_centre_agent_assignments (service_centre_id, agent_id)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_sc_agent_assignment_centre ON public.service_centre_agent_assignments (service_centre_id);
CREATE INDEX IF NOT EXISTS idx_sc_agent_assignment_agent ON public.service_centre_agent_assignments (agent_id);

GRANT SELECT, INSERT, UPDATE ON public.service_centre_agent_assignments TO authenticated;
GRANT ALL ON public.service_centre_agent_assignments TO service_role;

ALTER TABLE public.service_centre_agent_assignments ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.sc_assignment_admin(_user_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT public.has_role(_user_id, 'agent_ops')
      OR public.has_role(_user_id, 'operations')
      OR public.has_role(_user_id, 'manager')
      OR public.has_role(_user_id, 'coo')
      OR public.has_role(_user_id, 'ceo')
      OR public.has_role(_user_id, 'cfo')
      OR public.has_role(_user_id, 'super_admin');
$$;

REVOKE ALL ON FUNCTION public.sc_assignment_admin(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sc_assignment_admin(uuid) TO authenticated, service_role;

CREATE POLICY "Ops manage service centre agent assignments"
  ON public.service_centre_agent_assignments
  FOR ALL TO authenticated
  USING (public.sc_assignment_admin((SELECT auth.uid())))
  WITH CHECK (public.sc_assignment_admin((SELECT auth.uid())));

CREATE POLICY "Agents view own service centre assignment"
  ON public.service_centre_agent_assignments
  FOR SELECT TO authenticated
  USING (agent_id = (SELECT auth.uid()));

CREATE TRIGGER trg_sc_agent_assignments_updated_at
  BEFORE UPDATE ON public.service_centre_agent_assignments
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

/* ── assign one or more agents (idempotent, single round trip) ── */
CREATE OR REPLACE FUNCTION public.service_centre_assign_agents(
  p_service_centre_id uuid,
  p_agent_ids uuid[],
  p_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_inserted int := 0;
BEGIN
  IF v_actor IS NULL OR NOT public.sc_assignment_admin(v_actor) THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;
  IF p_agent_ids IS NULL OR array_length(p_agent_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'no_agents_selected';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.service_centre_setups WHERE id = p_service_centre_id) THEN
    RAISE EXCEPTION 'service_centre_not_found';
  END IF;

  WITH ins AS (
    INSERT INTO public.service_centre_agent_assignments
      (service_centre_id, agent_id, role_note, assigned_by)
    SELECT p_service_centre_id, a, NULLIF(btrim(COALESCE(p_note, '')), ''), v_actor
    FROM unnest(p_agent_ids) AS a
    WHERE NOT EXISTS (
      SELECT 1 FROM public.service_centre_agent_assignments x
      WHERE x.service_centre_id = p_service_centre_id
        AND x.agent_id = a
        AND x.status = 'active'
    )
    RETURNING 1
  )
  SELECT count(*) INTO v_inserted FROM ins;

  RETURN jsonb_build_object(
    'assigned', v_inserted,
    'skipped', array_length(p_agent_ids, 1) - v_inserted
  );
END;
$$;

REVOKE ALL ON FUNCTION public.service_centre_assign_agents(uuid, uuid[], text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.service_centre_assign_agents(uuid, uuid[], text) TO authenticated, service_role;

/* ── remove an agent from a centre ── */
CREATE OR REPLACE FUNCTION public.service_centre_unassign_agent(
  p_assignment_id uuid,
  p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_rows int;
BEGIN
  IF v_actor IS NULL OR NOT public.sc_assignment_admin(v_actor) THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  UPDATE public.service_centre_agent_assignments
     SET status = 'removed',
         unassigned_by = v_actor,
         unassigned_at = now(),
         unassign_reason = NULLIF(btrim(COALESCE(p_reason, '')), '')
   WHERE id = p_assignment_id AND status = 'active';
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  IF v_rows = 0 THEN
    RAISE EXCEPTION 'assignment_not_active';
  END IF;
  RETURN jsonb_build_object('removed', v_rows);
END;
$$;

REVOKE ALL ON FUNCTION public.service_centre_unassign_agent(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.service_centre_unassign_agent(uuid, text) TO authenticated, service_role;

/* ── one-request 360 view of a service centre ── */
CREATE OR REPLACE FUNCTION public.get_service_centre_360(p_service_centre_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_centre record;
  v_agents uuid[];
  v_result jsonb;
BEGIN
  IF v_actor IS NULL OR NOT public.sc_assignment_admin(v_actor) THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  SELECT * INTO v_centre FROM public.service_centre_setups WHERE id = p_service_centre_id;
  IF v_centre IS NULL THEN
    RAISE EXCEPTION 'service_centre_not_found';
  END IF;

  SELECT array_agg(DISTINCT a) INTO v_agents
  FROM (
    SELECT v_centre.agent_id AS a
    UNION
    SELECT agent_id FROM public.service_centre_agent_assignments
     WHERE service_centre_id = p_service_centre_id AND status = 'active'
  ) s;

  SELECT jsonb_build_object(
    'currency', 'UGX',
    'centre', jsonb_build_object(
      'id', v_centre.id,
      'agent_id', v_centre.agent_id,
      'agent_name', v_centre.agent_name,
      'agent_phone', v_centre.agent_phone,
      'location_name', v_centre.location_name,
      'latitude', v_centre.latitude,
      'longitude', v_centre.longitude,
      'status', v_centre.status,
      'created_at', v_centre.created_at,
      'verified_at', v_centre.verified_at,
      'approved_at', v_centre.approved_at,
      'rejection_reason', v_centre.rejection_reason,
      'verified_amount', v_centre.verified_amount,
      'cfo_approved_amount', v_centre.cfo_approved_amount,
      'cfo_decision', v_centre.cfo_decision,
      'payee_name', v_centre.payee_name
    ),
    'assigned_agents', COALESCE((
      SELECT jsonb_agg(r ORDER BY r->>'assigned_at' DESC) FROM (
        SELECT jsonb_build_object(
          'assignment_id', asg.id,
          'agent_id', asg.agent_id,
          'agent_name', COALESCE(p.full_name, 'Unknown'),
          'agent_phone', p.phone,
          'role_note', asg.role_note,
          'assigned_at', asg.assigned_at,
          'assigned_by_name', ab.full_name,
          'collected_30d', COALESCE(c30.total, 0),
          'collections_30d', COALESCE(c30.cnt, 0)
        ) AS r
        FROM public.service_centre_agent_assignments asg
        LEFT JOIN public.profiles p ON p.id = asg.agent_id
        LEFT JOIN public.profiles ab ON ab.id = asg.assigned_by
        LEFT JOIN (
          SELECT agent_id, SUM(amount) AS total, COUNT(*) AS cnt
          FROM public.agent_collections
          WHERE created_at >= now() - interval '30 days'
          GROUP BY agent_id
        ) c30 ON c30.agent_id = asg.agent_id
        WHERE asg.service_centre_id = p_service_centre_id AND asg.status = 'active'
      ) q
    ), '[]'::jsonb),
    'removed_agents', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'assignment_id', asg.id,
        'agent_name', COALESCE(p.full_name, 'Unknown'),
        'unassigned_at', asg.unassigned_at,
        'unassign_reason', asg.unassign_reason
      ) ORDER BY asg.unassigned_at DESC)
      FROM public.service_centre_agent_assignments asg
      LEFT JOIN public.profiles p ON p.id = asg.agent_id
      WHERE asg.service_centre_id = p_service_centre_id AND asg.status = 'removed'
    ), '[]'::jsonb),
    'repayment_totals', (
      SELECT jsonb_build_object(
        'collected_today', COALESCE(SUM(amount) FILTER (
          WHERE (created_at AT TIME ZONE 'Africa/Kampala')::date = (now() AT TIME ZONE 'Africa/Kampala')::date), 0),
        'collected_7d', COALESCE(SUM(amount) FILTER (WHERE created_at >= now() - interval '7 days'), 0),
        'collected_30d', COALESCE(SUM(amount) FILTER (WHERE created_at >= now() - interval '30 days'), 0),
        'collected_all', COALESCE(SUM(amount), 0),
        'payments', COUNT(*),
        'partial_payments', COUNT(*) FILTER (WHERE is_partial IS TRUE)
      )
      FROM public.agent_collections WHERE agent_id = ANY(v_agents)
    ),
    'repayment_history', COALESCE((
      SELECT jsonb_agg(r) FROM (
        SELECT jsonb_build_object(
          'id', ac.id,
          'created_at', ac.created_at,
          'amount', ac.amount,
          'expected_amount', ac.expected_amount,
          'shortfall_amount', ac.shortfall_amount,
          'is_partial', COALESCE(ac.is_partial, false),
          'payment_method', ac.payment_method::text,
          'agent_id', ac.agent_id,
          'agent_name', COALESCE(ap.full_name, 'Unknown'),
          'tenant_name', COALESCE(tp.full_name, 'Unknown')
        ) AS r
        FROM public.agent_collections ac
        LEFT JOIN public.profiles ap ON ap.id = ac.agent_id
        LEFT JOIN public.profiles tp ON tp.id = ac.tenant_id
        WHERE ac.agent_id = ANY(v_agents)
        ORDER BY ac.created_at DESC
        LIMIT 100
      ) q
    ), '[]'::jsonb),
    'advances', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', adv.id,
        'agent_name', COALESCE(p.full_name, 'Unknown'),
        'principal_amount', adv.principal_amount,
        'amount_recovered', adv.amount_recovered,
        'daily_deduction', adv.daily_deduction,
        'duration_days', adv.duration_days,
        'status', adv.status,
        'attached_at', adv.attached_at
      ) ORDER BY adv.attached_at DESC)
      FROM public.service_centre_advances adv
      LEFT JOIN public.profiles p ON p.id = adv.agent_id
      WHERE adv.agent_id = ANY(v_agents)
    ), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.get_service_centre_360(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_service_centre_360(uuid) TO authenticated, service_role;