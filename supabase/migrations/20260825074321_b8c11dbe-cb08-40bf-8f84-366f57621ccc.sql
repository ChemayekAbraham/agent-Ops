CREATE OR REPLACE FUNCTION public.get_cfo_daily_cash_flow(p_days integer DEFAULT 7)
RETURNS TABLE(day date, inflow numeric, outflow numeric)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_days integer := greatest(1, least(coalesce(p_days, 7), 90));
  v_end date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_start date := ((now() AT TIME ZONE 'Africa/Kampala')::date - (v_days - 1));
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'cfo') OR public.has_role(auth.uid(), 'ceo')
    OR public.has_role(auth.uid(), 'coo') OR public.has_role(auth.uid(), 'manager')
    OR public.has_role(auth.uid(), 'financial_ops') OR public.has_role(auth.uid(), 'super_admin')
  ) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  RETURN QUERY
  WITH days AS (
    SELECT generate_series(v_start, v_end, interval '1 day')::date AS d
  ),
  legs AS (
    SELECT ((gl.transaction_date AT TIME ZONE 'Africa/Kampala')::date) AS d,
           gl.direction,
           gl.amount
    FROM public.general_ledger gl
    WHERE gl.classification IN ('production', 'legacy_real')
      AND gl.transaction_date >= (v_start::timestamp AT TIME ZONE 'Africa/Kampala')
      AND gl.transaction_date < ((v_end + 1)::timestamp AT TIME ZONE 'Africa/Kampala')
  )
  SELECT dd.d,
         COALESCE(SUM(CASE WHEN l.direction = 'cash_in' THEN l.amount END), 0)::numeric,
         COALESCE(SUM(CASE WHEN l.direction = 'cash_out' THEN l.amount END), 0)::numeric
  FROM days dd
  LEFT JOIN legs l ON l.d = dd.d
  GROUP BY dd.d
  ORDER BY dd.d;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_cfo_daily_cash_flow(integer) TO authenticated;