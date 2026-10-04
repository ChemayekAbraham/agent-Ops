DROP FUNCTION IF EXISTS public.partner_ops_proxy_agent_pv(date, text, text, text, integer, integer);
CREATE FUNCTION public.partner_ops_proxy_agent_pv(p_month date, p_search text, p_sort text, p_dir text, p_limit integer, p_offset integer)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_month date := date_trunc('month', COALESCE(p_month, (now() AT TIME ZONE 'Africa/Kampala')::date))::date;
  v_cfg jsonb := public.proxy_pv_target_for(v_month);
  v_target numeric := (v_cfg->>'monthly_pv_target')::numeric;
  v_wd int := GREATEST((v_cfg->>'working_days')::int, 1);
  v_elapsed int := public.proxy_pv_working_days_elapsed(v_month);
  v_expected numeric;
  v_lim int := LEAST(GREATEST(COALESCE(p_limit,50),1),200);
  v_off int := GREATEST(COALESCE(p_offset,0),0);
  v_q text := NULLIF(btrim(COALESCE(p_search,'')),'')
;
  v_sort text := COALESCE(NULLIF(btrim(COALESCE(p_sort,'')),''), 'total_pv');
  v_asc boolean := lower(COALESCE(p_dir,'desc')) = 'asc';
  v_total int;
  v_rows jsonb;
  v_kpis jsonb;
BEGIN
  IF NOT public.is_proxy_directory_viewer(auth.uid()) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  v_expected := ROUND(v_target * (LEAST(v_elapsed, v_wd)::numeric / v_wd));

  SELECT jsonb_build_object(
           'agents_total', COUNT(*),
           'team_total_pv', COALESCE(SUM(r.total_pv),0),
           'team_new_investment', COALESCE(SUM(r.new_investment),0),
           'team_topups', COALESCE(SUM(r.topups),0),
           'team_commitments', COALESCE(SUM(r.commitments),0)::int,
           'team_commitment_pv', COALESCE(SUM(r.commitment_pv),0),
           'team_investment_pv', COALESCE(SUM(r.investment_pv),0),
           'team_topup_pv', COALESCE(SUM(r.topup_pv),0),
           'expected_mtd_pv', v_expected,
           'monthly_pv_target', v_target,
           'working_days', v_wd,
           'working_days_elapsed', v_elapsed,
           'working_days_remaining', GREATEST(v_wd - v_elapsed, 0),
           'daily_pv_target', ROUND(v_target / v_wd),
           'at_or_above_target', COUNT(*) FILTER (WHERE v_expected > 0 AND r.total_pv >= v_expected),
           'below_target', COUNT(*) FILTER (WHERE v_expected = 0 OR r.total_pv < v_expected),
           'period_month', v_month
         ) INTO v_kpis
    FROM public.proxy_pv_agent_rows(v_month) r;

  SELECT COUNT(*)::int INTO v_total
    FROM public.proxy_pv_agent_rows(v_month) r
   WHERE v_q IS NULL OR r.name ILIKE '%'||v_q||'%' OR COALESCE(r.phone,'') ILIKE '%'||v_q||'%';

  SELECT jsonb_agg(s.obj) INTO v_rows FROM (
    SELECT jsonb_build_object(
             'agent_user_id', r.agent_user_id,
             'name', r.name,
             'status', r.status,
             'avatar_url', r.avatar_url,
             'phone', r.phone,
             'commitments', r.commitments,
             'commitment_pv', r.commitment_pv,
             'new_investment', r.new_investment,
             'investment_pv', r.investment_pv,
             'topups', r.topups,
             'topup_pv', r.topup_pv,
             'total_pv', r.total_pv,
             'expected_pv', v_expected,
             'performance_pct', CASE WHEN v_expected > 0 THEN ROUND((r.total_pv / v_expected) * 100, 1) ELSE 0 END,
             'monthly_performance_pct', CASE WHEN v_target > 0 THEN ROUND((r.total_pv / v_target) * 100, 1) ELSE 0 END
           ) AS obj
      FROM public.proxy_pv_agent_rows(v_month) r
     WHERE v_q IS NULL OR r.name ILIKE '%'||v_q||'%' OR COALESCE(r.phone,'') ILIKE '%'||v_q||'%'
     ORDER BY
       CASE WHEN v_sort = 'name' AND v_asc THEN r.name END ASC NULLS LAST,
       CASE WHEN v_sort = 'name' AND NOT v_asc THEN r.name END DESC NULLS LAST,
       CASE WHEN v_asc THEN
         CASE v_sort
           WHEN 'commitments' THEN r.commitments::numeric
           WHEN 'new_investment' THEN r.new_investment
           WHEN 'topups' THEN r.topups
           WHEN 'performance_pct' THEN CASE WHEN v_expected > 0 THEN (r.total_pv / v_expected) * 100 ELSE 0 END
           ELSE r.total_pv
         END
       END ASC NULLS LAST,
       CASE WHEN NOT v_asc THEN
         CASE v_sort
           WHEN 'commitments' THEN r.commitments::numeric
           WHEN 'new_investment' THEN r.new_investment
           WHEN 'topups' THEN r.topups
           WHEN 'performance_pct' THEN CASE WHEN v_expected > 0 THEN (r.total_pv / v_expected) * 100 ELSE 0 END
           ELSE r.total_pv
         END
       END DESC NULLS LAST,
       r.name ASC
     LIMIT v_lim OFFSET v_off
  ) s;

  RETURN jsonb_build_object(
    'period_month', v_month,
    'total', v_total,
    'limit', v_lim,
    'offset', v_off,
    'kpis', v_kpis,
    'rows', COALESCE(v_rows, '[]'::jsonb)
  );
END;
$fn$;