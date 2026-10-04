CREATE OR REPLACE FUNCTION public.agent_ops_whitelist_admin(_user_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id
      AND COALESCE(enabled, true) = true
      AND role IN ('agent_ops','operations','coo','manager','super_admin')
  );
$$;

CREATE TABLE IF NOT EXISTS public.agent_subagent_commission_whitelist (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sub_agent_id uuid NOT NULL UNIQUE,
  whitelisted boolean NOT NULL DEFAULT true,
  reason text NOT NULL,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.agent_subagent_commission_whitelist TO authenticated;
GRANT ALL ON public.agent_subagent_commission_whitelist TO service_role;
ALTER TABLE public.agent_subagent_commission_whitelist ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ops read subagent commission whitelist" ON public.agent_subagent_commission_whitelist;
CREATE POLICY "ops read subagent commission whitelist"
ON public.agent_subagent_commission_whitelist
FOR SELECT TO authenticated
USING (
  sub_agent_id = (SELECT auth.uid())
  OR (SELECT public.agent_ops_whitelist_admin((SELECT auth.uid())))
);

CREATE OR REPLACE FUNCTION public.is_subagent_commission_whitelisted(p_sub_agent_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.agent_subagent_commission_whitelist w
    WHERE w.sub_agent_id = p_sub_agent_id AND w.whitelisted = true
  );
$$;

CREATE OR REPLACE FUNCTION public.agent_ops_set_subagent_commission_whitelist(
  p_sub_agent_id uuid,
  p_whitelisted boolean,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL OR NOT public.agent_ops_whitelist_admin(v_uid) THEN
    RAISE EXCEPTION 'Agent Ops role required' USING ERRCODE = '42501';
  END IF;
  IF p_sub_agent_id IS NULL THEN
    RAISE EXCEPTION 'Sub-agent is required';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'A reason of at least 10 characters is required';
  END IF;

  INSERT INTO public.agent_subagent_commission_whitelist
    (sub_agent_id, whitelisted, reason, updated_by)
  VALUES (p_sub_agent_id, COALESCE(p_whitelisted, false), btrim(p_reason), v_uid)
  ON CONFLICT (sub_agent_id) DO UPDATE
    SET whitelisted = EXCLUDED.whitelisted,
        reason      = EXCLUDED.reason,
        updated_by  = EXCLUDED.updated_by,
        updated_at  = now();

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, new_values)
  VALUES (
    v_uid,
    CASE WHEN COALESCE(p_whitelisted, false) THEN 'subagent_commission_whitelist_enabled'
         ELSE 'subagent_commission_whitelist_disabled' END,
    'agent_subagent_commission_whitelist',
    p_sub_agent_id,
    btrim(p_reason),
    jsonb_build_object('sub_agent_id', p_sub_agent_id, 'whitelisted', COALESCE(p_whitelisted, false))
  );

  RETURN jsonb_build_object('success', true, 'sub_agent_id', p_sub_agent_id, 'whitelisted', COALESCE(p_whitelisted, false));
END;
$$;

CREATE OR REPLACE FUNCTION public.agent_ops_list_subagent_commission_whitelist(p_search text DEFAULT NULL)
RETURNS TABLE(
  sub_agent_id uuid,
  sub_agent_name text,
  sub_agent_phone text,
  parent_agent_id uuid,
  parent_agent_name text,
  link_status text,
  whitelisted boolean,
  reason text,
  updated_at timestamptz,
  collections_30d numeric,
  commission_30d numeric
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL OR NOT public.agent_ops_whitelist_admin(v_uid) THEN
    RAISE EXCEPTION 'Agent Ops role required' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    sa.sub_agent_id,
    COALESCE(sp.full_name, 'Sub-agent'),
    sp.phone,
    sa.parent_agent_id,
    COALESCE(pp.full_name, 'Parent agent'),
    sa.status,
    COALESCE(w.whitelisted, false),
    w.reason,
    w.updated_at,
    COALESCE(c.total_amount, 0),
    COALESCE(c.total_commission, 0)
  FROM public.agent_subagents sa
  LEFT JOIN public.profiles sp ON sp.id = sa.sub_agent_id
  LEFT JOIN public.profiles pp ON pp.id = sa.parent_agent_id
  LEFT JOIN public.agent_subagent_commission_whitelist w ON w.sub_agent_id = sa.sub_agent_id
  LEFT JOIN LATERAL (
    SELECT SUM(ac.amount) AS total_amount, round(SUM(ac.amount) * 0.10, 2) AS total_commission
    FROM public.agent_collections ac
    WHERE ac.agent_id = sa.sub_agent_id
      AND ac.created_at >= now() - interval '30 days'
  ) c ON true
  WHERE sa.status IN ('verified','approved','accepted','active')
    AND sa.parent_agent_id IS DISTINCT FROM sa.sub_agent_id
    AND (
      p_search IS NULL OR btrim(p_search) = ''
      OR sp.full_name ILIKE '%' || btrim(p_search) || '%'
      OR sp.phone ILIKE '%' || btrim(p_search) || '%'
      OR pp.full_name ILIKE '%' || btrim(p_search) || '%'
    )
  ORDER BY COALESCE(w.whitelisted, false) DESC, COALESCE(c.total_amount, 0) DESC
  LIMIT 500;
END;
$$;