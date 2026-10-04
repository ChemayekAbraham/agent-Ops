CREATE OR REPLACE FUNCTION public.get_sms_traffic_daily(p_days integer DEFAULT 90)
RETURNS TABLE (
  day date,
  total bigint,
  delivered bigint,
  failed bigint,
  yoola bigint,
  africastalking bigint,
  other bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    date_trunc('day', created_at)::date AS day,
    count(*) AS total,
    count(*) FILTER (WHERE lower(status) IN ('sent','success','delivered','accepted')) AS delivered,
    count(*) FILTER (WHERE lower(status) NOT IN ('sent','success','delivered','accepted')) AS failed,
    count(*) FILTER (WHERE lower(provider) = 'yoola') AS yoola,
    count(*) FILTER (WHERE lower(provider) LIKE '%africa%') AS africastalking,
    count(*) FILTER (WHERE lower(provider) <> 'yoola' AND lower(provider) NOT LIKE '%africa%') AS other
  FROM public.sms_delivery_log
  WHERE created_at >= (date_trunc('day', now()) - make_interval(days => greatest(p_days, 1) - 1))
  GROUP BY 1
  ORDER BY 1;
$$;

GRANT EXECUTE ON FUNCTION public.get_sms_traffic_daily(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_sms_traffic_daily(integer) TO service_role;