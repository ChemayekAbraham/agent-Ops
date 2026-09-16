CREATE OR REPLACE FUNCTION public.ops_repayment_trend_daily(p_days int DEFAULT 7)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_today date;
  v_from date;
  v_res jsonb;
BEGIN
  IF NOT (
    public.is_ops_role(auth.uid()) OR public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'cto') OR public.has_role(auth.uid(), 'ceo') OR public.has_role(auth.uid(), 'coo')
    OR public.has_role(auth.uid(), 'cfo') OR public.has_role(auth.uid(), 'operations') OR public.has_role(auth.uid(), 'agent_ops')
  ) THEN RAISE EXCEPTION 'not authorized'; END IF;

  v_today := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_from := v_today - (GREATEST(1, LEAST(COALESCE(p_days, 7), 90)) - 1);

  WITH days AS (
    SELECT d::date AS day FROM generate_series(v_from, v_today, interval '1 day') d
  ),
  bill AS (
    SELECT p.day, p.rent_request_id, sum(p.expected_ugx) AS expected_ugx
    FROM public.agent_expected_day_plans p
    WHERE p.day BETWEEN v_from AND v_today
    GROUP BY p.day, p.rent_request_id
  ),
  cash AS (
    SELECT (ac.created_at AT TIME ZONE 'Africa/Kampala')::date AS day,
           ac.rent_request_id,
           sum(ac.amount) AS paid
    FROM public.agent_collections ac
    WHERE ac.created_at >= (v_from::timestamp AT TIME ZONE 'Africa/Kampala')
      AND ac.created_at < ((v_today + 1)::timestamp AT TIME ZONE 'Africa/Kampala')
      AND ac.amount > 0
      AND ac.reversed_at IS NULL
    GROUP BY 1, 2
  ),
  per_day AS (
    SELECT b.day,
      coalesce(sum(b.expected_ugx), 0) AS expected,
      coalesce(sum(LEAST(coalesce(c.paid, 0), b.expected_ugx)), 0) AS collected
    FROM bill b
    LEFT JOIN cash c ON c.day = b.day AND c.rent_request_id = b.rent_request_id
    GROUP BY b.day
  ),
  total_cash AS (
    SELECT c.day, sum(c.paid) AS total FROM cash c GROUP BY c.day
  )
  SELECT jsonb_build_object(
    'basis', 'pinned_schedule',
    'days', coalesce(jsonb_agg(jsonb_build_object(
      'day', to_char(d.day, 'YYYY-MM-DD'),
      'expected', coalesce(pd.expected, 0),
      'collected', coalesce(pd.collected, 0),
      'collected_total', coalesce(tc.total, 0)
    ) ORDER BY d.day), '[]'::jsonb),
    'generated_at', now()
  )
  INTO v_res
  FROM days d
  LEFT JOIN per_day pd ON pd.day = d.day
  LEFT JOIN total_cash tc ON tc.day = d.day;

  RETURN v_res;
END;
$function$;