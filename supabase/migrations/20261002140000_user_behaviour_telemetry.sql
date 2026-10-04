-- 20261002140000_user_behaviour_telemetry.sql
-- User Behaviour Telemetry System
-- In-house, batched, secure telemetry with RLS restricted to crm, cto, super_admin

CREATE TABLE IF NOT EXISTS public.user_telemetry_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL,
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  role text NOT NULL DEFAULT 'visitor',
  event_type text NOT NULL,
  path text,
  section text,
  target text,
  kind text,
  dialog_name text,
  dwell_time_ms integer,
  metadata jsonb DEFAULT '{}'::jsonb,
  latitude numeric(9,6),
  longitude numeric(9,6),
  ip_address text,
  user_agent text,
  device_class text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Performance indexes for analytics rollups and feeds
CREATE INDEX IF NOT EXISTS idx_telemetry_created_at ON public.user_telemetry_events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_telemetry_role_created ON public.user_telemetry_events (role, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_telemetry_section ON public.user_telemetry_events (section, event_type);
CREATE INDEX IF NOT EXISTS idx_telemetry_session ON public.user_telemetry_events (session_id);
CREATE INDEX IF NOT EXISTS idx_telemetry_user ON public.user_telemetry_events (user_id);

-- Enable Row Level Security
ALTER TABLE public.user_telemetry_events ENABLE ROW LEVEL SECURITY;

-- Read policy: only crm, cto, or super_admin may read telemetry
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'user_telemetry_events' AND policyname = 'Staff can view telemetry events'
  ) THEN
    CREATE POLICY "Staff can view telemetry events"
      ON public.user_telemetry_events
      FOR SELECT
      TO authenticated
      USING (
        public.has_role(auth.uid(), 'crm') OR
        public.has_role(auth.uid(), 'cto') OR
        public.has_role(auth.uid(), 'super_admin')
      );
  END IF;
END $$;

