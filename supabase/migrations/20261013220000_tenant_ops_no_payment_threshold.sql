-- Tenant Ops: a staff-selectable "days without payment" threshold (was fixed at 20).
--
-- Read-only. New functions only. Nothing existing is edited: not get_tenant_ops_no_payment_report, not
-- _tenant_ops_weekly_amclock_plans / _tenant_ops_weekly_metrics_raw_amclock / the pin and catch-up jobs, not the
-- frozen tables tenant_ops_weekly_metrics and tenant_ops_weekly_metrics_amclock (their "20+ days" column stays fixed
-- at 20 for ever and past weeks are never rebuilt), not am_plan_clock, and no payment or repayment calculation.
--
--   1. get_tenant_ops_no_payment_report_v2(p_min_days, p_agent_id): the 20+ Days No Payment report with the
--      threshold as a parameter (1 to 365). The bands above it follow the threshold (N+, N+10, N+20). With
--      p_min_days = 20 it returns exactly what get_tenant_ops_no_payment_report returns (the tenants, the
--      counts and the agent breakdown; the bands are N+/N+10/N+20 = 20+/30+/40+).
--   2. _tenant_ops_dormant_days_amclock / get_tenant_ops_dormant_amclock(p_min_days): the same question on the shared
--      payout clock, for the Weekly Performance page. The counting rule is the one the weekly figure uses
--      (a plan counts only from its am_plan_clock start; days are counted from the later of the last payment and the
--      clock start; plans whose landlord is not paid are never counted). With p_min_days = 20 it equals the open
--      week's live "20+ days" figure plan for plan. It is calculated now, not frozen.
--
-- "Today" is the Kampala date. Access is the same staff gate as the report each one mirrors; anon has no access.

-- 1. The report with a threshold --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_tenant_ops_no_payment_report_v2(
  p_min_days integer DEFAULT 20,
  p_agent_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
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

  IF p_min_days IS NULL OR p_min_days < 1 OR p_min_days > 365 THEN
    RAISE EXCEPTION 'p_min_days must be between 1 and 365' USING ERRCODE = '22023';
  END IF;

  RETURN (
    WITH watch AS (
      SELECT
        b.tenant_id,
        b.rent_request_id,
        COALESCE(rr.assigned_agent_id, rr.agent_id) AS agent_id,
        b.rent_amount,
        b.total_repayment,
        b.amount_repaid,
        b.daily_repayment,
        rr.status AS plan_status,
        COALESCE(s.last_pay_date, b.funded_date) AS last_pay_date
      FROM public.v_tenant_ops_tenant_base b
      JOIN public.rent_requests rr ON rr.id = b.rent_request_id
      LEFT JOIN public.v_rent_plan_schedule s ON s.rent_request_id = b.rent_request_id
      WHERE b.is_active AND b.outstanding > 0
        AND (
          EXISTS (
            SELECT 1 FROM public.agent_landlord_float_allocations a
             WHERE a.rent_request_id = b.rent_request_id AND COALESCE(a.paid_out_amount, 0) > 0
          )
          OR EXISTS (
            SELECT 1 FROM public.landlord_payouts lp
             WHERE lp.rent_request_id = b.rent_request_id
               AND (lp.disbursed_at IS NOT NULL OR lp.finops_disbursed_at IS NOT NULL)
          )
        )
    ),
    dormant AS (
      SELECT w.*, (v_today - w.last_pay_date) AS days_since_last_payment
        FROM watch w
       WHERE w.last_pay_date IS NOT NULL
         AND (v_today - w.last_pay_date) >= p_min_days
    ),
    rows_out AS (
      SELECT
        d.tenant_id,
        p.full_name AS tenant_name,
        p.phone AS tenant_account_number,
        d.agent_id,
        COALESCE(NULLIF(TRIM(ap.full_name), ''), 'Unassigned') AS agent_name,
        d.last_pay_date AS date_of_last_payment,
        d.days_since_last_payment,
        d.daily_repayment AS expected_daily_payment,
        GREATEST(d.total_repayment - d.amount_repaid, 0) AS outstanding_balance,
        d.amount_repaid AS total_amount_paid,
        CASE WHEN d.total_repayment > 0
          THEN round(d.amount_repaid / d.total_repayment * 100, 1)
          ELSE 0 END AS progress_pct,
        d.plan_status AS tenant_status
      FROM dormant d
      LEFT JOIN public.profiles p ON p.id = d.tenant_id
      LEFT JOIN public.profiles ap ON ap.id = d.agent_id
      WHERE p_agent_id IS NULL OR d.agent_id = p_agent_id
      ORDER BY d.days_since_last_payment DESC, d.tenant_id
    ),
    agent_agg AS (
      SELECT
        d.agent_id,
        COALESCE(NULLIF(TRIM(ap.full_name), ''), 'Unassigned') AS label,
        count(*) FILTER (WHERE d.days_since_last_payment >= p_min_days)::int       AS gte_min,
        count(*) FILTER (WHERE d.days_since_last_payment >= p_min_days + 10)::int  AS gte_min_10,
        count(*) FILTER (WHERE d.days_since_last_payment >= p_min_days + 20)::int  AS gte_min_20
      FROM dormant d
      LEFT JOIN public.profiles ap ON ap.id = d.agent_id
      GROUP BY d.agent_id, ap.full_name
    )
    SELECT jsonb_build_object(
      'as_of', v_today,
      'min_days', p_min_days,
      'tenants', COALESCE((SELECT jsonb_agg(to_jsonb(rows_out)) FROM rows_out), '[]'::jsonb),
      'total_min_days', (SELECT count(*) FROM dormant WHERE p_agent_id IS NULL OR agent_id = p_agent_id),
      -- The agent breakdown always covers every agent, whatever p_agent_id is, as in the original.
      'agent_summary', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'agent_id', a.agent_id,
          'label', a.label,
          'gte_min', a.gte_min,
          'gte_min_10', a.gte_min_10,
          'gte_min_20', a.gte_min_20
        ) ORDER BY a.gte_min DESC, a.label)
        FROM agent_agg a
      ), '[]'::jsonb)
    )
  );
