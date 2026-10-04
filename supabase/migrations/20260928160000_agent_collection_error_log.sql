-- An actual error log for the collections engine.
--
-- WHAT WAS WRONG WITH THE MONITOR
--
-- Every check in `agent_collections_monitor` answers "what is wrong with the
-- data right now". None of them answers "what went wrong while an agent was
-- trying to collect". Those are different questions and only the second one
-- catches a fault on the day it starts.
--
-- The collection dialog already distinguishes three failure modes and throws a
-- sensible message for each — insufficient float, a stalled network where the
-- payment was NOT recorded, and a structured rejection carrying an error_code.
-- All three are `console.error`'d into a phone nobody will ever read. This
-- gives them somewhere to land.
--
-- MEASURED BEFORE BUILDING, over 14 days to 2026-09-28:
--
--   tops_collection_anomalies, open       659   float_leg_missing, all 27 Sep
--   float recorded but never consumed     659   last 16 Sep 07:30
--   agent-app errors on agent routes      380   last today 08:27
--
-- So the log has real content from the first render, and the 659 open engine
-- anomalies have been sitting unread since the 27th.
--
-- WHY A CLIENT-CALLED LOGGER AND NOT AN EXCEPTION HANDLER IN THE RPC
--
-- Postgres has no autonomous transactions. An `EXCEPTION WHEN OTHERS THEN
-- INSERT ... ; RAISE;` inside the allocator rolls the INSERT back with the
-- statement it was recording, so the log would be empty exactly when it
-- mattered. The failure has to be recorded from outside the aborted
-- transaction, which means the caller.
--
-- `log_agent_collection_error` therefore never raises. It is called on a path
-- that is already handling a failure, and a logger that can throw would turn a
-- recoverable error into a crash. It returns NULL on any problem, including
-- when the agent is over the flood cap.

CREATE TABLE IF NOT EXISTS public.agent_collection_errors (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  agent_id        uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  tenant_id       uuid,
  rent_request_id uuid,
  amount          numeric,
  -- Where in the flow it broke, not what the message said.
  phase           text NOT NULL,
  error_code      text,
  message         text NOT NULL,
  client_ref      uuid,
  severity        text NOT NULL DEFAULT 'error',
  context         jsonb,
  CONSTRAINT agent_collection_errors_phase_check
    CHECK (phase IN ('allocate','allocate_stalled','allocate_rejected',
                     'offline_submit','confirm','sync','other')),
  CONSTRAINT agent_collection_errors_severity_check
    CHECK (severity IN ('critical','error','warning'))
);

CREATE INDEX IF NOT EXISTS agent_collection_errors_occurred_idx
  ON public.agent_collection_errors (occurred_at DESC);
CREATE INDEX IF NOT EXISTS agent_collection_errors_agent_idx
  ON public.agent_collection_errors (agent_id, occurred_at DESC);

COMMENT ON TABLE public.agent_collection_errors IS
  'Failures an agent hit while collecting. Written by the client on the failure '
  'path, because a Postgres exception handler cannot outlive the transaction it '
  'is reporting on.';

ALTER TABLE public.agent_collection_errors ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Ops and engineering read collection errors" ON public.agent_collection_errors;
CREATE POLICY "Ops and engineering read collection errors"
  ON public.agent_collection_errors FOR SELECT
  USING (
    public.has_role(auth.uid(), 'cto'::app_role)
    OR public.has_role(auth.uid(), 'super_admin'::app_role)
    OR public.has_role(auth.uid(), 'ceo'::app_role)
    OR public.has_role(auth.uid(), 'cfo'::app_role)
    OR public.has_role(auth.uid(), 'coo'::app_role)
    OR public.has_role(auth.uid(), 'manager'::app_role)
    OR public.has_role(auth.uid(), 'agent_ops'::app_role)
    OR public.has_role(auth.uid(), 'operations'::app_role)
    OR agent_id = auth.uid()
  );

-- No client INSERT policy on purpose: writes go through the RPC below, which
-- stamps the agent from the session and enforces the flood cap.
REVOKE INSERT, UPDATE, DELETE ON public.agent_collection_errors FROM authenticated, anon;

-- ---------------------------------------------------------------------------
-- The writer. Never raises.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.log_agent_collection_error(
  p_phase           text,
  p_message         text,
  p_error_code      text DEFAULT NULL,
  p_tenant_id       uuid DEFAULT NULL,
  p_rent_request_id uuid DEFAULT NULL,
  p_amount          numeric DEFAULT NULL,
  p_client_ref      uuid DEFAULT NULL,
  p_context         jsonb DEFAULT NULL,
  p_severity        text DEFAULT 'error')
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_uid   uuid := auth.uid();
  v_id    uuid;
  v_phase text;
  v_sev   text;
  v_recent int;
