-- =============================================================
-- AGENT OPS: Capability management at scale (1M+ agents)
-- Builds on existing agent_capabilities table + has_agent_capability RPC
-- =============================================================

-- 1) Tier enum + column on profiles ----------------------------
DO $$ BEGIN
  CREATE TYPE public.agent_tier AS ENUM (
    'probation',
    'collector',
    'full_agent',
    'senior',
    'suspended'
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS agent_tier public.agent_tier;

CREATE INDEX IF NOT EXISTS idx_profiles_agent_tier
  ON public.profiles (agent_tier)
  WHERE agent_tier IS NOT NULL;

-- 2) Tier → default capability mapping -------------------------
CREATE TABLE IF NOT EXISTS public.agent_tier_capabilities (
  tier        public.agent_tier NOT NULL,
  capability  text NOT NULL,
  PRIMARY KEY (tier, capability),
  CHECK (capability = ANY (ARRAY[
    'collect_rent','onboard_tenants','onboard_landlords','capture_supporters',
    'act_as_proxy','process_cash_out','manage_subagents','approve_subagents',
    'request_float','view_agent_dashboard','view_subagent_data'
  ]))
);

ALTER TABLE public.agent_tier_capabilities ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can read tier mapping" ON public.agent_tier_capabilities;
CREATE POLICY "Anyone can read tier mapping"
  ON public.agent_tier_capabilities FOR SELECT
  USING (true);

DROP POLICY IF EXISTS "Staff can manage tier mapping" ON public.agent_tier_capabilities;
CREATE POLICY "Staff can manage tier mapping"
  ON public.agent_tier_capabilities FOR ALL
  USING (
    public.has_role(auth.uid(),'manager'::app_role)
    OR public.has_role(auth.uid(),'coo'::app_role)
    OR public.has_role(auth.uid(),'super_admin'::app_role)
  )
  WITH CHECK (
    public.has_role(auth.uid(),'manager'::app_role)
    OR public.has_role(auth.uid(),'coo'::app_role)
    OR public.has_role(auth.uid(),'super_admin'::app_role)
  );

-- Seed default tier mapping (idempotent)
INSERT INTO public.agent_tier_capabilities(tier, capability) VALUES
  ('probation','view_agent_dashboard'),
  ('probation','collect_rent'),

  ('collector','view_agent_dashboard'),
  ('collector','collect_rent'),
  ('collector','request_float'),
  ('collector','onboard_tenants'),

  ('full_agent','view_agent_dashboard'),
  ('full_agent','collect_rent'),
  ('full_agent','request_float'),
  ('full_agent','onboard_tenants'),
  ('full_agent','onboard_landlords'),
  ('full_agent','capture_supporters'),
  ('full_agent','process_cash_out'),
  ('full_agent','act_as_proxy'),

  ('senior','view_agent_dashboard'),
  ('senior','collect_rent'),
  ('senior','request_float'),
  ('senior','onboard_tenants'),
  ('senior','onboard_landlords'),
  ('senior','capture_supporters'),
  ('senior','process_cash_out'),
  ('senior','act_as_proxy'),
  ('senior','manage_subagents'),
  ('senior','approve_subagents'),
  ('senior','view_subagent_data')
ON CONFLICT DO NOTHING;
-- 'suspended' tier intentionally has zero capability rows.

