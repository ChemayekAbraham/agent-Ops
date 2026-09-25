-- Tenant Ops "20+ DAYS NO PAYMENT" tab.
--
-- Reuses, does not reinvent:
--   * v_rent_plan_schedule's own internal last-payment CTE (agent_collections
--     UNION repayments) -- it already computes this correctly, it just never
--     exposed it as an output column. Adding it here, purely additive: every
--     existing column keeps its name, type and position; last_pay_date is
--     appended at the end. Deliberately NOT v_tenant_ops_tenant_base.last_payment_at,
--     which is agent_collections-only and misses tenant self-payments recorded
--     straight into repayments (confirmed still the case against production
--     on 2026-09-25).
--   * The same "live plan, landlord actually paid" eligibility gate
--     get_tenant_ops_repayment_watchlist() already uses (is_active, outstanding
--     > 0, landlord payout evidence) -- so this tab and the existing watchlist
--     agree on which tenants are even in scope, and neither invents a
--     different definition of "at risk" from the other.
--   * COALESCE(assigned_agent_id, agent_id) for "agent responsible" -- the
--     precedence already used by activeTenantsReportPdf.ts and
--     partner_ops_list_rent_requests().
--   * The bucket/per-agent JSON aggregation shape already returned by
--     get_tenant_ops_repayment_watchlist() (drizzle/migrations/0218_...sql) --
--     same {tenants, agents:[{agent_id,label,tenants,...}]} structure, just
--     three cumulative day-thresholds (20+/30+/40+) instead of behind-schedule
--     buckets.
--
-- No dedicated "tenant account number" column exists anywhere in this schema
-- (only landlords/investors have an account_number, and it's a bank account).
-- The tenant's phone number is used as the account/reference number shown in
-- this tab, since it is already the de facto unique tenant identifier used
-- throughout Calling Center and CRM.

CREATE OR REPLACE VIEW public.v_rent_plan_schedule AS
WITH pay AS (
  SELECT x.rent_request_id,
         max((x.created_at AT TIME ZONE 'Africa/Kampala'::text)::date) AS last_pay_date
    FROM ( SELECT agent_collections.rent_request_id, agent_collections.created_at
             FROM agent_collections
            WHERE agent_collections.rent_request_id IS NOT NULL
           UNION ALL
           SELECT repayments.rent_request_id, repayments.created_at
             FROM repayments
            WHERE repayments.rent_request_id IS NOT NULL) x
   GROUP BY x.rent_request_id
), landlord_evidence AS (
  SELECT a.rent_request_id,
         count(*) FILTER (WHERE a.status = 'open'::text) AS open_allocs,
         COALESCE(sum(a.paid_out_amount), 0::numeric) AS paid_out
    FROM agent_landlord_float_allocations a
   WHERE a.rent_request_id IS NOT NULL
   GROUP BY a.rent_request_id
)
SELECT rr.id AS rent_request_id,
       rr.agent_id,
       rr.tenant_id,
       COALESCE(rr.daily_repayment, 0::numeric) AS daily_amount,
       COALESCE(rr.total_repayment, 0::numeric) AS total_amount,
       COALESCE(rr.amount_repaid, 0::numeric) AS amount_repaid,
       s.term_start,
       s.term_end,
       COALESCE(rr.duration_days, 0) AS term_days,
       o.obligation_end,
       (o.obligation_end - s.term_start) + 1 AS oblig_days,
       (rr.status = ANY (ARRAY['funded'::text, 'repaying'::text]))
         AND (COALESCE(rr.total_repayment, 0::numeric) - COALESCE(rr.amount_repaid, 0::numeric)) > 0::numeric AS is_live,
       pay.last_pay_date
  FROM rent_requests rr
  LEFT JOIN pay ON pay.rent_request_id = rr.id
  LEFT JOIN landlord_evidence le ON le.rent_request_id = rr.id
  CROSS JOIN LATERAL (
    SELECT COALESCE(rr.repayment_starts_on,
                     (COALESCE(rr.funded_at, rr.disbursed_at, rr.created_at) AT TIME ZONE 'Africa/Kampala'::text)::date) AS term_start,
           (COALESCE(rr.repayment_starts_on,
                     (COALESCE(rr.funded_at, rr.disbursed_at, rr.created_at) AT TIME ZONE 'Africa/Kampala'::text)::date)
             + COALESCE(rr.duration_days, 0)) - 1 AS term_end
  ) s
  CROSS JOIN LATERAL (
    SELECT CASE
             WHEN (COALESCE(rr.total_repayment, 0::numeric) - COALESCE(rr.amount_repaid, 0::numeric)) > 0::numeric
               THEN s.term_end
             ELSE LEAST(s.term_end, COALESCE(pay.last_pay_date, s.term_start - 1))
           END AS obligation_end
  ) o
 WHERE s.term_start IS NOT NULL
   AND rr.status = ANY (ARRAY['funded'::text, 'repaying'::text, 'completed'::text])
   AND COALESCE(rr.agent_payment_status, 'paying'::text) <> 'not_paying'::text
   AND rr.tenancy_status = 'active'::text
   AND rr.tenancy_ended_at IS NULL
   AND COALESCE(rr.duration_days, 0) > 0
   AND NOT EXISTS (
     SELECT 1 FROM rent_repayment_pauses pz
      WHERE pz.rent_request_id = rr.id AND pz.status = 'active'::text AND pz.resumed_at IS NULL
   )
   AND (
     rr.status = 'repaying'::text
     OR COALESCE(rr.amount_repaid, 0::numeric) > 0::numeric
     OR le.rent_request_id IS NULL
     OR le.paid_out > 0::numeric
     OR COALESCE(le.open_allocs, 0::bigint) = 0
   );

COMMENT ON VIEW public.v_rent_plan_schedule IS
'Live rent-plan schedule (term dates, obligation end, is_live), gated on landlord disbursement evidence. last_pay_date (added 2026-09-25, additive) is the max day across agent_collections UNION repayments for the plan -- the one authoritative "last payment" figure that does not miss tenant self-payments recorded straight into repayments.';

-- Per-tenant list + per-agent 20+/30+/40+ cumulative counts, in one call.
CREATE OR REPLACE FUNCTION public.get_tenant_ops_no_payment_report(p_agent_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
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
    WITH watch AS (
      -- Same eligibility gate as get_tenant_ops_repayment_watchlist(): a live,
      -- still-owing plan whose landlord has actually been paid.
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
         AND (v_today - w.last_pay_date) >= 20
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
      ORDER BY d.days_since_last_payment DESC
    ),
    agent_agg AS (
      SELECT
        d.agent_id,
        COALESCE(NULLIF(TRIM(ap.full_name), ''), 'Unassigned') AS label,
        count(*) FILTER (WHERE d.days_since_last_payment >= 20)::int AS gte_20,
        count(*) FILTER (WHERE d.days_since_last_payment >= 30)::int AS gte_30,
        count(*) FILTER (WHERE d.days_since_last_payment >= 40)::int AS gte_40
      FROM dormant d
      LEFT JOIN public.profiles ap ON ap.id = d.agent_id
      GROUP BY d.agent_id, ap.full_name
    )
    SELECT jsonb_build_object(
      'as_of', v_today,
      'tenants', COALESCE((SELECT jsonb_agg(to_jsonb(rows_out)) FROM rows_out), '[]'::jsonb),
      'total_20_plus', (SELECT count(*) FROM dormant WHERE p_agent_id IS NULL OR agent_id = p_agent_id),
      -- Agent breakdown always covers every agent, regardless of p_agent_id,
      -- so the agent filter/picker in the UI can show full counts.
      'agent_summary', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'agent_id', a.agent_id,
          'label', a.label,
          'gte_20', a.gte_20,
          'gte_30', a.gte_30,
          'gte_40', a.gte_40
        ) ORDER BY a.gte_20 DESC, a.label)
        FROM agent_agg a
      ), '[]'::jsonb)
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_tenant_ops_no_payment_report(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_tenant_ops_no_payment_report(uuid) TO authenticated;
