-- get_tenant_ops_repayment_watchlist was averaging 3.5s (max 7.9s) over 16
-- PostgREST calls and sitting on the authenticated 8s statement_timeout.
--
-- WHY IT IS SLOW
--
-- EXPLAIN (ANALYZE, BUFFERS) of the inner query `t` on 2026-10-27, read-only,
-- warm cache. v_tenant_ops_tenant_base and v_rent_plan_schedule are views
-- (reltuples = -1), so the planner estimates 1 row for the base. It then puts
-- the schedule view on the inner side of a Nested Loop Left Join with a Join
-- Filter on rent_request_id:
--
--   Nested Loop Left Join  (rows=1 estimated, 830 actual)
--     Join Filter: rr_3.id = q.rent_request_id
--     Rows Removed by Join Filter: 1,481,551
--     -> base, after is_active / outstanding / landlord-paid: 830 rows
--     -> Hash Anti Join  (the whole schedule view)  loops=830
--          Index Scan idx_rent_requests_status        loops=830
--
-- That inner side ran 830 times: 3,844 ms, 1,148,904 shared buffer hits
-- (1,089,007 of them on the schedule anti-join). The EXISTS checks on
-- agent_landlord_float_allocations and landlord_payouts are index probes,
-- about 10 ms. They are not the cost.
--
-- THE CHANGE
--
-- Materialize both views once, then hash-join them. Same columns, same
-- filters, plain LEFT JOIN (no DISTINCT). v_rent_plan_schedule currently
-- returns one row per rent_request_id (1,786 rows, 1,786 distinct ids on
-- 2026-10-27). A later duplicate still multiplies `t` the way the old join
-- did.
--
-- Same EXPLAIN (ANALYZE, BUFFERS), same data:
--
--   CTE base    loops=1   961 rows   ~1,061 ms
--   CTE sched   loops=1   1,786 rows    7.7 ms
--   Hash Right Join on rent_request_id
--   Execution Time: 1,081 ms
--   Buffers: shared hit=61,817
--
-- The remaining second is inside v_tenant_ops_tenant_base (the lr ↔ geo
-- nested loop removes about 4.6M rows). This migration does not change that
-- view. get_tenant_ops_geo_metrics shares it and is left for a later pass.
--
-- Parity of the full inner row (agent_id, arrears_amount, advance_amount,
-- term_end, is_weekly, last_pay_date), EXCEPT ALL both ways: 0.
-- count 830, sum(arrears_amount) 254299370.00, sum(advance_amount) 351556.00,
-- count(term_end) 829. Identical.
--
-- Signature, STABLE, SECURITY DEFINER, search_path, v_today, the role guard,
-- CTEs d / tagged / rows_all / agg, and the jsonb keys are unchanged.
-- Live EXECUTE is postgres, authenticated and service_role. CREATE OR REPLACE
-- keeps that ACL. Re-state it, and keep PUBLIC / anon closed.
-- No new indexes and no view changes.
--
-- Apply on byrzshwlentqvktcksem only when this migration is taken on purpose.
-- Do not apply from the branch.

SET lock_timeout = '5s';

DO $pre$
BEGIN
  IF to_regprocedure('public.get_tenant_ops_repayment_watchlist()') IS NULL
     OR (SELECT md5(replace(prosrc, chr(13), ''))
           FROM pg_proc
          WHERE oid = 'public.get_tenant_ops_repayment_watchlist()'::regprocedure)
          IS DISTINCT FROM '9e7c321068b3dbe6d9d0e962da9946ba' THEN
    RAISE EXCEPTION 'precondition failed: get_tenant_ops_repayment_watchlist changed since 2026-10-27; nothing was changed';
  END IF;
END
$pre$;

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
    WITH base AS MATERIALIZED (
      SELECT b.agent_id, b.rent_request_id, b.arrears_amount, b.advance_amount,
             b.last_payment_at, b.funded_date
      FROM public.v_tenant_ops_tenant_base b
      WHERE b.is_active AND b.outstanding > 0
    ),
    sched AS MATERIALIZED (
      SELECT s.rent_request_id, s.term_end FROM public.v_rent_plan_schedule s
    ),
    t AS (
      SELECT
        b.agent_id,
        b.arrears_amount,
        b.advance_amount,
        s.term_end,
        CASE
          WHEN rr.repayment_frequency_locked
            THEN lower(COALESCE(rr.repayment_frequency, 'daily')) = 'weekly'
          ELSE lower(COALESCE(rr.repayment_frequency, 'daily')) = 'weekly'
               OR public.rent_request_is_weekly_shape(rr.duration_days, rr.registration_type)
        END AS is_weekly,
        COALESCE((b.last_payment_at AT TIME ZONE 'Africa/Kampala')::date, b.funded_date) AS last_pay_date
      FROM base b
      JOIN public.rent_requests rr ON rr.id = b.rent_request_id
      LEFT JOIN sched s ON s.rent_request_id = b.rent_request_id
      WHERE
        -- landlord must actually have received the money
        EXISTS (
          SELECT 1 FROM public.agent_landlord_float_allocations a
          WHERE a.rent_request_id = b.rent_request_id
            AND COALESCE(a.paid_out_amount, 0) > 0
        )
        OR EXISTS (
          SELECT 1 FROM public.landlord_payouts lp
          WHERE lp.rent_request_id = b.rent_request_id
            AND (lp.disbursed_at IS NOT NULL OR lp.finops_disbursed_at IS NOT NULL)
        )
    ),
    d AS (
      SELECT t.*,
        CASE WHEN t.last_pay_date IS NOT NULL THEN v_today - t.last_pay_date END AS days_since_pay,
        (t.term_end IS NOT NULL AND t.term_end < v_today) AS is_overdue,
        (t.term_end IS NULL OR t.term_end >= v_today) AS in_term
      FROM t
    ),
    tagged AS (
      SELECT d.*,
        CASE
          WHEN d.is_overdue THEN 'overdue'
          WHEN d.in_term AND NOT d.is_weekly AND d.days_since_pay > 7  THEN 'daily_behind'
          WHEN d.in_term AND d.is_weekly     AND d.days_since_pay > 14 THEN 'weekly_behind'
          ELSE NULL
        END AS bucket
      FROM d
    ),
    rows_all AS (
      SELECT bucket, agent_id, arrears_amount AS amount, days_since_pay, term_end
        FROM tagged WHERE bucket IS NOT NULL
      UNION ALL
      SELECT 'advance'::text, agent_id, advance_amount, days_since_pay, term_end
        FROM tagged WHERE advance_amount > 0
    ),
    agg AS (
      SELECT r.bucket, r.agent_id,
        count(*)::int AS tenants,
        COALESCE(sum(r.amount), 0) AS amount,
        round(AVG(r.days_since_pay)::numeric, 0) AS avg_days_since_pay,
        max(v_today - r.term_end) AS max_days_past_end
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

-- Live EXECUTE is postgres, authenticated and service_role. CREATE OR REPLACE
-- keeps that ACL. Re-state it, and keep PUBLIC / anon closed, so a later edit
-- that drops and recreates the function does not inherit the default anon grant.
REVOKE ALL ON FUNCTION public.get_tenant_ops_repayment_watchlist() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_tenant_ops_repayment_watchlist() FROM anon;
GRANT EXECUTE ON FUNCTION public.get_tenant_ops_repayment_watchlist() TO authenticated, service_role, postgres;