END;
$function$;

-- 2. The same question on the shared payout clock -------------------------------------------------------------
-- One row per live plan of an active tenant. days_since is set only where the weekly figure would count the plan:
-- counted by the payout clock (counting / outstanding_balance, started on or before today) and still owing.
CREATE OR REPLACE FUNCTION public._tenant_ops_dormant_days_amclock()
RETURNS TABLE (
  tenant_id       uuid,
  rent_request_id uuid,
  agent_id        uuid,
  bucket          text,
  clock_start     date,
  last_pay_day    date,
  counted         boolean,
  days_since      integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
  WITH today AS (
    SELECT (now() AT TIME ZONE 'Africa/Kampala')::date AS d
  ),
  live AS (
    SELECT b.tenant_id, b.rent_request_id, b.outstanding
      FROM public.v_tenant_ops_tenant_base b
     WHERE b.is_active AND b.rent_request_id IS NOT NULL
  ),
  clk AS (
    SELECT * FROM public._am_plan_clock_core(ARRAY(SELECT l.rent_request_id FROM live l))
  ),
  pay AS (
    SELECT x.rid, max(x.day) AS d
      FROM (
        SELECT ac.rent_request_id AS rid, (ac.created_at AT TIME ZONE 'Africa/Kampala')::date AS day
          FROM public.agent_collections ac
         WHERE ac.reversed_at IS NULL
           AND ac.rent_request_id IN (SELECT l.rent_request_id FROM live l)
        UNION ALL
        SELECT rp.rent_request_id, (rp.created_at AT TIME ZONE 'Africa/Kampala')::date
          FROM public.repayments rp
         WHERE rp.rent_request_id IN (SELECT l.rent_request_id FROM live l)
      ) x
     GROUP BY x.rid
  )
  SELECT l.tenant_id,
         l.rent_request_id,
         COALESCE(rr.assigned_agent_id, rr.agent_id),
         c.bucket,
         c.clock_start,
         py.d,
         (c.bucket IN ('counting', 'outstanding_balance') AND c.clock_start IS NOT NULL
            AND c.clock_start <= t.d AND l.outstanding > 0) AS counted,
         CASE WHEN c.bucket IN ('counting', 'outstanding_balance') AND c.clock_start IS NOT NULL
                   AND c.clock_start <= t.d AND l.outstanding > 0
              THEN t.d - GREATEST(c.clock_start, COALESCE(py.d, c.clock_start)) END
    FROM live l
    CROSS JOIN today t
    JOIN public.rent_requests rr ON rr.id = l.rent_request_id
    JOIN clk c ON c.rent_request_id = l.rent_request_id
    LEFT JOIN pay py ON py.rid = l.rent_request_id;
$function$;

CREATE OR REPLACE FUNCTION public.get_tenant_ops_dormant_amclock(p_min_days integer DEFAULT 20)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_out jsonb;
BEGIN
  IF NOT (
    public.is_ops_role(auth.uid())
    OR public.has_role(auth.uid(), 'manager')
    OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'cto')
    OR public.has_role(auth.uid(), 'ceo')
    OR public.has_role(auth.uid(), 'coo')
  ) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  IF p_min_days IS NULL OR p_min_days < 1 OR p_min_days > 365 THEN
    RAISE EXCEPTION 'p_min_days must be between 1 and 365' USING ERRCODE = '22023';
  END IF;

  SELECT jsonb_build_object(
    'as_of', v_today,
    'min_days', p_min_days,
    'count', count(*) FILTER (WHERE d.days_since >= p_min_days),
    'count_plus_10', count(*) FILTER (WHERE d.days_since >= p_min_days + 10),
    'count_plus_20', count(*) FILTER (WHERE d.days_since >= p_min_days + 20),
    'counted_plans', count(*) FILTER (WHERE d.counted),
    'landlord_not_paid_count', count(*) FILTER (WHERE d.bucket IN ('tenant_paying_no_landlord', 'awaiting_landlord'))
  ) INTO v_out
  FROM public._tenant_ops_dormant_days_amclock() d;

  RETURN v_out;
END;
$function$;

-- 3. Grants: the helper is internal; the two reports as their peers, never anon.
REVOKE ALL ON FUNCTION public._tenant_ops_dormant_days_amclock() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_tenant_ops_no_payment_report_v2(integer, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_tenant_ops_dormant_amclock(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_tenant_ops_no_payment_report_v2(integer, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_tenant_ops_dormant_amclock(integer) TO authenticated, service_role;