BEGIN
  IF v_uid IS NULL THEN
    RETURN NULL;
  END IF;

  v_phase := CASE WHEN p_phase IN ('allocate','allocate_stalled','allocate_rejected',
                                   'offline_submit','confirm','sync')
                  THEN p_phase ELSE 'other' END;
  v_sev   := CASE WHEN p_severity IN ('critical','error','warning') THEN p_severity ELSE 'error' END;

  -- A retry loop on a broken phone must not become the whole log.
  SELECT count(*) INTO v_recent
    FROM public.agent_collection_errors e
   WHERE e.agent_id = v_uid AND e.occurred_at >= now() - interval '1 hour';
  IF v_recent >= 60 THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.agent_collection_errors (
    agent_id, tenant_id, rent_request_id, amount, phase, error_code,
    message, client_ref, severity, context
  ) VALUES (
    v_uid, p_tenant_id, p_rent_request_id, p_amount, v_phase,
    NULLIF(left(btrim(COALESCE(p_error_code,'')), 80), ''),
    left(COALESCE(NULLIF(btrim(p_message), ''), 'unspecified error'), 2000),
    p_client_ref, v_sev,
    CASE WHEN p_context IS NULL OR length(p_context::text) > 4000 THEN NULL ELSE p_context END
  ) RETURNING id INTO v_id;

  RETURN v_id;
