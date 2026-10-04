CREATE OR REPLACE FUNCTION public.agent_ops_compute_snapshot(p_granularity text, p_period_start date)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_start date;
  v_end date;
  v_start_ts timestamptz;
  v_end_ts timestamptz;
  v_active_end date;
  v_active_end_ts timestamptz;
  v_snapshot_id uuid;
  v_frozen timestamptz;
  v_dedup_collapsed integer := 0;
  v_excluded integer := 0;
  v_unresolved integer := 0;
  v_opening integer := 0;
  v_new integer := 0;
  v_removed integer := 0;
  v_active30 integer := 0;
  v_qual_open integer := 0;
  v_converted integer := 0;
  v_stage_onboarded integer := 0;
  v_stage_training integer := 0;
  v_stage_qualified integer := 0;
  v_centres_opening integer := 0;
  v_centres_opened integer := 0;
  v_centres_closed integer := 0;
  v_provisional boolean;
BEGIN
  IF p_granularity NOT IN ('daily','weekly','monthly') THEN
    RAISE EXCEPTION 'invalid granularity %', p_granularity;
  END IF;

  IF p_granularity = 'daily' THEN
    v_start := p_period_start;
    v_end := p_period_start;
  ELSIF p_granularity = 'weekly' THEN
    v_start := (date_trunc('week', p_period_start::timestamp))::date;
    v_end := v_start + 6;
  ELSE
    v_start := (date_trunc('month', p_period_start::timestamp))::date;
    v_end := (v_start + interval '1 month - 1 day')::date;
  END IF;

  SELECT id, frozen_at INTO v_snapshot_id, v_frozen
  FROM public.agent_ops_period_snapshots
  WHERE granularity = p_granularity AND period_start = v_start;

  IF v_snapshot_id IS NOT NULL AND v_frozen IS NOT NULL THEN
    RETURN v_snapshot_id;  -- frozen snapshots are never recomputed
  END IF;

  v_start_ts := (v_start::timestamp) AT TIME ZONE 'Africa/Kampala';
  v_end_ts := ((v_end + 1)::timestamp) AT TIME ZONE 'Africa/Kampala';
  v_provisional := (v_end >= (now() AT TIME ZONE 'Africa/Kampala')::date);

  -- active window is anchored on the earlier of period_end and today (Kampala),
  -- so an open period does not measure activity against a future window.
  v_active_end := least(v_end, (now() AT TIME ZONE 'Africa/Kampala')::date);
  v_active_end_ts := ((v_active_end + 1)::timestamp) AT TIME ZONE 'Africa/Kampala';

  -- ---------- agent stock base (lifetime basis, deletions included for removals) ----------
  CREATE TEMP TABLE _ao_base ON COMMIT DROP AS
  SELECT p.id,
         p.created_at,
         NULLIF(lower(regexp_replace(COALESCE(p.national_id,''), '[^a-zA-Z0-9]', '', 'g')), '') AS nid_norm,
         NULLIF(right(regexp_replace(COALESCE(p.phone,''), '[^0-9]', '', 'g'), 9), '') AS phone_norm,
         rr.first_rr_at,
         CASE WHEN p.deleted_at IS NOT NULL THEN p.deleted_at
              WHEN COALESCE(p.is_frozen,false) THEN p.frozen_at
              ELSE NULL END AS removed_at,
         p.referrer_id,
         p.managing_agent_id,
         p.ug_village_id,
         p.district_id
  FROM public.profiles p
  JOIN (
    SELECT agent_id, min(created_at) AS first_rr_at
    FROM public.rent_requests
    WHERE agent_id IS NOT NULL
    GROUP BY agent_id
  ) rr ON rr.agent_id = p.id
  WHERE EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = p.id AND ur.role = 'agent'::app_role AND COALESCE(ur.enabled, true)
  );

  -- ---------- deduplicate on national_id then phone (earliest created wins) ----------
  CREATE TEMP TABLE _ao_agents ON COMMIT DROP AS
  SELECT b.*
  FROM _ao_base b
  WHERE NOT EXISTS (
    SELECT 1 FROM _ao_base o
    WHERE o.id <> b.id
      AND ( (b.nid_norm IS NOT NULL AND o.nid_norm = b.nid_norm)
         OR (b.phone_norm IS NOT NULL AND o.phone_norm = b.phone_norm) )
      AND (o.created_at, o.id) < (b.created_at, b.id)
  );

  SELECT (SELECT count(*) FROM _ao_base) - (SELECT count(*) FROM _ao_agents) INTO v_dedup_collapsed;

  -- ---------- geography resolution ----------
  CREATE TEMP TABLE _ao_geo ON COMMIT DROP AS
  SELECT a.id,
         COALESCE(d.id, a.district_id) AS district_id,
         sc.id AS subcounty_id
  FROM _ao_agents a
  LEFT JOIN public.ug_villages v ON v.id = a.ug_village_id
  LEFT JOIN public.ug_parishes pa ON pa.id = v.parish_id
  LEFT JOIN public.ug_subcounties sc ON sc.id = pa.subcounty_id
  LEFT JOIN public.ug_counties c ON c.id = sc.county_id
  LEFT JOIN public.ug_districts d ON d.id = c.district_id;

  SELECT count(*) INTO v_unresolved FROM _ao_geo WHERE district_id IS NULL;

  -- ---------- core counts ----------
  SELECT count(*) INTO v_opening
  FROM _ao_agents a
  WHERE a.first_rr_at < v_start_ts
    AND (a.removed_at IS NULL OR a.removed_at >= v_start_ts);

  SELECT count(*) INTO v_new
  FROM _ao_agents a
  WHERE a.first_rr_at >= v_start_ts AND a.first_rr_at < v_end_ts
    AND NOT EXISTS (
      SELECT 1 FROM public.agent_ops_recruiter_exclusions x
      WHERE x.profile_id IN (a.referrer_id, a.managing_agent_id)
    );

  SELECT count(*) INTO v_excluded
  FROM _ao_agents a
  WHERE a.first_rr_at >= v_start_ts AND a.first_rr_at < v_end_ts
    AND EXISTS (
      SELECT 1 FROM public.agent_ops_recruiter_exclusions x
      WHERE x.profile_id IN (a.referrer_id, a.managing_agent_id)
    );

  SELECT count(*) INTO v_removed
  FROM _ao_agents a
  WHERE a.removed_at >= v_start_ts AND a.removed_at < v_end_ts;

  SELECT count(*) INTO v_active30
  FROM _ao_agents a
  WHERE EXISTS (
    SELECT 1 FROM public.rent_requests r
    WHERE r.agent_id = a.id
      AND r.created_at >= v_active_end_ts - interval '30 days'
      AND r.created_at < v_active_end_ts
  );

  -- qualified at open: latest stage event before period start is 'qualified', no rent request yet
  CREATE TEMP TABLE _ao_qual_open ON COMMIT DROP AS
  SELECT a.id
  FROM _ao_agents a
  JOIN LATERAL (
    SELECT e.stage FROM public.agent_ops_pipeline_stage_events e
    WHERE e.agent_profile_id = a.id AND e.entered_at < v_start_ts
    ORDER BY e.entered_at DESC, e.created_at DESC
    LIMIT 1
  ) le ON true
  WHERE le.stage = 'qualified'
    AND NOT EXISTS (
      SELECT 1 FROM public.rent_requests r
      WHERE r.agent_id = a.id AND r.created_at < v_start_ts
    );

  SELECT count(*) INTO v_qual_open FROM _ao_qual_open;

  SELECT count(*) INTO v_converted
  FROM _ao_qual_open q
  WHERE EXISTS (
    SELECT 1 FROM public.rent_requests r
    WHERE r.agent_id = q.id
      AND r.created_at >= v_start_ts AND r.created_at < v_end_ts
  );

  -- stage headcount at period_end (latest stage event per agent)
  SELECT count(*) FILTER (WHERE le.stage = 'onboarded'),
         count(*) FILTER (WHERE le.stage = 'training'),
         count(*) FILTER (WHERE le.stage = 'qualified')
    INTO v_stage_onboarded, v_stage_training, v_stage_qualified
  FROM _ao_agents a
  JOIN LATERAL (
    SELECT e.stage FROM public.agent_ops_pipeline_stage_events e
    WHERE e.agent_profile_id = a.id AND e.entered_at < v_end_ts
    ORDER BY e.entered_at DESC, e.created_at DESC
    LIMIT 1
  ) le ON true;

  -- service centres
  SELECT count(*) INTO v_centres_opening
  FROM public.service_centre_setups s
  WHERE s.approved_at IS NULL
    AND COALESCE(s.status,'pending') NOT IN ('rejected','closed')
    AND s.created_at < v_end_ts;

  SELECT count(*) INTO v_centres_opened
  FROM public.service_centre_setups s
  WHERE s.approved_at >= v_start_ts AND s.approved_at < v_end_ts;

  SELECT count(*) INTO v_centres_closed
  FROM public.service_centre_setups s
  WHERE COALESCE(s.status,'') IN ('rejected','closed')
    AND COALESCE(s.verified_at, s.created_at) >= v_start_ts
    AND COALESCE(s.verified_at, s.created_at) < v_end_ts;

  -- ---------- upsert snapshot ----------
  INSERT INTO public.agent_ops_period_snapshots (
    granularity, period_start, period_end,
    opening_agents, new_agents, removed_agents, closing_agents, active_agents_30d,
    qualified_at_open, converted_in_period,
    stage_onboarded, stage_training, stage_qualified,
    centres_opening, centres_opened, centres_closed,
    provisional, frozen_at, computed_at, basis
  ) VALUES (
    p_granularity, v_start, v_end,
    v_opening, v_new, v_removed, v_opening + v_new - v_removed, v_active30,
    v_qual_open, v_converted,
    v_stage_onboarded, v_stage_training, v_stage_qualified,
    v_centres_opening, v_centres_opened, v_centres_closed,
    v_provisional,
    CASE WHEN v_provisional THEN NULL ELSE now() END,
    now(),
    jsonb_build_object(
      'stock_definition_version', 'agent-stock-v1',
      'dedup_collapsed', v_dedup_collapsed,
      'exclusions_applied', v_excluded,
      'unresolved_geography', v_unresolved,
      'timezone', 'Africa/Kampala',
      'active_window_end', v_active_end,
      'centres_closed_basis', 'status in (rejected, closed) dated on COALESCE(verified_at, created_at); no transition history table exists'
    )
  )
  ON CONFLICT (granularity, period_start) DO UPDATE SET
    period_end = EXCLUDED.period_end,
    opening_agents = EXCLUDED.opening_agents,
    new_agents = EXCLUDED.new_agents,
    removed_agents = EXCLUDED.removed_agents,
    closing_agents = EXCLUDED.closing_agents,
    active_agents_30d = EXCLUDED.active_agents_30d,
    qualified_at_open = EXCLUDED.qualified_at_open,
    converted_in_period = EXCLUDED.converted_in_period,
    stage_onboarded = EXCLUDED.stage_onboarded,
    stage_training = EXCLUDED.stage_training,
    stage_qualified = EXCLUDED.stage_qualified,
    centres_opening = EXCLUDED.centres_opening,
    centres_opened = EXCLUDED.centres_opened,
    centres_closed = EXCLUDED.centres_closed,
    provisional = EXCLUDED.provisional,
    frozen_at = EXCLUDED.frozen_at,
    computed_at = EXCLUDED.computed_at,
    basis = EXCLUDED.basis
  RETURNING id INTO v_snapshot_id;

  -- ---------- district / subcounty breakdown ----------
  DELETE FROM public.agent_ops_district_snapshots WHERE snapshot_id = v_snapshot_id;

  INSERT INTO public.agent_ops_district_snapshots (snapshot_id, district_id, subcounty_id, agent_count, net_change, active_agents_30d)
  SELECT v_snapshot_id, g.district_id, NULL::integer,
         count(*) FILTER (WHERE a.first_rr_at < v_end_ts AND (a.removed_at IS NULL OR a.removed_at >= v_end_ts)),
         count(*) FILTER (WHERE a.first_rr_at >= v_start_ts AND a.first_rr_at < v_end_ts)
           - count(*) FILTER (WHERE a.removed_at >= v_start_ts AND a.removed_at < v_end_ts),
         count(*) FILTER (WHERE EXISTS (
           SELECT 1 FROM public.rent_requests r
           WHERE r.agent_id = a.id AND r.created_at >= v_end_ts - interval '30 days' AND r.created_at < v_end_ts))
  FROM _ao_agents a
  JOIN _ao_geo g ON g.id = a.id
  GROUP BY g.district_id;

  INSERT INTO public.agent_ops_district_snapshots (snapshot_id, district_id, subcounty_id, agent_count, net_change, active_agents_30d)
  SELECT v_snapshot_id, g.district_id, g.subcounty_id,
         count(*) FILTER (WHERE a.first_rr_at < v_end_ts AND (a.removed_at IS NULL OR a.removed_at >= v_end_ts)),
         count(*) FILTER (WHERE a.first_rr_at >= v_start_ts AND a.first_rr_at < v_end_ts)
           - count(*) FILTER (WHERE a.removed_at >= v_start_ts AND a.removed_at < v_end_ts),
         count(*) FILTER (WHERE EXISTS (
           SELECT 1 FROM public.rent_requests r
           WHERE r.agent_id = a.id AND r.created_at >= v_end_ts - interval '30 days' AND r.created_at < v_end_ts))
  FROM _ao_agents a
  JOIN _ao_geo g ON g.id = a.id
  WHERE g.subcounty_id IS NOT NULL
  GROUP BY g.district_id, g.subcounty_id;

  DROP TABLE IF EXISTS _ao_base;
  DROP TABLE IF EXISTS _ao_agents;
  DROP TABLE IF EXISTS _ao_geo;
  DROP TABLE IF EXISTS _ao_qual_open;

  RETURN v_snapshot_id;
END;
$function$;

SELECT public.agent_ops_compute_snapshot('daily',   current_date);
SELECT public.agent_ops_compute_snapshot('weekly',  date_trunc('week',  current_date)::date);
SELECT public.agent_ops_compute_snapshot('monthly', date_trunc('month', current_date)::date);