-- 3) Apply a tier's default capability set to one agent --------
CREATE OR REPLACE FUNCTION public.apply_tier_capabilities(
  _agent_id uuid,
  _tier     public.agent_tier,
  _actor    uuid,
  _reason   text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_added   integer := 0;
  v_revoked integer := 0;
BEGIN
  IF _reason IS NULL OR length(trim(_reason)) < 10 THEN
    RAISE EXCEPTION 'reason must be at least 10 characters';
  END IF;

  -- Activate / insert capabilities the tier requires
  WITH wanted AS (
    SELECT capability FROM public.agent_tier_capabilities WHERE tier = _tier
  ),
  upserted AS (
    INSERT INTO public.agent_capabilities (agent_id, capability, status, granted_by, metadata)
    SELECT _agent_id, w.capability, 'active', _actor,
           jsonb_build_object('source','tier','tier',_tier,'reason',_reason)
    FROM wanted w
    ON CONFLICT (agent_id, capability) DO UPDATE
      SET status      = 'active',
          revoked_at  = NULL,
          revoked_by  = NULL,
          granted_by  = EXCLUDED.granted_by,
          metadata    = public.agent_capabilities.metadata
                      || jsonb_build_object('source','tier','tier',_tier,'reason',_reason),
          updated_at  = now()
      WHERE public.agent_capabilities.status <> 'active'
    RETURNING 1
  )
  SELECT count(*) INTO v_added FROM upserted;

  -- Revoke capabilities not in the tier (only those previously sourced from tier — leave manual grants alone)
  WITH revoked AS (
    UPDATE public.agent_capabilities ac
       SET status='revoked', revoked_at=now(), revoked_by=_actor,
           metadata = ac.metadata || jsonb_build_object('source','tier','tier',_tier,'reason',_reason)
     WHERE ac.agent_id = _agent_id
       AND ac.status   = 'active'
       AND ac.capability NOT IN (SELECT capability FROM public.agent_tier_capabilities WHERE tier = _tier)
       AND COALESCE(ac.metadata->>'source','tier') = 'tier'
    RETURNING 1
  )
  SELECT count(*) INTO v_revoked FROM revoked;

  RETURN jsonb_build_object('added', v_added, 'revoked', v_revoked);
END $$;

-- 4) Single-agent toggle ---------------------------------------
CREATE OR REPLACE FUNCTION public.ops_set_agent_capability(
  _agent_id   uuid,
  _capability text,
  _action     text,           -- 'enable' | 'disable'
  _reason     text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  IF NOT (
    public.has_role(v_actor,'manager'::app_role)
    OR public.has_role(v_actor,'coo'::app_role)
    OR public.has_role(v_actor,'super_admin'::app_role)
  ) THEN
    RAISE EXCEPTION 'forbidden: requires manager / coo / super_admin';
  END IF;

  IF _reason IS NULL OR length(trim(_reason)) < 10 THEN
    RAISE EXCEPTION 'reason must be at least 10 characters';
  END IF;

  IF _action NOT IN ('enable','disable') THEN
    RAISE EXCEPTION 'action must be enable or disable';
  END IF;

  IF _action = 'enable' THEN
    INSERT INTO public.agent_capabilities (agent_id, capability, status, granted_by, metadata)
    VALUES (_agent_id, _capability, 'active', v_actor,
            jsonb_build_object('source','manual','reason',_reason))
    ON CONFLICT (agent_id, capability) DO UPDATE
      SET status='active', revoked_at=NULL, revoked_by=NULL,
          granted_by=v_actor,
          metadata = public.agent_capabilities.metadata
                   || jsonb_build_object('source','manual','reason',_reason),
          updated_at=now();
  ELSE
    UPDATE public.agent_capabilities
       SET status='suspended', revoked_at=now(), revoked_by=v_actor,
           metadata = metadata || jsonb_build_object('source','manual','reason',_reason)
     WHERE agent_id=_agent_id AND capability=_capability;
  END IF;

  -- Audit
  INSERT INTO public.audit_logs (action_type, table_name, record_id, user_id, metadata, reason)
  VALUES (
    'agent_capability_' || _action,
    'agent_capabilities',
    _agent_id,
    v_actor,
    jsonb_build_object('capability',_capability,'agent_id',_agent_id),
    _reason
  );

  -- System event (TRUST MISSION)
  INSERT INTO public.system_events (event_type, source_type, source_id, payload)
  VALUES (
    'agent.capability.changed',
    'agent_ops',
    _agent_id,
    jsonb_build_object(
      'agent_id',_agent_id,
      'capability',_capability,
      'action',_action,
      'actor',v_actor,
      'reason',_reason
    )
  );

  RETURN jsonb_build_object('ok',true,'agent_id',_agent_id,'capability',_capability,'action',_action);
END $$;

-- 5) Bulk toggle (filter → multi-select → apply) ---------------
CREATE OR REPLACE FUNCTION public.ops_bulk_set_agent_capability(
  _agent_ids  uuid[],
  _capability text,
  _action     text,
  _reason     text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_n     integer := COALESCE(array_length(_agent_ids,1), 0);
  v_aff   integer := 0;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  IF NOT (
    public.has_role(v_actor,'manager'::app_role)
    OR public.has_role(v_actor,'coo'::app_role)
    OR public.has_role(v_actor,'super_admin'::app_role)
  ) THEN RAISE EXCEPTION 'forbidden'; END IF;
  IF _reason IS NULL OR length(trim(_reason)) < 10 THEN RAISE EXCEPTION 'reason must be at least 10 characters'; END IF;
  IF _action NOT IN ('enable','disable') THEN RAISE EXCEPTION 'action must be enable or disable'; END IF;
  IF v_n = 0 THEN RAISE EXCEPTION 'no agents selected'; END IF;
  IF v_n > 5000 THEN RAISE EXCEPTION 'batch limit is 5000 agents per call'; END IF;

  IF _action = 'enable' THEN
    WITH ins AS (
      INSERT INTO public.agent_capabilities (agent_id, capability, status, granted_by, metadata)
      SELECT a, _capability, 'active', v_actor,
             jsonb_build_object('source','manual','reason',_reason,'bulk',true)
      FROM unnest(_agent_ids) AS a
      ON CONFLICT (agent_id, capability) DO UPDATE
        SET status='active', revoked_at=NULL, revoked_by=NULL,
            granted_by=v_actor,
            metadata = public.agent_capabilities.metadata
                     || jsonb_build_object('source','manual','reason',_reason,'bulk',true),
            updated_at=now()
      RETURNING agent_id
    )
    SELECT count(*) INTO v_aff FROM ins;
  ELSE
    WITH upd AS (
      UPDATE public.agent_capabilities
         SET status='suspended', revoked_at=now(), revoked_by=v_actor,
             metadata = metadata || jsonb_build_object('source','manual','reason',_reason,'bulk',true)
       WHERE capability=_capability AND agent_id = ANY(_agent_ids)
       RETURNING agent_id
    )
    SELECT count(*) INTO v_aff FROM upd;
  END IF;

  -- Bulk audit (one row per agent)
  INSERT INTO public.audit_logs (action_type, table_name, record_id, user_id, metadata, reason)
  SELECT 'agent_capability_' || _action, 'agent_capabilities', a, v_actor,
         jsonb_build_object('capability',_capability,'agent_id',a,'bulk',true),
         _reason
  FROM unnest(_agent_ids) AS a;

  -- Bulk system event (one row per agent)
  INSERT INTO public.system_events (event_type, source_type, source_id, payload)
  SELECT 'agent.capability.changed','agent_ops', a,
         jsonb_build_object('agent_id',a,'capability',_capability,'action',_action,
                            'actor',v_actor,'reason',_reason,'bulk',true)
  FROM unnest(_agent_ids) AS a;

  RETURN jsonb_build_object('ok',true,'requested',v_n,'affected',v_aff,'capability',_capability,'action',_action);
END $$;

-- 6) Tier change RPC -------------------------------------------
CREATE OR REPLACE FUNCTION public.ops_set_agent_tier(
  _agent_id uuid,
  _tier     public.agent_tier,
  _reason   text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_prev  public.agent_tier;
  v_diff  jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  IF NOT (
    public.has_role(v_actor,'manager'::app_role)
    OR public.has_role(v_actor,'coo'::app_role)
    OR public.has_role(v_actor,'super_admin'::app_role)
  ) THEN RAISE EXCEPTION 'forbidden'; END IF;
  IF _reason IS NULL OR length(trim(_reason)) < 10 THEN RAISE EXCEPTION 'reason must be at least 10 characters'; END IF;

  SELECT agent_tier INTO v_prev FROM public.profiles WHERE id = _agent_id;

  UPDATE public.profiles SET agent_tier = _tier, updated_at = now() WHERE id = _agent_id;

  v_diff := public.apply_tier_capabilities(_agent_id, _tier, v_actor, _reason);

  INSERT INTO public.audit_logs (action_type, table_name, record_id, user_id, metadata, reason)
  VALUES ('agent_tier_changed','profiles',_agent_id,v_actor,
          jsonb_build_object('from',v_prev,'to',_tier,'diff',v_diff),
          _reason);

  INSERT INTO public.system_events (event_type, source_type, source_id, payload)
  VALUES ('agent.tier.changed','agent_ops',_agent_id,
          jsonb_build_object('agent_id',_agent_id,'from',v_prev,'to',_tier,'diff',v_diff,
                             'actor',v_actor,'reason',_reason));

  RETURN jsonb_build_object('ok',true,'agent_id',_agent_id,'from',v_prev,'to',_tier,'diff',v_diff);
END $$;

-- 7) Ops directory view (paginated, filterable in app) ---------
CREATE OR REPLACE VIEW public.vw_agent_ops_directory AS
SELECT
  p.id                        AS agent_id,
  p.full_name,
  p.phone,
  p.email,
  p.region,
  p.district,
  p.territory,
  p.agent_tier,
  p.is_frozen,
  p.frozen_reason,
  p.last_active_at,
  p.verified,
  COALESCE(c.active_count, 0) AS active_capability_count,
  COALESCE(c.total_count,  0) AS total_capability_count
