CREATE OR REPLACE FUNCTION public.get_tenant_ops_repayment_watchlist()
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
BEGIN
  IF NOT (
    public.is_ops_role(auth.uid())
    OR public.has_role(auth.uid(), 'manager')
    OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'cto')
    OR public.has_role(auth.uid(), 'ceo')
    OR public.has_role(auth.uid(), 'coo')
    OR public.has_role(auth.uid(), 'cfo')
  ) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  RETURN (
    WITH t AS (
      SELECT
        b.tenant_id,
        b.agent_id,
        b.arrears_amount,
        b.advance_amount,
        b.outstanding,
        b.daily_repayment,
        b.lease_end_date,
        rr.repayment_frequency,
        COALESCE((b.last_payment_at AT TIME ZONE 'Africa/Kampala')::date, b.funded_date) AS last_pay_date
      FROM public.v_tenant_ops_tenant_base b
      JOIN public.rent_requests rr ON rr.id = b.rent_request_id
      WHERE b.is_active AND b.outstanding > 0
    ),
    d AS (
      SELECT t.*,
        CASE WHEN t.last_pay_date IS NOT NULL THEN v_today - t.last_pay_date END AS days_since_pay,
        (t.lease_end_date IS NOT NULL AND t.lease_end_date < v_today) AS is_overdue
      FROM t
    ),
    tagged AS (
      SELECT d.*,
        CASE
          WHEN d.is_overdue THEN 'overdue'
          WHEN d.repayment_frequency = 'daily'  AND d.days_since_pay > 7  THEN 'daily_behind'
          WHEN d.repayment_frequency = 'weekly' AND d.days_since_pay > 14 THEN 'weekly_behind'
          ELSE NULL
        END AS bucket
      FROM d
    ),
    rows_all AS (
      SELECT bucket, agent_id, arrears_amount AS amount, days_since_pay, lease_end_date FROM tagged WHERE bucket IS NOT NULL
      UNION ALL
      SELECT 'advance'::text, agent_id, advance_amount, days_since_pay, lease_end_date FROM tagged WHERE advance_amount > 0
    ),
    agg AS (
      SELECT r.bucket, r.agent_id,
        count(*)::int AS tenants,
        COALESCE(sum(r.amount), 0) AS amount,
        round(AVG(r.days_since_pay)::numeric, 0) AS avg_days_since_pay,
        max(v_today - r.lease_end_date) AS max_days_past_end
      FROM rows_all r
      GROUP BY 1, 2
    )
    SELECT jsonb_build_object(
      'as_of', v_today,
      'buckets', COALESCE((
        SELECT jsonb_object_agg(x.bucket, x.payload)
        FROM (
          SELECT a.bucket,
            jsonb_build_object(
              'tenants', sum(a.tenants),
              'amount', sum(a.amount),
              'agents', COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                  'agent_id', a2.agent_id,
                  'label', COALESCE(NULLIF(TRIM(pr.full_name), ''), 'Unassigned'),
                  'tenants', a2.tenants,
                  'amount', a2.amount,
                  'avg_days_since_pay', a2.avg_days_since_pay,
                  'max_days_past_end', a2.max_days_past_end
                ) ORDER BY a2.tenants DESC, a2.amount DESC)
                FROM agg a2
                LEFT JOIN public.profiles pr ON pr.id = a2.agent_id
                WHERE a2.bucket = a.bucket
              ), '[]'::jsonb)
            ) AS payload
          FROM agg a
          GROUP BY a.bucket
        ) x
      ), '{}'::jsonb)
    )
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_tenant_ops_repayment_watchlist() TO authenticated;