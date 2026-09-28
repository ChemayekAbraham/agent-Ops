-- Make a collection error worth opening.
--
-- TWO PROBLEMS WITH THE FIRST CUT
--
-- 1. The log row was a headline with no body. "Float Leg Missing · status open,
--    channel agent_float · {"expected_direction": "cash_out", "collectio…" is
--    a truncated string, and the one thing an engineer needs — the whole
--    payload — was the part that got cut. Context is now returned as jsonb so
--    a reader can render it properly instead of clipping it.
--
-- 2. THE LOGGER DIED IN THE CASES THAT MATTERED MOST. `log_agent_collection_error`
--    is a Postgres RPC called over the same connection that just failed. The
--    three failures it exists to record are "Failed to fetch", a stalled
--    network, and an expired session — and in all three the logging call goes
--    out over the same broken path and is lost too. That is why the log fills
--    with anomalies (written server-side, by a cron) and almost nothing from
--    the engine.
--
--    The edge function `log-collection-error` is the answer: it writes with the
--    service role, so a dead session still logs; it accepts a `sendBeacon`
--    payload, so a crash or a closed tab still logs; and it records HOW the
--    report arrived, so a gap in one path is visible rather than silent.
--
-- `reported_via` is the honest part of this. A row that came in by beacon after
-- the page died is worth more scepticism than one reported normally, and a
-- sudden shift in the mix is itself a signal.

ALTER TABLE public.agent_collection_errors
  ADD COLUMN IF NOT EXISTS user_agent   text,
  ADD COLUMN IF NOT EXISTS app_version  text,
  ADD COLUMN IF NOT EXISTS page_url     text,
  ADD COLUMN IF NOT EXISTS network      text,
  ADD COLUMN IF NOT EXISTS ip_address   text,
  ADD COLUMN IF NOT EXISTS reported_via text NOT NULL DEFAULT 'rpc';

COMMENT ON COLUMN public.agent_collection_errors.reported_via IS
  'rpc | edge | beacon. How the report reached us. A report that only ever '
  'arrives by beacon means the page was dying, which is itself diagnostic.';
COMMENT ON COLUMN public.agent_collection_errors.network IS
  'What the device said about its connection at the moment of failure '
  '(online/offline, effectiveType). Most collection failures are network ones.';

-- ---------------------------------------------------------------------------
-- The writer, widened. Old callers keep working: every new parameter defaults.
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
  p_severity        text DEFAULT 'error',
  p_user_agent      text DEFAULT NULL,
  p_app_version     text DEFAULT NULL,
  p_page_url        text DEFAULT NULL,
  p_network         text DEFAULT NULL,
  p_reported_via    text DEFAULT 'rpc')
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_uid   uuid := auth.uid();
  v_id    uuid;
  v_phase text;
  v_sev   text;
  v_via   text;
  v_recent int;
BEGIN
  IF v_uid IS NULL THEN
    RETURN NULL;
  END IF;

  v_phase := CASE WHEN p_phase IN ('allocate','allocate_stalled','allocate_rejected',
                                   'offline_submit','confirm','sync')
                  THEN p_phase ELSE 'other' END;
  v_sev   := CASE WHEN p_severity IN ('critical','error','warning') THEN p_severity ELSE 'error' END;
  v_via   := CASE WHEN p_reported_via IN ('rpc','edge','beacon') THEN p_reported_via ELSE 'rpc' END;

  SELECT count(*) INTO v_recent
    FROM public.agent_collection_errors e
   WHERE e.agent_id = v_uid AND e.occurred_at >= now() - interval '1 hour';
  IF v_recent >= 60 THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.agent_collection_errors (
    agent_id, tenant_id, rent_request_id, amount, phase, error_code,
    message, client_ref, severity, context,
    user_agent, app_version, page_url, network, reported_via
  ) VALUES (
    v_uid, p_tenant_id, p_rent_request_id, p_amount, v_phase,
    NULLIF(left(btrim(COALESCE(p_error_code,'')), 80), ''),
    left(COALESCE(NULLIF(btrim(p_message), ''), 'unspecified error'), 2000),
    p_client_ref, v_sev,
    CASE WHEN p_context IS NULL OR length(p_context::text) > 8000 THEN NULL ELSE p_context END,
    left(COALESCE(p_user_agent,''), 400), left(COALESCE(p_app_version,''), 80),
    left(COALESCE(p_page_url,''), 400), left(COALESCE(p_network,''), 120), v_via
  ) RETURNING id INTO v_id;

  RETURN v_id;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.log_agent_collection_error(
  text, text, text, uuid, uuid, numeric, uuid, jsonb, text, text, text, text, text, text)
  FROM public, anon;
GRANT EXECUTE ON FUNCTION public.log_agent_collection_error(
  text, text, text, uuid, uuid, numeric, uuid, jsonb, text, text, text, text, text, text)
  TO authenticated;

-- ---------------------------------------------------------------------------
-- The reader, with a body. Return type changes, so it has to be dropped first.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.agent_collections_error_log(integer, integer, text);

CREATE FUNCTION public.agent_collections_error_log(
  p_days  integer DEFAULT 7,
  p_limit integer DEFAULT 200,
  p_source text DEFAULT NULL)
