CREATE OR REPLACE FUNCTION public.get_payables_contract_schedule(p_granularity text DEFAULT 'day', p_periods integer DEFAULT 7, p_as_at date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_gran text := lower(COALESCE(p_granularity,'day'));
  v_periods integer := LEAST(GREATEST(COALESCE(p_periods,7),1),60);
  v_today date := COALESCE(p_as_at,(now() AT TIME ZONE 'Africa/Nairobi')::date);
  v_step interval;
  v_base date;
  v_result jsonb;
BEGIN
  PERFORM payables_guard();
  IF v_gran NOT IN ('day','week','month','quarter','year') THEN v_gran := 'day'; END IF;
  v_step := CASE v_gran WHEN 'day' THEN interval '1 day' WHEN 'week' THEN interval '1 week'
            WHEN 'month' THEN interval '1 month' WHEN 'quarter' THEN interval '3 months' ELSE interval '1 year' END;
  v_base := CASE v_gran WHEN 'day' THEN v_today WHEN 'week' THEN date_trunc('week',v_today)::date
            WHEN 'month' THEN date_trunc('month',v_today)::date WHEN 'quarter' THEN date_trunc('quarter',v_today)::date
            ELSE date_trunc('year',v_today)::date END;
  -- Contractual schedule from every open obligation with a due date, regardless of payment history.
  -- Overdue obligations (due before today) are contractually payable now, so they land in the first period.
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'index', i, 'period_start', ps, 'contract_amount', COALESCE(amt,0), 'overdue_included', COALESCE(od,0)
    ) ORDER BY i), '[]'::jsonb)
  INTO v_result
  FROM (
    SELECT i, ps,
      (SELECT ROUND(SUM(l.outstanding_amount),2) FROM v_payables_lines l
        WHERE l.due_date IS NOT NULL AND (
          (l.due_date BETWEEN GREATEST(ps, v_today) AND pe)
          OR (i = 0 AND l.due_date < v_today))) AS amt,
      CASE WHEN i = 0 THEN (SELECT ROUND(SUM(l.outstanding_amount),2) FROM v_payables_lines l
        WHERE l.due_date IS NOT NULL AND l.due_date < v_today) END AS od
    FROM (SELECT i, (v_base + (v_step * i))::date ps,
                 ((v_base + (v_step * (i+1))) - interval '1 day')::date pe
          FROM generate_series(0, v_periods-1) i) x
  ) y;
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.get_payables_contract_schedule(text,integer,date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_payables_contract_schedule(text,integer,date) TO authenticated, service_role;