CREATE OR REPLACE FUNCTION public.get_cohort_retention(p_start timestamp with time zone, p_end timestamp with time zone, p_bucket text DEFAULT 'week'::text, p_periods integer DEFAULT 8)
 RETURNS TABLE(cohort_date date, cohort_size integer, period_number integer, active_users integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_trunc text;
  v_interval interval;
  v_days_per_period integer;
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'super_admin') OR
    public.has_role(auth.uid(), 'ceo') OR
    public.has_role(auth.uid(), 'cmo') OR
    public.has_role(auth.uid(), 'coo') OR
    public.has_role(auth.uid(), 'cto') OR
    public.has_role(auth.uid(), 'cfo') OR
    public.has_role(auth.uid(), 'manager')
  ) THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  IF p_bucket = 'day' THEN
    v_trunc := 'day';
    v_interval := interval '1 day';
    v_days_per_period := 1;
  ELSE
    v_trunc := 'week';
    v_interval := interval '1 week';
    v_days_per_period := 7;
  END IF;

  RETURN QUERY
  WITH cohorts AS (
    SELECT
      date_trunc(v_trunc, p.created_at)::date AS cohort_date,
      p.id AS user_id
    FROM public.profiles p
    WHERE p.created_at >= date_trunc(v_trunc, p_start)
      AND p.created_at <  date_trunc(v_trunc, p_end) + v_interval
  ),
  cohort_sizes AS (
    SELECT c.cohort_date, count(*)::int AS cohort_size
    FROM cohorts c GROUP BY c.cohort_date
  ),
  logins AS (
    SELECT
      COALESCE(o.resolved_user_id, o.actual_user_id) AS user_id,
      date_trunc(v_trunc, o.created_at)::date AS active_date
    FROM public.otp_login_audit o
    WHERE o.outcome = 'success'
      AND COALESCE(o.resolved_user_id, o.actual_user_id) IS NOT NULL
      AND o.created_at >= date_trunc(v_trunc, p_start)
      AND o.created_at <  date_trunc(v_trunc, p_end) + (v_interval * (p_periods + 1))
  ),
  joined AS (
    SELECT
      c.cohort_date,
      GREATEST(0, ((l.active_date - c.cohort_date) / v_days_per_period))::int AS period_number,
      l.user_id
    FROM cohorts c
    JOIN logins l ON l.user_id = c.user_id
    WHERE l.active_date >= c.cohort_date
  ),
  per_period AS (
    SELECT j.cohort_date, j.period_number, count(DISTINCT j.user_id)::int AS active_users
    FROM joined j
    WHERE j.period_number <= p_periods
    GROUP BY j.cohort_date, j.period_number
  )
  SELECT
    cs.cohort_date,
    cs.cohort_size,
    pp.period_number,
    pp.active_users
  FROM cohort_sizes cs
  LEFT JOIN per_period pp ON pp.cohort_date = cs.cohort_date
  ORDER BY cs.cohort_date, pp.period_number NULLS FIRST;
END;
$function$;