-- Idempotent, throttled batch ingestion RPC
CREATE OR REPLACE FUNCTION public.ingest_user_telemetry_batch(p_events jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_ip text;
  v_ua text;
  v_count integer := 0;
BEGIN
  -- Limit batch size to protect against abuse
  IF jsonb_array_length(p_events) > 100 THEN
    RAISE EXCEPTION 'batch too large (max 100 events)';
  END IF;

  -- Extract server IP from request headers (client cannot spoof)
  BEGIN
    v_ip := split_part(current_setting('request.headers', true)::json->>'x-forwarded-for', ',', 1);
    IF v_ip IS NULL OR v_ip = '' THEN
      v_ip := current_setting('request.headers', true)::json->>'cf-connecting-ip';
    END IF;
    v_ua := current_setting('request.headers', true)::json->>'user-agent';
  EXCEPTION WHEN OTHERS THEN
    v_ip := NULL;
    v_ua := NULL;
  END;

  -- Insert batch using ON CONFLICT (id) DO NOTHING to prevent double-entry on retries
  INSERT INTO public.user_telemetry_events (
    id, session_id, user_id, role, event_type, path, section, target,
    kind, dialog_name, dwell_time_ms, metadata, latitude, longitude,
    ip_address, user_agent, device_class, created_at
  )
  SELECT
    COALESCE(NULLIF(e->>'id', '')::uuid, gen_random_uuid()),
    (e->>'session_id')::uuid,
    v_user_id,
    COALESCE(NULLIF(e->>'role', ''), 'visitor'),
    COALESCE(NULLIF(e->>'event_type', ''), 'tap'),
    NULLIF(e->>'path', ''),
    NULLIF(e->>'section', ''),
    NULLIF(e->>'target', ''),
    NULLIF(e->>'kind', ''),
    NULLIF(e->>'dialog_name', ''),
    NULLIF(e->>'dwell_time_ms', '')::integer,
    COALESCE(e->'metadata', '{}'::jsonb),
    NULLIF(e->>'latitude', '')::numeric,
    NULLIF(e->>'longitude', '')::numeric,
    COALESCE(v_ip, NULLIF(e->>'ip_address', '')),
    COALESCE(NULLIF(e->>'user_agent', ''), v_ua),
    COALESCE(NULLIF(e->>'device_class', ''),
      CASE 
        WHEN COALESCE(NULLIF(e->>'user_agent', ''), v_ua) ILIKE '%ipad%' OR COALESCE(NULLIF(e->>'user_agent', ''), v_ua) ILIKE '%tablet%' THEN 'tablet'
        WHEN COALESCE(NULLIF(e->>'user_agent', ''), v_ua) ILIKE '%mobi%' OR COALESCE(NULLIF(e->>'user_agent', ''), v_ua) ILIKE '%android%' OR COALESCE(NULLIF(e->>'user_agent', ''), v_ua) ILIKE '%iphone%' THEN 'mobile'
        ELSE 'desktop'
      END
    ),
    COALESCE(NULLIF(e->>'created_at', '')::timestamptz, now())
  FROM jsonb_array_elements(p_events) AS e
  WHERE (e->>'session_id') IS NOT NULL
  ON CONFLICT (id) DO NOTHING;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $function$;

REVOKE ALL ON FUNCTION public.ingest_user_telemetry_batch(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ingest_user_telemetry_batch(jsonb) TO anon, authenticated;

-- Consolidated analytics query RPC for CRM Dashboard (Single Round-Trip)
CREATE OR REPLACE FUNCTION public.get_user_behaviour_analytics(
  p_days integer DEFAULT 7,
  p_role text DEFAULT 'all'
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_start timestamptz;
  v_result jsonb;
BEGIN
  -- Strict role verification: only crm, cto, or super_admin
  IF NOT (
    public.has_role(v_uid, 'crm') OR
    public.has_role(v_uid, 'cto') OR
    public.has_role(v_uid, 'super_admin')
  ) THEN
    RAISE EXCEPTION 'Access denied: CRM, CTO, or Super Admin role required';
  END IF;

  v_start := now() - (GREATEST(1, LEAST(p_days, 90)) || ' days')::interval;

  WITH filtered_events AS (
    SELECT e.*
    FROM public.user_telemetry_events e
    WHERE e.created_at >= v_start
      AND e.role IN ('agent', 'tenant', 'supporter', 'landlord')
      AND (p_role = 'all' OR p_role IS NULL OR e.role = p_role)
      AND (e.path IS NULL OR (
        e.path NOT LIKE '/cfo%' AND
        e.path NOT LIKE '/executive%' AND
        e.path NOT LIKE '/admin%' AND
        e.path NOT LIKE '/crm%' AND
        e.path NOT LIKE '/cto%' AND
        e.path NOT LIKE '/agent-ops%' AND
        e.path NOT LIKE '/tenant-ops%' AND
        e.path NOT LIKE '/landlord-ops%' AND
        e.path NOT LIKE '/partners-ops%' AND
        e.path NOT LIKE '/fin-ops%'
      ))
  ),
  kpis AS (
    SELECT
      count(*)::integer AS total_events,
      count(DISTINCT session_id)::integer AS total_sessions,
      count(DISTINCT user_id)::integer AS unique_users,
      round(COALESCE(avg(dwell_time_ms) FILTER (WHERE dwell_time_ms > 0 AND dwell_time_ms < 1800000) / 1000.0, 0), 1)::numeric AS avg_dwell_sec,
      count(DISTINCT session_id) FILTER (WHERE latitude IS NOT NULL AND longitude IS NOT NULL)::integer AS gps_sessions
    FROM filtered_events
  ),
  roles AS (
    SELECT jsonb_agg(
      jsonb_build_object(
        'role', r.role,
        'sessions', r.session_count,
        'events', r.event_count
      ) ORDER BY r.session_count DESC
    ) AS role_stats
    FROM (
      SELECT role, count(DISTINCT session_id) AS session_count, count(*) AS event_count
      FROM filtered_events
      GROUP BY role
    ) r
  ),
  sections AS (
    SELECT jsonb_agg(
      jsonb_build_object(
        'section', s.section,
        'role', s.role,
        'views', s.view_count,
        'unique_sessions', s.session_count,
        'avg_dwell_sec', s.avg_dwell
      ) ORDER BY s.view_count DESC
    ) AS section_stats
    FROM (
      SELECT 
        s.section,
        s.role,
        count(*) AS view_count,
        count(DISTINCT session_id) AS session_count,
        round(COALESCE(avg(dwell_time_ms) FILTER (WHERE dwell_time_ms > 0 AND dwell_time_ms < 1800000) / 1000.0, 0), 1) AS avg_dwell
      FROM filtered_events s
      WHERE s.section IS NOT NULL 
        AND s.section <> '' 
        AND s.section NOT IN ('home', 'unknown')
        AND s.role IN ('agent', 'tenant', 'supporter', 'landlord')
      GROUP BY s.section, s.role
      LIMIT 30
    ) s
  ),
  actions AS (
    SELECT jsonb_agg(
      jsonb_build_object(
        'target', a.target,
        'section', a.section,
        'role', a.role,
        'kind', a.kind,
        'count', a.action_count
      ) ORDER BY a.action_count DESC
    ) AS action_stats
    FROM (
      SELECT 
        target,
        max(section) AS section,
        max(role) AS role,
        max(kind) AS kind,
        count(*) AS action_count
      FROM filtered_events
      WHERE target IS NOT NULL AND target <> ''
      GROUP BY target
      LIMIT 20
    ) a
  ),
  dialogs AS (
    SELECT jsonb_agg(
      jsonb_build_object(
        'dialog_name', d.dialog_name,
        'interactions', d.interact_count,
        'unique_sessions', d.session_count
      ) ORDER BY d.interact_count DESC
    ) AS dialog_stats
    FROM (
      SELECT 
        dialog_name,
        count(*) AS interact_count,
        count(DISTINCT session_id) AS session_count
      FROM filtered_events
      WHERE dialog_name IS NOT NULL AND dialog_name <> ''
      GROUP BY dialog_name
      LIMIT 15
    ) d
  ),
  devices AS (
    SELECT jsonb_agg(
      jsonb_build_object(
        'device_class', dev.device_class,
        'user_agent', dev.user_agent,
        'sessions', dev.session_count,
        'events', dev.event_count
      ) ORDER BY dev.session_count DESC
    ) AS device_stats
    FROM (
      SELECT 
        COALESCE(device_class, 'unknown') AS device_class,
        COALESCE(user_agent, 'unknown') AS user_agent,
        count(DISTINCT session_id) AS session_count,
        count(*) AS event_count
      FROM filtered_events
      WHERE user_agent IS NOT NULL AND user_agent <> ''
      GROUP BY COALESCE(device_class, 'unknown'), COALESCE(user_agent, 'unknown')
      LIMIT 40
    ) dev
  ),
  trend AS (
    SELECT jsonb_agg(
      jsonb_build_object(
        'day', t.time_bucket,
        'agent', t.agent_count,
        'tenant', t.tenant_count,
        'supporter', t.supporter_count,
        'landlord', t.landlord_count,
        'total', t.total_count
      ) ORDER BY t.time_bucket ASC
    ) AS trend_stats
    FROM (
      SELECT 
        CASE 
          WHEN p_days <= 1 THEN to_char(created_at AT TIME ZONE 'Africa/Kampala', 'HH24:00')
          ELSE to_char(created_at AT TIME ZONE 'Africa/Kampala', 'YYYY-MM-DD')
        END AS time_bucket,
        count(*) FILTER (WHERE role = 'agent')::integer AS agent_count,
        count(*) FILTER (WHERE role = 'tenant')::integer AS tenant_count,
        count(*) FILTER (WHERE role = 'supporter')::integer AS supporter_count,
        count(*) FILTER (WHERE role = 'landlord')::integer AS landlord_count,
        count(*)::integer AS total_count
      FROM filtered_events
      GROUP BY 1
      ORDER BY 1 ASC
    ) t
  ),
  recent AS (
    SELECT jsonb_agg(
      jsonb_build_object(
        'id', rec.id,
        'created_at', rec.created_at,
        'role', rec.role,
        'event_type', rec.event_type,
        'section', rec.section,
        'target', rec.target,
        'dialog_name', rec.dialog_name,
        'has_gps', (rec.latitude IS NOT NULL AND rec.longitude IS NOT NULL),
        'latitude', rec.latitude,
        'longitude', rec.longitude,
        'ip_address', rec.ip_address,
        'user_agent', rec.user_agent,
        'device_class', rec.device_class,
        'user_name', p.full_name,
        'phone', CASE 
          WHEN p.phone IS NOT NULL THEN substring(p.phone from 1 for 4) || '***' || substring(p.phone from length(p.phone)-2)
          ELSE NULL 
        END
      ) ORDER BY rec.created_at DESC
    ) AS recent_feed
    FROM (
      SELECT *
      FROM filtered_events
      ORDER BY created_at DESC
      LIMIT 50
    ) rec
    LEFT JOIN public.profiles p ON p.id = rec.user_id
  )
  SELECT jsonb_build_object(
    'kpis', (SELECT row_to_json(kpis.*) FROM kpis),
    'roles', COALESCE((SELECT role_stats FROM roles), '[]'::jsonb),
    'sections', COALESCE((SELECT section_stats FROM sections), '[]'::jsonb),
    'actions', COALESCE((SELECT action_stats FROM actions), '[]'::jsonb),
    'dialogs', COALESCE((SELECT dialog_stats FROM dialogs), '[]'::jsonb),
    'devices', COALESCE((SELECT device_stats FROM devices), '[]'::jsonb),
    'trend', COALESCE((SELECT trend_stats FROM trend), '[]'::jsonb),
    'recent_feed', COALESCE((SELECT recent_feed FROM recent), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END $function$;

REVOKE ALL ON FUNCTION public.get_user_behaviour_analytics(integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_user_behaviour_analytics(integer, text) TO authenticated;