RETURNS TABLE (
  event_id        text,
  occurred_at     timestamptz,
  source          text,
  severity        text,
  phase           text,
  error_code      text,
  message         text,
  agent_id        uuid,
  agent_name      text,
  agent_phone     text,
  tenant_name     text,
  amount          numeric,
  rent_request_id uuid,
  detail          text,
  context         jsonb
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
  SELECT q.event_id, q.occurred_at, q.source, q.severity, q.phase, q.error_code, q.message,
         q.agent_id, q.agent_name, q.agent_phone, q.tenant_name, q.amount,
         q.rent_request_id, q.detail, q.context
  FROM (

    -- 1. Failures the agent's own device reported while collecting.
    SELECT ('engine:' || e.id::text) AS event_id, e.occurred_at,
           'engine'::text AS source, e.severity, e.phase, e.error_code, e.message,
           e.agent_id, ap.full_name AS agent_name, ap.phone AS agent_phone,
           tp.full_name AS tenant_name, e.amount, e.rent_request_id,
           format('%s · reported via %s', COALESCE(e.phase,'—'), e.reported_via) AS detail,
           jsonb_strip_nulls(jsonb_build_object(
             'error_code',   e.error_code,
             'phase',        e.phase,
             'reported_via', e.reported_via,
             'client_ref',   e.client_ref,
             'tenant_id',    e.tenant_id,
             'rent_request_id', e.rent_request_id,
             'amount',       e.amount,
             'network',      e.network,
             'page_url',     e.page_url,
             'app_version',  e.app_version,
             'user_agent',   e.user_agent,
             'ip_address',   e.ip_address,
             'context',      e.context
           )) AS context
    FROM public.agent_collection_errors e
    LEFT JOIN public.profiles ap ON ap.id = e.agent_id
    LEFT JOIN public.profiles tp ON tp.id = e.tenant_id
    WHERE e.occurred_at >= v_since

    UNION ALL
    -- 2. The anomaly detector's own findings on collections that DID post.
    --    The rule payload is the whole point of opening one of these, so it is
    --    returned intact rather than stringified into the summary line.
    SELECT ('anomaly:' || a.id::text), a.detected_at,
           'anomaly', a.severity, 'posted', a.rule_fired,
           initcap(replace(a.rule_fired, '_', ' ')),
           a.agent_id, ap.full_name, ap.phone, tp.full_name, c.amount, a.rent_request_id,
           format('status %s, channel %s', a.status, COALESCE(a.collection_channel,'—')),
           jsonb_strip_nulls(jsonb_build_object(
             'rule_fired',    a.rule_fired,
             'status',        a.status,
             'channel',       a.collection_channel,
             'collection_id', a.collection_id,
             'rent_request_id', a.rent_request_id,
             'detected_at',   a.detected_at,
             'acknowledged_by', ack.full_name,
             'acknowledged_at', a.acknowledged_at,
             'acknowledged_note', a.acknowledged_note,
             'collection_amount', c.amount,
             'collection_at', c.created_at,
             'float_before',  c.float_before,
             'float_after',   c.float_after,
             'rule_detail',   a.detail
           ))
    FROM public.tops_collection_anomalies a
    LEFT JOIN public.profiles ap ON ap.id = a.agent_id
    LEFT JOIN public.profiles tp ON tp.id = a.tenant_id
    LEFT JOIN public.profiles ack ON ack.id = a.acknowledged_by
    LEFT JOIN public.agent_collections c ON c.id = a.collection_id
    WHERE a.detected_at >= v_since AND a.status <> 'resolved'

    UNION ALL
    -- 3. Float recorded as spent that never left the wallet.
    SELECT ('float:' || c.id::text), c.created_at,
           'engine', 'critical', 'posted', 'FLOAT_NOT_CONSUMED',
           'Collection posted against agent float but the balance did not move',
           c.agent_id, ap.full_name, ap.phone, tp.full_name, c.amount, c.rent_request_id,
           format('float unchanged at %s', round(COALESCE(c.float_before,0))),
           jsonb_strip_nulls(jsonb_build_object(
             'collection_id',  c.id,
             'collection_at',  c.created_at,
             'channel',        c.collection_channel,
             'amount',         c.amount,
             'float_before',   c.float_before,
             'float_after',    c.float_after,
             'client_ref',     c.client_ref,
             'deposit_request_id', c.deposit_request_id,
             'notes',          NULLIF(btrim(COALESCE(c.notes,'')), ''),
             'rent_request_id', c.rent_request_id
           ))
    FROM public.agent_collections c
    LEFT JOIN public.profiles ap ON ap.id = c.agent_id
    LEFT JOIN public.profiles tp ON tp.id = c.tenant_id
    WHERE c.created_at >= v_since AND c.reversed_at IS NULL AND c.amount > 0
      AND c.collection_channel = 'agent_float'
      AND c.float_before = c.float_after

    UNION ALL
    -- 4. What the agent app itself crashed on.
    SELECT ('app:' || r.id::text), r.created_at,
           'app', 'warning', 'client', NULL::text, r.message,
           r.user_id, ap.full_name, ap.phone, NULL::text, NULL::numeric, NULL::uuid,
           COALESCE(r.route, ''),
           jsonb_strip_nulls(jsonb_build_object(
             'route',           r.route,
             'role',            r.role,
             'label',           r.label,
             'user_agent',      r.user_agent,
             'component_stack', r.component_stack,
             'context',         r.context
           ))
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
  'One timeline of collection faults for the CTO Monitor, each row carrying its '
  'full payload as jsonb so a reader can open it instead of clipping it. '
  '`event_id` is stable per row and used for selection and prev/next.';