EXCEPTION WHEN OTHERS THEN
  -- The caller is already handling a failure. A logger that throws would turn
  -- a recoverable error into a crash.
  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.log_agent_collection_error(text, text, text, uuid, uuid, numeric, uuid, jsonb, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.log_agent_collection_error(text, text, text, uuid, uuid, numeric, uuid, jsonb, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- The reader: one timeline from every place a collection fault shows up.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.agent_collections_error_log(
  p_days  integer DEFAULT 7,
  p_limit integer DEFAULT 200,
  p_source text DEFAULT NULL)
RETURNS TABLE (
  occurred_at timestamptz,
  source      text,
  severity    text,
  phase       text,
  error_code  text,
  message     text,
  agent_name  text,
  agent_phone text,
  tenant_name text,
  amount      numeric,
  rent_request_id uuid,
  detail      text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_uid   uuid := auth.uid();
  v_days  int  := GREATEST(1, LEAST(90, COALESCE(p_days, 7)));
  v_lim   int  := GREATEST(1, LEAST(500, COALESCE(p_limit, 200)));
  v_since timestamptz := now() - make_interval(days => v_days);
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  IF NOT (
    public.has_role(v_uid, 'cto'::app_role) OR public.has_role(v_uid, 'super_admin'::app_role)
    OR public.has_role(v_uid, 'ceo'::app_role) OR public.has_role(v_uid, 'cfo'::app_role)
    OR public.has_role(v_uid, 'coo'::app_role) OR public.has_role(v_uid, 'manager'::app_role)
    OR public.has_role(v_uid, 'agent_ops'::app_role) OR public.has_role(v_uid, 'operations'::app_role)
  ) THEN
    RAISE EXCEPTION 'Engineering or operations role required' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT q.occurred_at, q.source, q.severity, q.phase, q.error_code, q.message,
         q.agent_name, q.agent_phone, q.tenant_name, q.amount, q.rent_request_id, q.detail
  FROM (

    -- 1. Failures the agent's own device reported while collecting.
    SELECT e.occurred_at, 'engine'::text AS source, e.severity, e.phase,
           e.error_code, e.message,
           ap.full_name AS agent_name, ap.phone AS agent_phone,
           tp.full_name AS tenant_name, e.amount, e.rent_request_id,
           COALESCE(e.context::text, '') AS detail
    FROM public.agent_collection_errors e
    LEFT JOIN public.profiles ap ON ap.id = e.agent_id
    LEFT JOIN public.profiles tp ON tp.id = e.tenant_id
    WHERE e.occurred_at >= v_since

    UNION ALL
    -- 2. The anomaly detector's own findings on recorded collections.
    --    `detail` is jsonb, so it goes in the detail column and the message is
    --    the rule name made readable — a log line has to be legible at a glance.
    SELECT a.detected_at, 'anomaly', a.severity, 'posted',
           a.rule_fired, initcap(replace(a.rule_fired, '_', ' ')),
           ap.full_name, ap.phone, tp.full_name, c.amount, a.rent_request_id,
           format('status %s, channel %s%s', a.status, COALESCE(a.collection_channel,'—'),
                  COALESCE(' · ' || NULLIF(a.detail::text, ''), ''))
    FROM public.tops_collection_anomalies a
    LEFT JOIN public.profiles ap ON ap.id = a.agent_id
    LEFT JOIN public.profiles tp ON tp.id = a.tenant_id
    LEFT JOIN public.agent_collections c ON c.id = a.collection_id
    WHERE a.detected_at >= v_since AND a.status <> 'resolved'

    UNION ALL
    -- 3. Float recorded as spent that never left the wallet — the signature of
    --    the 15-16 September gate failure, and cheap to keep watching for.
    SELECT c.created_at, 'engine', 'critical', 'posted',
           'FLOAT_NOT_CONSUMED',
           'Collection posted against agent float but the balance did not move',
           ap.full_name, ap.phone, tp.full_name, c.amount, c.rent_request_id,
           format('float %s before and after', round(COALESCE(c.float_before,0)))
    FROM public.agent_collections c
    LEFT JOIN public.profiles ap ON ap.id = c.agent_id
    LEFT JOIN public.profiles tp ON tp.id = c.tenant_id
    WHERE c.created_at >= v_since AND c.reversed_at IS NULL AND c.amount > 0
      AND c.collection_channel = 'agent_float'
      AND c.float_before = c.float_after

    UNION ALL
    -- 4. What the agent app itself crashed on. A chunk that will not load or an
    --    IndexedDB transaction that closes mid-write is a collection that did
    --    not happen, even though no RPC was ever reached.
    SELECT r.created_at, 'app', 'warning', 'client',
           NULL::text, r.message,
           ap.full_name, ap.phone, NULL::text, NULL::numeric, NULL::uuid,
           COALESCE(r.route, '')
    FROM public.client_error_reports r
    LEFT JOIN public.profiles ap ON ap.id = r.user_id
    WHERE r.created_at >= v_since
      AND (r.role IN ('agent','sub_agent','senior_agent') OR r.route ILIKE '%agent%')

  ) q
  WHERE p_source IS NULL OR q.source = p_source
  ORDER BY q.occurred_at DESC
  LIMIT v_lim;
END;
$function$;

REVOKE ALL ON FUNCTION public.agent_collections_error_log(integer, integer, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.agent_collections_error_log(integer, integer, text) TO authenticated;

COMMENT ON FUNCTION public.agent_collections_error_log(integer, integer, text) IS
  'One timeline of collection faults for the CTO Monitor: device-reported '
  'failures, open anomaly-detector findings, float that never moved, and agent '
  'app crashes. Events with a timestamp, not conditions.';

-- ---------------------------------------------------------------------------
-- A rolled-up count so the panel can show a headline without pulling the rows.
-- ---------------------------------------------------------------------------
-- Counts must NOT come from the log function: it caps at 500 rows, so a busy
-- day would silently under-report exactly when the panel matters most. Each
-- source is counted at its own source.
CREATE OR REPLACE FUNCTION public.agent_collections_error_summary(
  p_days integer DEFAULT 7)
RETURNS TABLE (source text, severity text, hits bigint, newest timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_uid   uuid := auth.uid();
  v_days  int  := GREATEST(1, LEAST(90, COALESCE(p_days, 7)));
  v_since timestamptz := now() - make_interval(days => v_days);
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  IF NOT (
    public.has_role(v_uid, 'cto'::app_role) OR public.has_role(v_uid, 'super_admin'::app_role)
    OR public.has_role(v_uid, 'ceo'::app_role) OR public.has_role(v_uid, 'cfo'::app_role)
    OR public.has_role(v_uid, 'coo'::app_role) OR public.has_role(v_uid, 'manager'::app_role)
    OR public.has_role(v_uid, 'agent_ops'::app_role) OR public.has_role(v_uid, 'operations'::app_role)
  ) THEN
    RAISE EXCEPTION 'Engineering or operations role required' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT g.source, g.severity, count(*)::bigint, max(g.at)
  FROM (
    SELECT 'engine'::text AS source, e.severity, e.occurred_at AS at
      FROM public.agent_collection_errors e WHERE e.occurred_at >= v_since
    UNION ALL
    SELECT 'anomaly', a.severity, a.detected_at
      FROM public.tops_collection_anomalies a
     WHERE a.detected_at >= v_since AND a.status <> 'resolved'
    UNION ALL
    SELECT 'engine', 'critical', c.created_at
      FROM public.agent_collections c
     WHERE c.created_at >= v_since AND c.reversed_at IS NULL AND c.amount > 0
       AND c.collection_channel = 'agent_float' AND c.float_before = c.float_after
    UNION ALL
    SELECT 'app', 'warning', r.created_at
      FROM public.client_error_reports r
     WHERE r.created_at >= v_since
       AND (r.role IN ('agent','sub_agent','senior_agent') OR r.route ILIKE '%agent%')
  ) g
  GROUP BY g.source, g.severity
  ORDER BY count(*) DESC;
END;
$function$;

REVOKE ALL ON FUNCTION public.agent_collections_error_summary(integer) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.agent_collections_error_summary(integer) TO authenticated;
