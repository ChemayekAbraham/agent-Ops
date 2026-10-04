CREATE OR REPLACE FUNCTION public.get_fee_revenue_summary(p_months integer DEFAULT 6)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result jsonb;
  v_start timestamptz := date_trunc('month', now()) - ((GREATEST(p_months,1) - 1) || ' months')::interval;
BEGIN
  IF NOT (
    has_role(auth.uid(), 'cfo'::app_role)
    OR has_role(auth.uid(), 'ceo'::app_role)
    OR has_role(auth.uid(), 'coo'::app_role)
    OR has_role(auth.uid(), 'manager'::app_role)
    OR has_role(auth.uid(), 'super_admin'::app_role)
  ) THEN
    RAISE EXCEPTION 'Not authorized to view fee revenue summary';
  END IF;

  SELECT jsonb_build_object(
    'row_count', COALESCE((SELECT count(*) FROM fee_revenue_ledger), 0),
    'billed', COALESCE((SELECT sum(total_amount) FROM fee_revenue_ledger), 0),
    'recognized', COALESCE((SELECT sum(recognized_amount) FROM fee_revenue_ledger), 0),
    'deferred', COALESCE((SELECT sum(deferred_amount) FROM fee_revenue_ledger), 0),
    'by_type', COALESCE((
      SELECT jsonb_object_agg(fee_type, agg) FROM (
        SELECT fee_type, jsonb_build_object(
          'billed', sum(total_amount),
          'recognized', sum(recognized_amount),
          'deferred', sum(deferred_amount),
          'count', count(*)
        ) AS agg
        FROM fee_revenue_ledger
        GROUP BY fee_type
      ) t
    ), '{}'::jsonb),
    'monthly', COALESCE((
      SELECT jsonb_agg(m ORDER BY m->>'month_start') FROM (
        SELECT jsonb_build_object(
          'month_start', to_char(date_trunc('month', created_at), 'YYYY-MM-DD'),
          'access', sum(total_amount) FILTER (WHERE fee_type = 'access_fee'),
          'platform', sum(total_amount) FILTER (WHERE fee_type <> 'access_fee'),
          'total', sum(total_amount)
        ) AS m
        FROM fee_revenue_ledger
        WHERE created_at >= v_start
        GROUP BY date_trunc('month', created_at)
      ) mm
    ), '[]'::jsonb)
  ) INTO result;

  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.get_fee_revenue_summary(integer) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.get_fee_revenue_summary(integer) TO authenticated;