FROM public.profiles p
JOIN public.user_roles ur
  ON ur.user_id = p.id AND ur.role = 'agent'::app_role
LEFT JOIN (
  SELECT agent_id,
         count(*) FILTER (WHERE status='active') AS active_count,
         count(*)                                AS total_count
    FROM public.agent_capabilities
   GROUP BY agent_id
) c ON c.agent_id = p.id;

GRANT SELECT ON public.vw_agent_ops_directory TO authenticated;

-- 8) Realtime on capability changes ----------------------------
ALTER TABLE public.agent_capabilities REPLICA IDENTITY FULL;
DO $$ BEGIN
  PERFORM 1
    FROM pg_publication_tables
   WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='agent_capabilities';
  IF NOT FOUND THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.agent_capabilities';
  END IF;
END $$;

-- 9) Permissions -----------------------------------------------
GRANT EXECUTE ON FUNCTION public.ops_set_agent_capability(uuid,text,text,text)            TO authenticated;
GRANT EXECUTE ON FUNCTION public.ops_bulk_set_agent_capability(uuid[],text,text,text)     TO authenticated;
GRANT EXECUTE ON FUNCTION public.ops_set_agent_tier(uuid, public.agent_tier, text)        TO authenticated;
GRANT EXECUTE ON FUNCTION public.apply_tier_capabilities(uuid, public.agent_tier, uuid, text) TO authenticated;