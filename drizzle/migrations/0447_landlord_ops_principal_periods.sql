-- Landlord Principal Recovered — period breakdown (today / yesterday / this week /
-- this month / past 7 days). Read-only KPI, same role gate and same population as
-- landlord_ops_principal_recovered(): principal_component only (fees, Returns and
-- agent commission are separate columns; reversed splits excluded; the unique index
-- gives one row per (plan, source) so nothing double counts).
-- Day buckets follow the platform reporting convention: Africa/Kampala (EAT, UTC+3).

CREATE OR REPLACE FUNCTION public.landlord_ops_principal_recovered_periods()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_today_start     timestamptz;
  v_yesterday_start timestamptz;
  v_week_start      timestamptz;
  v_month_start     timestamptz;
  v_7d_start        timestamptz;
  v_scan_floor      timestamptz;
BEGIN
  IF NOT public._has_enabled_role(auth.uid(), ARRAY['landlord_ops','cfo','ceo','coo','manager','financial_ops','super_admin','cto']) THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;

  v_today_start     := date_trunc('day',  now() AT TIME ZONE 'Africa/Kampala') AT TIME ZONE 'Africa/Kampala';
  v_yesterday_start := v_today_start - interval '1 day';
  v_week_start      := date_trunc('week', now() AT TIME ZONE 'Africa/Kampala') AT TIME ZONE 'Africa/Kampala';
  v_month_start     := date_trunc('month',now() AT TIME ZONE 'Africa/Kampala') AT TIME ZONE 'Africa/Kampala';
  v_7d_start        := v_today_start - interval '6 days'; -- today + the 6 days before it
  v_scan_floor      := LEAST(v_7d_start, v_month_start, v_week_start);

  RETURN (
    SELECT jsonb_build_object(
      'today',        COALESCE(SUM(principal_component) FILTER (WHERE instalment_date >= v_today_start), 0),
      'yesterday',    COALESCE(SUM(principal_component) FILTER (WHERE instalment_date >= v_yesterday_start AND instalment_date < v_today_start), 0),
      'this_week',    COALESCE(SUM(principal_component) FILTER (WHERE instalment_date >= v_week_start), 0),
      'this_month',   COALESCE(SUM(principal_component) FILTER (WHERE instalment_date >= v_month_start), 0),
      'past_7_days',  COALESCE(SUM(principal_component) FILTER (WHERE instalment_date >= v_7d_start), 0)
    )
    FROM public.instalment_allocations
    WHERE reversed_at IS NULL
      AND instalment_date >= v_scan_floor
  );
END
$function$;

REVOKE ALL ON FUNCTION public.landlord_ops_principal_recovered_periods() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.landlord_ops_principal_recovered_periods() TO authenticated;
