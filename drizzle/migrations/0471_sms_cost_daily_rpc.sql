-- get_sms_cost_daily: daily SMS spend rollup for the CTO SMS dashboard.
-- sms_delivery_log.cost is a provider-reported string ("UGX 90", "UGX 50.0000",
-- bare "0", or foreign "KES 1.6000"/"TZS 22.0000"/"USD 0.0300"). Only
-- UGX-denominated (or bare-numeric) rows are summed; foreign-currency rows are
-- counted separately so no exchange rate is ever invented.
CREATE OR REPLACE FUNCTION public.get_sms_cost_daily(p_days integer DEFAULT 90)
RETURNS TABLE(day date, cost_ugx numeric, msgs_costed bigint, msgs_uncosted bigint, msgs_foreign bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT
    date_trunc('day', created_at)::date AS day,
    COALESCE(SUM(
      CASE
        WHEN cost IS NULL THEN NULL
        WHEN cost ~ '^[0-9]' THEN regexp_replace(trim(cost), '[^0-9.]', '', 'g')::numeric
        WHEN upper(split_part(trim(cost), ' ', 1)) = 'UGX'
          THEN nullif(regexp_replace(trim(cost), '[^0-9.]', '', 'g'), '')::numeric
        ELSE NULL
      END
    ), 0) AS cost_ugx,
    count(*) FILTER (WHERE cost IS NOT NULL AND (
      (cost ~ '^[0-9]') OR upper(split_part(trim(cost), ' ', 1)) = 'UGX'
    )) AS msgs_costed,
    count(*) FILTER (WHERE cost IS NULL) AS msgs_uncosted,
    count(*) FILTER (WHERE cost IS NOT NULL AND cost !~ '^[0-9]' AND upper(split_part(trim(cost), ' ', 1)) <> 'UGX') AS msgs_foreign
  FROM public.sms_delivery_log
  WHERE created_at >= (date_trunc('day', now()) - make_interval(days => greatest(p_days, 1) - 1))
  GROUP BY 1
  ORDER BY 1;
$function$;

GRANT EXECUTE ON FUNCTION public.get_sms_cost_daily(integer) TO PUBLIC;
