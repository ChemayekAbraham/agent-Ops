-- PROPOSAL ONLY — NOT APPLIED. Do not move into supabase/migrations without approval.
-- Re-creates public.agent_collections_error_log, copied verbatim from
-- 20261001080000_collections_monitor_error_log_signal_vs_noise.sql except the
-- client_error_reports branch: (1) route match narrowed to agent app routes
-- (/dashboard/agent%, /agent/%, /agent) so /agent-ops and /dashboard/agents
-- staff pages no longer count; (2) browser-extension / abort noise excluded.
-- agent_collections_error_summary is unchanged by this proposal, so its counts
-- will differ until it receives the same filter.
-- Verify the live definition matches the source file before applying.

CREATE OR REPLACE FUNCTION public.agent_collections_error_log(p_days integer DEFAULT 7, p_limit integer DEFAULT 200, p_source text DEFAULT NULL::text)
 RETURNS TABLE(event_id text, occurred_at timestamp with time zone, source text, severity text, phase text, error_code text, message text, agent_id uuid, agent_name text, agent_phone text, tenant_name text, amount numeric, rent_request_id uuid, detail text, context jsonb)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
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

    SELECT ('engine:' || e.id::text) AS event_id, e.occurred_at,
           'engine'::text AS source,
           -- Doc 178: the TID-backed float rule is a gate doing its job, not a fault.
           CASE WHEN e.error_code = 'INSUFFICIENT_TID_BACKED_FLOAT' THEN 'info' ELSE e.severity END AS severity,
           e.phase, e.error_code, e.message,
           e.agent_id, ap.full_name AS agent_name, ap.phone AS agent_phone,
           tp.full_name AS tenant_name, e.amount, e.rent_request_id,
           format('%s · reported via %s', COALESCE(e.phase,'-'), e.reported_via) AS detail,
           jsonb_strip_nulls(jsonb_build_object(
             'error_code', e.error_code, 'phase', e.phase, 'reported_via', e.reported_via,
             'client_ref', e.client_ref, 'tenant_id', e.tenant_id,
             'rent_request_id', e.rent_request_id, 'amount', e.amount,
             'network', e.network, 'page_url', e.page_url, 'app_version', e.app_version,
             'user_agent', e.user_agent, 'ip_address', e.ip_address, 'context', e.context
           )) AS context
    FROM public.agent_collection_errors e
    LEFT JOIN public.profiles ap ON ap.id = e.agent_id
    LEFT JOIN public.profiles tp ON tp.id = e.tenant_id
    WHERE e.occurred_at >= v_since

    UNION ALL
    SELECT ('anomaly:' || a.id::text), a.detected_at,
           'anomaly', a.severity, 'posted', a.rule_fired,
           initcap(replace(a.rule_fired, '_', ' ')),
           a.agent_id, ap.full_name, ap.phone, tp.full_name, c.amount, a.rent_request_id,
           format('status %s, channel %s', a.status, COALESCE(a.collection_channel,'-')),
           jsonb_strip_nulls(jsonb_build_object(
             'rule_fired', a.rule_fired, 'status', a.status, 'channel', a.collection_channel,
             'collection_id', a.collection_id, 'rent_request_id', a.rent_request_id,
             'detected_at', a.detected_at, 'acknowledged_by', ack.full_name,
             'acknowledged_at', a.acknowledged_at, 'acknowledged_note', a.acknowledged_note,
             'collection_amount', c.amount, 'collection_at', c.created_at,
             'float_before', c.float_before, 'float_after', c.float_after,
             'rule_detail', a.detail
           ))
    FROM public.tops_collection_anomalies a
    LEFT JOIN public.profiles ap ON ap.id = a.agent_id
    LEFT JOIN public.profiles tp ON tp.id = a.tenant_id
    LEFT JOIN public.profiles ack ON ack.id = a.acknowledged_by
    LEFT JOIN public.agent_collections c ON c.id = a.collection_id
    WHERE a.detected_at >= v_since AND a.status <> 'resolved'

    UNION ALL
    SELECT ('float:' || c.id::text), c.created_at,
           'engine', 'critical', 'posted', 'FLOAT_NOT_CONSUMED',
           'Collection posted against agent float but the balance did not move',
           c.agent_id, ap.full_name, ap.phone, tp.full_name, c.amount, c.rent_request_id,
           format('float unchanged at %s', round(COALESCE(c.float_before,0))),
           jsonb_strip_nulls(jsonb_build_object(
             'collection_id', c.id, 'collection_at', c.created_at,
             'channel', c.collection_channel, 'amount', c.amount,
             'float_before', c.float_before, 'float_after', c.float_after,
             'client_ref', c.client_ref, 'deposit_request_id', c.deposit_request_id,
             'notes', NULLIF(btrim(COALESCE(c.notes,'')), ''),
             'rent_request_id', c.rent_request_id
           ))
    FROM public.agent_collections c
    LEFT JOIN public.profiles ap ON ap.id = c.agent_id
    LEFT JOIN public.profiles tp ON tp.id = c.tenant_id
    WHERE c.created_at >= v_since AND c.reversed_at IS NULL AND c.amount > 0
      AND c.collection_channel = 'agent_float'
      AND c.float_before = c.float_after
      -- Once the detector has flagged it, the anomaly row owns it (open → shown
      -- there; resolved → closed). Without this every finding was shown twice.
      AND NOT EXISTS (SELECT 1 FROM public.tops_collection_anomalies x
                       WHERE x.collection_id = c.id AND x.rule_fired = 'float_leg_missing')

    UNION ALL
    SELECT ('app:' || r.id::text), r.created_at,
           'app', 'warning', 'client', NULL::text, r.message,
           r.user_id, ap.full_name, ap.phone, NULL::text, NULL::numeric, NULL::uuid,
           COALESCE(r.route, ''),
           jsonb_strip_nulls(jsonb_build_object(
             'route', r.route, 'role', r.role, 'label', r.label,
             'user_agent', r.user_agent, 'component_stack', r.component_stack,
             'context', r.context
           ))
    FROM public.client_error_reports r
    LEFT JOIN public.profiles ap ON ap.id = r.user_id
    WHERE r.created_at >= v_since
      AND (r.role IN ('agent','sub_agent','senior_agent')
           OR r.route ILIKE '/dashboard/agent%' OR r.route ILIKE '/agent/%' OR r.route = '/agent')
      -- Doc 178: browser noise that names no collection fault.
      AND r.message NOT ILIKE 'Failed to fetch%'
      AND r.message NOT ILIKE 'Script error%'
      AND r.message NOT ILIKE '%writeText%Clipboard%'
      AND r.message NOT ILIKE 'Copy is not available%'
      AND r.message NOT ILIKE 'ResizeObserver loop%'
      AND r.message NOT ILIKE '%window.ethereum%'
      AND r.message NOT ILIKE '%reading ''M_ID''%'
      AND r.message NOT ILIKE '%chrome: call method%timed out%'
      AND r.message NOT ILIKE 'signal is aborted without reason%'
      AND COALESCE(r.component_stack, '') NOT ILIKE '%chrome-extension://%'
      AND COALESCE(r.context::text, '') NOT ILIKE '%chrome-extension://%'

  ) q
  WHERE p_source IS NULL OR q.source = p_source
  ORDER BY q.occurred_at DESC
  LIMIT v_lim;
END;
$function$;
