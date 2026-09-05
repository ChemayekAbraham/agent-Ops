CREATE OR REPLACE FUNCTION public.tppo_get_report_zone_a(p_granularity text, p_anchor date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_start date;
  v_end date;
  v_prior_anchor date;
  v_prior_start date;
  v_prior_end date;
  v_cur record;
  v_prior record;
  v_rate numeric;
  v_prior_rate numeric;
  v_threshold numeric;
  v_report record;
begin
  select b.period_start, b.period_end into v_start, v_end
  from public.tppo_period_bounds(p_granularity, p_anchor) b;

  v_prior_anchor := v_start - 1;

  select b.period_start, b.period_end into v_prior_start, v_prior_end
  from public.tppo_period_bounds(p_granularity, v_prior_anchor) b;

  perform public.tppo_freeze_period(p_granularity, p_anchor, false);
  perform public.tppo_freeze_period(p_granularity, v_prior_anchor, true);

  select * into v_cur
  from public.tppo_period_snapshots
  where granularity = p_granularity and period_start = v_start;

  select * into v_prior
  from public.tppo_period_snapshots
  where granularity = p_granularity and period_start = v_prior_start;

  select * into v_report
  from public.tppo_reports
  where granularity = p_granularity and period_start = v_start
  order by created_at desc
  limit 1;

  v_threshold := coalesce(v_report.threshold_pct, 70.0);

  if v_cur.scheduled_due_ugx is not null and v_cur.scheduled_due_ugx <> 0 then
    v_rate := round((v_cur.collected_ugx / v_cur.scheduled_due_ugx) * 100, 1);
  end if;

  if v_prior.scheduled_due_ugx is not null and v_prior.scheduled_due_ugx <> 0 then
    v_prior_rate := round((v_prior.collected_ugx / v_prior.scheduled_due_ugx) * 100, 1);
  end if;

  return jsonb_build_object(
    'granularity', p_granularity,
    'period_start', v_start,
    'period_end', v_end,
    'collected_ugx', v_cur.collected_ugx,
    'arrears_recovered_ugx', v_cur.arrears_recovered_ugx,
    'collected_total_ugx', v_cur.collected_total_ugx,
    'unallocated_ugx', v_cur.unallocated_ugx,
    'cohort_plan_count', v_cur.plan_count,
    'arrears_plan_count', v_cur.arrears_plan_count,
    'scheduled_due_ugx', v_cur.scheduled_due_ugx,
    'arrears_target_ugx', v_cur.arrears_target_ugx,
    'arrears_target_plan_count', v_cur.arrears_target_plan_count,
    'arrears_outstanding_ugx', v_cur.arrears_outstanding_ugx,
    'total_field_target_ugx', coalesce(v_cur.scheduled_due_ugx, 0) + coalesce(v_cur.arrears_target_ugx, 0),
    'provisional', v_cur.provisional,
    'collection_rate_pct', v_rate,
    'threshold_pct', v_threshold,
    'below_threshold', case when v_rate is null then null else v_rate < v_threshold end,
    'prior', jsonb_build_object(
      'period_start', v_prior_start,
      'period_end', v_prior_end,
      'collected_ugx', v_prior.collected_ugx,
      'arrears_recovered_ugx', v_prior.arrears_recovered_ugx,
      'collected_total_ugx', v_prior.collected_total_ugx,
      'unallocated_ugx', v_prior.unallocated_ugx,
      'cohort_plan_count', v_prior.plan_count,
      'arrears_plan_count', v_prior.arrears_plan_count,
      'scheduled_due_ugx', v_prior.scheduled_due_ugx,
      'arrears_target_ugx', v_prior.arrears_target_ugx,
      'arrears_target_plan_count', v_prior.arrears_target_plan_count,
      'arrears_outstanding_ugx', v_prior.arrears_outstanding_ugx,
      'total_field_target_ugx', coalesce(v_prior.scheduled_due_ugx, 0) + coalesce(v_prior.arrears_target_ugx, 0),
      'collection_rate_pct', v_prior_rate
    ),
    'rate_variance_pp', case
        when v_rate is null or v_prior_rate is null then null
        else round(v_rate - v_prior_rate, 1)
      end,
    'collected_delta_ugx', case
        when v_cur.collected_ugx is null or v_prior.collected_ugx is null then null
        else v_cur.collected_ugx - v_prior.collected_ugx
      end,
    'scheduled_delta_ugx', case
        when v_cur.scheduled_due_ugx is null or v_prior.scheduled_due_ugx is null then null
        else v_cur.scheduled_due_ugx - v_prior.scheduled_due_ugx
      end,
    'report_id', v_report.id,
    'status', v_report.status
  );
end;
$function$;