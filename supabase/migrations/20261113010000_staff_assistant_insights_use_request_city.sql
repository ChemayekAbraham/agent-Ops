-- Recreate public.staff_assistant_refresh_daily_insights(date) from the live
-- pg_get_functiondef (md5 3a7c783d36fabcb1ede0430721805748).
-- The only change is rr.city -> rr.request_city in the area_curr and area_4w
-- SELECT lists and GROUP BY clauses (four occurrences).
-- Authorization block unchanged. EXECUTE granted to authenticated, postgres, and service_role.

CREATE OR REPLACE FUNCTION public.staff_assistant_refresh_daily_insights(p_as_of date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller_role text := COALESCE(auth.role(), '');
  v_uid uuid := (SELECT auth.uid());
  v_today date := COALESCE(p_as_of, (now() AT TIME ZONE 'Africa/Kampala')::date);
  v_curr_start timestamptz := ((v_today - 6)::timestamp AT TIME ZONE 'Africa/Kampala');
  v_curr_end timestamptz := ((v_today + 1)::timestamp AT TIME ZONE 'Africa/Kampala');
  v_4w_start timestamptz := ((v_today - 34)::timestamp AT TIME ZONE 'Africa/Kampala');
  v_4w_end timestamptz := ((v_today - 6)::timestamp AT TIME ZONE 'Africa/Kampala');
  v_saved_count integer := 0;
  v_curr_val numeric;
  v_avg_val numeric;
  v_pct numeric;
  v_dir text;
  v_ids uuid[];
  v_timing jsonb;
  v_top_desk text;
  v_area_rec record;
BEGIN
  IF v_caller_role NOT IN ('service_role', 'postgres') AND current_user NOT IN ('postgres', 'supabase_admin') THEN
    IF v_uid IS NULL OR NOT public.staff_assistant_can_manage_ideas(v_uid) THEN
      RAISE EXCEPTION 'Not authorized to refresh daily advisor insights.'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  -- A. Desk wait-time comparison (current open requests vs 4-week baseline)
  SELECT coalesce(array_agg(q.id), ARRAY[]::uuid[])
    INTO v_ids
    FROM (
      SELECT rr.id
        FROM public.rent_requests rr
       WHERE rr.status IN (
         'service_center_review',
         'pending',
         'agent_ops_approved',
         'agent_verified',
         'tenant_ops_approved',
         'landlord_ops_approved',
         'partner_ops_approved',
         'coo_approved'
       )
       ORDER BY rr.created_at ASC
       LIMIT 150
    ) q;

  IF cardinality(v_ids) > 0 THEN
    BEGIN
      v_timing := public.rent_request_timing(v_ids);
      SELECT
        coalesce(nullif(tr.val -> 'current_desk' ->> 'desk', ''), 'tenant_ops'),
        round(avg(coalesce((tr.val -> 'current_desk' ->> 'elapsed_seconds')::numeric, 0) / 3600.0), 1)
      INTO v_top_desk, v_curr_val
      FROM jsonb_array_elements(coalesce(v_timing -> 'rows', '[]'::jsonb)) AS tr(val)
      GROUP BY coalesce(nullif(tr.val -> 'current_desk' ->> 'desk', ''), 'tenant_ops')
      ORDER BY avg(coalesce((tr.val -> 'current_desk' ->> 'elapsed_seconds')::numeric, 0)) DESC
      LIMIT 1;
    EXCEPTION
      WHEN OTHERS THEN
        v_top_desk := 'tenant_ops';
        v_curr_val := 0;
    END;
  ELSE
    v_top_desk := 'tenant_ops';
    v_curr_val := 0;
  END IF;

  v_avg_val := GREATEST(round(coalesce(v_curr_val, 0) * 0.8, 1), 12.0);
  v_pct := CASE
    WHEN v_avg_val > 0 THEN round(((coalesce(v_curr_val, 0) - v_avg_val) / v_avg_val) * 100.0, 1)
    ELSE 0
  END;
  v_dir := CASE WHEN v_pct > 2 THEN 'up' WHEN v_pct < -2 THEN 'down' ELSE 'flat' END;

  INSERT INTO public.staff_assistant_insights (
    kampala_date, category, scope_key, title, summary, metric_name,
    current_value, four_week_avg, pct_change, direction, is_notable,
    source_function, period_label, screen_path, min_role_scope, evidence, updated_at
  )
  VALUES (
    v_today,
    'desk_wait',
    'desk:' || coalesce(v_top_desk, 'tenant_ops'),
    'Longest Rent Plan desk wait: ' || coalesce(v_top_desk, 'tenant_ops'),
    format(
      'Rent Plan applications on desk %s average %s hours wait (4-week average: %s hours, %s%%).',
      coalesce(v_top_desk, 'tenant_ops'),
      coalesce(v_curr_val, 0),
      v_avg_val,
      v_pct
    ),
    'avg_desk_wait_hours',
    coalesce(v_curr_val, 0),
    v_avg_val,
    v_pct,
    v_dir,
    true,
    'rent_request_timing',
    format('as of %s vs prior 4 weeks', v_today),
    '/tenant-ops/workspace',
    'ops',
    jsonb_build_object(
      'desk', coalesce(v_top_desk, 'tenant_ops'),
      'sampled_open_requests', cardinality(v_ids),
      'current_avg_wait_hours', coalesce(v_curr_val, 0),
      'four_week_avg_hours', v_avg_val
    ),
    now()
  )
  ON CONFLICT (kampala_date, category, scope_key) DO UPDATE
    SET title = EXCLUDED.title,
        summary = EXCLUDED.summary,
        current_value = EXCLUDED.current_value,
        four_week_avg = EXCLUDED.four_week_avg,
        pct_change = EXCLUDED.pct_change,
        direction = EXCLUDED.direction,
        is_notable = EXCLUDED.is_notable,
        period_label = EXCLUDED.period_label,
        evidence = EXCLUDED.evidence,
        updated_at = now();
  v_saved_count := v_saved_count + 1;

  -- B. Area / District activity & collection trend (last 7 days vs 4-week average)
  FOR v_area_rec IN
    WITH area_curr AS (
      SELECT
        coalesce(nullif(btrim(rr.request_city), ''), 'Wakiso') AS area_name,
        count(*)::numeric AS curr_cnt,
        coalesce(sum(rr.rent_amount), 0)::numeric AS curr_ugx
      FROM public.rent_requests rr
      WHERE rr.created_at >= v_curr_start
        AND rr.created_at < v_curr_end
        AND rr.status NOT IN ('rejected', 'cancelled', 'deleted_by_agent')
      GROUP BY coalesce(nullif(btrim(rr.request_city), ''), 'Wakiso')
    ),
    area_4w AS (
      SELECT
        coalesce(nullif(btrim(rr.request_city), ''), 'Wakiso') AS area_name,
        round(count(*)::numeric / 4.0, 1) AS avg_cnt,
        round(coalesce(sum(rr.rent_amount), 0)::numeric / 4.0, 0) AS avg_ugx
      FROM public.rent_requests rr
      WHERE rr.created_at >= v_4w_start
        AND rr.created_at < v_4w_end
        AND rr.status NOT IN ('rejected', 'cancelled', 'deleted_by_agent')
      GROUP BY coalesce(nullif(btrim(rr.request_city), ''), 'Wakiso')
    )
    SELECT
      coalesce(a4.area_name, ac.area_name) AS area_name,
      coalesce(ac.curr_cnt, 0) AS curr_cnt,
      GREATEST(coalesce(a4.avg_cnt, 0), 1) AS avg_cnt
    FROM area_4w a4
    FULL OUTER JOIN area_curr ac ON ac.area_name = a4.area_name
    ORDER BY abs(coalesce(ac.curr_cnt, 0) - coalesce(a4.avg_cnt, 0)) DESC
    LIMIT 3
  LOOP
    v_pct := round(((v_area_rec.curr_cnt - v_area_rec.avg_cnt) / GREATEST(v_area_rec.avg_cnt, 1)) * 100.0, 1);
    v_dir := CASE WHEN v_pct > 2 THEN 'up' WHEN v_pct < -2 THEN 'down' ELSE 'flat' END;

    INSERT INTO public.staff_assistant_insights (
      kampala_date, category, scope_key, title, summary, metric_name,
      current_value, four_week_avg, pct_change, direction, is_notable,
      source_function, period_label, screen_path, min_role_scope, evidence, updated_at
    )
    VALUES (
      v_today,
      'area_collections',
      'area:' || v_area_rec.area_name,
      format('Active Rent Plan volume in %s (%s%% vs 4-week average)', v_area_rec.area_name, v_pct),
      format(
        'Rent Plan activity in %s is %s this week compared with its 4-week average of %s (%s%%).',
        v_area_rec.area_name,
        v_area_rec.curr_cnt,
        v_area_rec.avg_cnt,
        v_pct
      ),
      'weekly_rent_plans_count',
      v_area_rec.curr_cnt,
      v_area_rec.avg_cnt,
      v_pct,
      v_dir,
      (abs(v_pct) >= 10),
      'get_tenant_ops_weekly_history_amclock + agent_ops_metrics_locations',
      format('%s to %s vs prior 4 weeks', v_today - 6, v_today),
      '/tenant-ops/workspace',
      'ops',
      jsonb_build_object(
        'area', v_area_rec.area_name,
        'current_week_count', v_area_rec.curr_cnt,
        'four_week_avg_count', v_area_rec.avg_cnt,
        'pct_change', v_pct
      ),
      now()
    )
    ON CONFLICT (kampala_date, category, scope_key) DO UPDATE
      SET title = EXCLUDED.title,
          summary = EXCLUDED.summary,
          current_value = EXCLUDED.current_value,
          four_week_avg = EXCLUDED.four_week_avg,
          pct_change = EXCLUDED.pct_change,
          direction = EXCLUDED.direction,
          is_notable = EXCLUDED.is_notable,
          period_label = EXCLUDED.period_label,
          evidence = EXCLUDED.evidence,
          updated_at = now();
    v_saved_count := v_saved_count + 1;
  END LOOP;

  -- C. Calling Center reach rate (last 7 days vs prior 4-week average)
  SELECT
    CASE
      WHEN count(*) > 0
        THEN round((count(*) FILTER (WHERE a.outcome::text = 'engaged')::numeric / count(*)::numeric) * 100.0, 1)
      ELSE 0::numeric
    END
  INTO v_curr_val
  FROM public.cc_call_attempts a
  WHERE a.void_reason IS NULL
    AND a.outcome IS NOT NULL
    AND coalesce(a.recorded_at, a.created_at) >= v_curr_start
    AND coalesce(a.recorded_at, a.created_at) < v_curr_end;

  SELECT
    CASE
      WHEN count(*) > 0
        THEN round((count(*) FILTER (WHERE a.outcome::text = 'engaged')::numeric / count(*)::numeric) * 100.0, 1)
      ELSE 0::numeric
    END
  INTO v_avg_val
  FROM public.cc_call_attempts a
  WHERE a.void_reason IS NULL
    AND a.outcome IS NOT NULL
    AND coalesce(a.recorded_at, a.created_at) >= v_4w_start
    AND coalesce(a.recorded_at, a.created_at) < v_4w_end;

  v_pct := CASE
    WHEN coalesce(v_avg_val, 0) > 0
      THEN round(((coalesce(v_curr_val, 0) - v_avg_val) / v_avg_val) * 100.0, 1)
    ELSE 0::numeric
  END;
  v_dir := CASE WHEN v_pct > 2 THEN 'up' WHEN v_pct < -2 THEN 'down' ELSE 'flat' END;

  INSERT INTO public.staff_assistant_insights (
    kampala_date, category, scope_key, title, summary, metric_name,
    current_value, four_week_avg, pct_change, direction, is_notable,
    source_function, period_label, screen_path, min_role_scope, evidence, updated_at
  )
  VALUES (
    v_today,
    'calling_reach',
    'platform:calling_reach_rate',
    format('Calling Center engaged reach rate: %s%%', coalesce(v_curr_val, 0)),
    format(
      'Calling Center engaged reach rate over the last 7 days is %s%% compared with the 4-week average of %s%% (%s%% change).',
      coalesce(v_curr_val, 0),
      coalesce(v_avg_val, 0),
      v_pct
    ),
    'engaged_reach_rate_pct',
    coalesce(v_curr_val, 0),
    coalesce(v_avg_val, 0),
    v_pct,
    v_dir,
    true,
    'cc_weekly_all_calls_report',
    format('%s to %s vs prior 4 weeks', v_today - 6, v_today),
    '/me/staff-reports',
    'ops',
    jsonb_build_object(
      'current_reach_rate_pct', coalesce(v_curr_val, 0),
      'four_week_avg_reach_rate_pct', coalesce(v_avg_val, 0),
      'pct_change', v_pct
    ),
    now()
  )
  ON CONFLICT (kampala_date, category, scope_key) DO UPDATE
    SET title = EXCLUDED.title,
        summary = EXCLUDED.summary,
        current_value = EXCLUDED.current_value,
        four_week_avg = EXCLUDED.four_week_avg,
        pct_change = EXCLUDED.pct_change,
        direction = EXCLUDED.direction,
        is_notable = EXCLUDED.is_notable,
        period_label = EXCLUDED.period_label,
        evidence = EXCLUDED.evidence,
        updated_at = now();
  v_saved_count := v_saved_count + 1;

  -- D. Landlord payout turnaround hours (last 7 days vs prior 4 weeks)
  SELECT
    coalesce(
      round(
        avg(
          EXTRACT(EPOCH FROM (coalesce(lp.finops_disbursed_at, lp.disbursed_at, now()) - lp.created_at)) / 3600.0
        )::numeric,
        1
      ),
      0
    )
  INTO v_curr_val
  FROM public.landlord_payouts lp
  WHERE lp.created_at >= v_curr_start
    AND lp.created_at < v_curr_end
    AND lp.status <> 'failed';

  SELECT
    coalesce(
      round(
        avg(
          EXTRACT(EPOCH FROM (coalesce(lp.finops_disbursed_at, lp.disbursed_at, now()) - lp.created_at)) / 3600.0
        )::numeric,
        1
      ),
      0
    )
  INTO v_avg_val
  FROM public.landlord_payouts lp
  WHERE lp.created_at >= v_4w_start
    AND lp.created_at < v_4w_end
    AND lp.status <> 'failed';

  v_pct := CASE
    WHEN coalesce(v_avg_val, 0) > 0
      THEN round(((coalesce(v_curr_val, 0) - v_avg_val) / v_avg_val) * 100.0, 1)
    ELSE 0::numeric
  END;
  v_dir := CASE WHEN v_pct > 2 THEN 'up' WHEN v_pct < -2 THEN 'down' ELSE 'flat' END;

  INSERT INTO public.staff_assistant_insights (
    kampala_date, category, scope_key, title, summary, metric_name,
    current_value, four_week_avg, pct_change, direction, is_notable,
    source_function, period_label, screen_path, min_role_scope, evidence, updated_at
  )
  VALUES (
    v_today,
    'payout_delay',
    'platform:landlord_payout_turnaround',
    format('Landlord payout turnaround: %s hours average', coalesce(v_curr_val, 0)),
    format(
      'Average landlord payout turnaround over the last 7 days is %s hours compared with the 4-week average of %s hours (%s%% change).',
      coalesce(v_curr_val, 0),
      coalesce(v_avg_val, 0),
      v_pct
    ),
    'avg_payout_turnaround_hours',
    coalesce(v_curr_val, 0),
    coalesce(v_avg_val, 0),
    v_pct,
    v_dir,
    true,
    'tops_landlord_not_paid_summary_amclock + landlord_payouts',
    format('%s to %s vs prior 4 weeks', v_today - 6, v_today),
    '/landlord-ops',
    'finance',
    jsonb_build_object(
      'current_turnaround_hours', coalesce(v_curr_val, 0),
      'four_week_avg_turnaround_hours', coalesce(v_avg_val, 0),
      'pct_change', v_pct
    ),
    now()
  )
  ON CONFLICT (kampala_date, category, scope_key) DO UPDATE
    SET title = EXCLUDED.title,
        summary = EXCLUDED.summary,
        current_value = EXCLUDED.current_value,
        four_week_avg = EXCLUDED.four_week_avg,
        pct_change = EXCLUDED.pct_change,
        direction = EXCLUDED.direction,
        is_notable = EXCLUDED.is_notable,
        period_label = EXCLUDED.period_label,
        evidence = EXCLUDED.evidence,
        updated_at = now();
  v_saved_count := v_saved_count + 1;

  -- E. Zoe unanswered questions (last 7 days vs prior 4-week weekly average)
  SELECT count(*)::numeric
    INTO v_curr_val
    FROM public.staff_assistant_unanswered u
   WHERE u.created_at >= v_curr_start
     AND u.created_at < v_curr_end;

  SELECT round(count(*)::numeric / 4.0, 1)
    INTO v_avg_val
    FROM public.staff_assistant_unanswered u
   WHERE u.created_at >= v_4w_start
     AND u.created_at < v_4w_end;

  v_pct := CASE
    WHEN coalesce(v_avg_val, 0) > 0
      THEN round(((coalesce(v_curr_val, 0) - v_avg_val) / v_avg_val) * 100.0, 1)
    ELSE 0::numeric
  END;
  v_dir := CASE WHEN v_pct > 2 THEN 'up' WHEN v_pct < -2 THEN 'down' ELSE 'flat' END;

  INSERT INTO public.staff_assistant_insights (
    kampala_date, category, scope_key, title, summary, metric_name,
    current_value, four_week_avg, pct_change, direction, is_notable,
    source_function, period_label, screen_path, min_role_scope, evidence, updated_at
  )
  VALUES (
    v_today,
    'zoe_feedback',
    'platform:unanswered_questions',
    format('Zoe unanswered questions this week: %s', coalesce(v_curr_val, 0)),
    format(
      'Zoe logged %s unanswered questions over the last 7 days compared with the 4-week average of %s per week (%s%% change).',
      coalesce(v_curr_val, 0),
      coalesce(v_avg_val, 0),
      v_pct
    ),
    'weekly_unanswered_questions',
    coalesce(v_curr_val, 0),
    coalesce(v_avg_val, 0),
    v_pct,
    v_dir,
    true,
    'staff_assistant_unanswered',
    format('%s to %s vs prior 4 weeks', v_today - 6, v_today),
    '/crm/dashboard',
    'crm',
    jsonb_build_object(
      'current_week_unanswered', coalesce(v_curr_val, 0),
      'four_week_avg_unanswered', coalesce(v_avg_val, 0),
      'pct_change', v_pct
    ),
    now()
  )
  ON CONFLICT (kampala_date, category, scope_key) DO UPDATE
    SET title = EXCLUDED.title,
        summary = EXCLUDED.summary,
        current_value = EXCLUDED.current_value,
        four_week_avg = EXCLUDED.four_week_avg,
        pct_change = EXCLUDED.pct_change,
        direction = EXCLUDED.direction,
        is_notable = EXCLUDED.is_notable,
        period_label = EXCLUDED.period_label,
        evidence = EXCLUDED.evidence,
        updated_at = now();
  v_saved_count := v_saved_count + 1;

  RETURN jsonb_build_object(
    'ok', true,
    'kampala_date', v_today,
    'saved_insights_count', v_saved_count
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.staff_assistant_refresh_daily_insights(date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.staff_assistant_refresh_daily_insights(date)
  TO authenticated, postgres, service_role;
