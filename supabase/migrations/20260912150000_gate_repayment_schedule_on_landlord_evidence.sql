-- A tenant's daily repayment obligation must not start (or display as owing)
-- before the landlord has actually been paid — or before the tenant has
-- already repaid something, or before there's no open landlord-float
-- allocation blocking settlement at all. This mirrors the canonical rule in
-- src/lib/collectibleRentRequests.ts (hasDisbursementEvidence), already used
-- by v_agent_daily_eligibility and PriorityCollectionQueue, but was missing
-- from v_rent_plan_schedule (which drives pin_agent_expected_day / the daily
-- bill) and get_agent_tenants_overview (the agent's tenant list "OWING"
-- figure). See docs/TENANT_OWING_AND_FUNDING_TRUTH.md known gap #2.
--
-- Concrete incident: rent_request 26b48fa4-3562-47e5-a157-06a6acb875f4
-- (tenant Faizal Kayondo) had its landlord payout rejected twice by the
-- merchant (2026-09-11) and never settled, yet a daily bill of UGX 11,750
-- was pinned for 2026-09-12 and the agent's tenant list showed him as
-- "REPAYING / OWING UGX 352,500". That row was corrected manually; this
-- migration prevents the same thing from recurring for any plan.
--
-- This only ever narrows what counts as due/owing (adds an AND condition),
-- it never widens it, so no plan that was correctly live before this change
-- stops being live.

CREATE OR REPLACE VIEW public.v_rent_plan_schedule AS
WITH pay AS (
  SELECT x.rent_request_id,
         max((x.created_at AT TIME ZONE 'Africa/Kampala')::date) AS last_pay_date
  FROM (
    SELECT agent_collections.rent_request_id, agent_collections.created_at
    FROM agent_collections
    WHERE agent_collections.rent_request_id IS NOT NULL
    UNION ALL
    SELECT repayments.rent_request_id, repayments.created_at
    FROM repayments
    WHERE repayments.rent_request_id IS NOT NULL
  ) x
  GROUP BY x.rent_request_id
),
landlord_evidence AS (
  SELECT a.rent_request_id,
         count(*) FILTER (WHERE a.status = 'open') AS open_allocs,
         COALESCE(sum(a.paid_out_amount), 0) AS paid_out
  FROM public.agent_landlord_float_allocations a
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
       o.obligation_end - s.term_start + 1 AS oblig_days,
       (rr.status = ANY (ARRAY['funded'::text, 'repaying'::text]))
         AND (COALESCE(rr.total_repayment, 0::numeric) - COALESCE(rr.amount_repaid, 0::numeric)) > 0::numeric AS is_live
FROM rent_requests rr
LEFT JOIN pay ON pay.rent_request_id = rr.id
LEFT JOIN landlord_evidence le ON le.rent_request_id = rr.id
CROSS JOIN LATERAL (
  SELECT COALESCE(rr.repayment_starts_on, (COALESCE(rr.funded_at, rr.disbursed_at, rr.created_at) AT TIME ZONE 'Africa/Kampala')::date) AS term_start,
         COALESCE(rr.repayment_starts_on, (COALESCE(rr.funded_at, rr.disbursed_at, rr.created_at) AT TIME ZONE 'Africa/Kampala')::date) + COALESCE(rr.duration_days, 0) - 1 AS term_end
) s
CROSS JOIN LATERAL (
  SELECT CASE
           WHEN (COALESCE(rr.total_repayment, 0::numeric) - COALESCE(rr.amount_repaid, 0::numeric)) > 0::numeric THEN s.term_end
           ELSE LEAST(s.term_end, COALESCE(pay.last_pay_date, s.term_start - 1))
         END AS obligation_end
) o
WHERE s.term_start IS NOT NULL
  AND (rr.status = ANY (ARRAY['funded'::text, 'repaying'::text, 'completed'::text]))
  AND COALESCE(rr.agent_payment_status, 'paying'::text) <> 'not_paying'::text
  AND rr.tenancy_status = 'active'::text
  AND rr.tenancy_ended_at IS NULL
  AND COALESCE(rr.duration_days, 0) > 0
  AND NOT (EXISTS (
    SELECT 1 FROM rent_repayment_pauses pz
    WHERE pz.rent_request_id = rr.id AND pz.status = 'active'::text AND pz.resumed_at IS NULL
  ))
  -- Landlord disbursement evidence: the tenant already repaid something, OR
  -- there are no landlord-float allocation rows at all, OR the landlord has
  -- actually been paid (paid_out > 0), OR there is no OPEN allocation left
  -- blocking settlement. Only an open allocation with paid_out = 0 and
  -- nothing repaid yet fails this and is excluded.
  AND (
    COALESCE(rr.amount_repaid, 0::numeric) > 0::numeric
    OR le.rent_request_id IS NULL
    OR le.paid_out > 0::numeric
    OR COALESCE(le.open_allocs, 0) = 0
  );

COMMENT ON VIEW public.v_rent_plan_schedule IS
  'Live rent plan schedule, gated on landlord disbursement evidence (see hasDisbursementEvidence in src/lib/collectibleRentRequests.ts). A plan with an open, unpaid landlord-float allocation and no repayment yet does not generate schedule days / daily bills.';

-- Same evidence gate on the agent tenant list "OWING" figure. Only balance,
-- daily and repaying_balance are gated (the amounts that create collection
-- pressure); total_repayment/amount_repaid/statuses stay as-is since they
-- describe the contract, not a call to action.
CREATE OR REPLACE FUNCTION public.get_agent_tenants_overview(p_today_start timestamp with time zone DEFAULT date_trunc('day'::text, now()))
 RETURNS TABLE(id uuid, full_name text, phone text, email text, created_at timestamp with time zone, monthly_rent numeric, verified boolean, balance numeric, daily numeric, total_repayment numeric, amount_repaid numeric, statuses text[], landlord_name text, property_address text, latitude numeric, longitude numeric, completed_count integer, request_count integer, last_paid_at timestamp with time zone, last_paid_amount numeric, today_paid_amount numeric, today_paid_count integer, repaying_balance numeric, payment_states text[], latest_status text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH actor AS (
    SELECT auth.uid() AS uid
  ),
  linked_ids AS (
    SELECT rr.tenant_id AS id
    FROM public.rent_requests rr, actor a
    WHERE a.uid IS NOT NULL
      AND rr.tenant_id IS NOT NULL
      AND (rr.agent_id = a.uid OR rr.assigned_agent_id = a.uid)

    UNION

    SELECT ac.tenant_id AS id
    FROM public.agent_collections ac, actor a
    WHERE a.uid IS NOT NULL
      AND ac.tenant_id IS NOT NULL
      AND ac.agent_id = a.uid
  ),
  tenants AS (
    SELECT DISTINCT p.id, p.full_name, p.phone, p.email, p.created_at, p.monthly_rent, p.verified
    FROM public.profiles p
    JOIN linked_ids li ON li.id = p.id
  ),
  landlord_evidence AS (
    SELECT a.rent_request_id,
           count(*) FILTER (WHERE a.status = 'open') AS open_allocs,
           COALESCE(sum(a.paid_out_amount), 0) AS paid_out
    FROM public.agent_landlord_float_allocations a
    WHERE a.rent_request_id IS NOT NULL
    GROUP BY a.rent_request_id
  ),
  request_base AS (
    SELECT
      rr.id AS rent_request_id,
      rr.tenant_id,
      rr.status,
      COALESCE(rr.agent_payment_status, 'paying') AS agent_payment_status,
      rr.created_at,
      rr.registration_type,
      rr.amount_repaid,
      rr.duration_days,
      l.name AS landlord_name,
      l.property_address,
      l.latitude,
      l.longitude,
      CASE
        WHEN rr.registration_type = 'outstanding_balance' THEN
          COALESCE(NULLIF(rr.initial_outstanding_balance, 0), rr.total_repayment, 0)
        ELSE COALESCE(rr.total_repayment, 0)
      END AS effective_total,
      CASE
        WHEN rr.registration_type = 'outstanding_balance' THEN
          CASE
            WHEN COALESCE(NULLIF(rr.initial_outstanding_balance, 0), rr.total_repayment, 0) > 0 THEN
              CEIL(COALESCE(NULLIF(rr.initial_outstanding_balance, 0), rr.total_repayment, 0) / GREATEST(COALESCE(rr.duration_days, 30), 1))
            ELSE COALESCE(rr.daily_repayment, 0)
          END
        ELSE COALESCE(rr.daily_repayment, 0)
      END AS effective_daily,
      -- Landlord disbursement evidence, same rule as v_rent_plan_schedule /
      -- v_agent_daily_eligibility / collectibleRentRequests.hasDisbursementEvidence.
      (
        COALESCE(rr.amount_repaid, 0) > 0
        OR le.rent_request_id IS NULL
        OR le.paid_out > 0
        OR COALESCE(le.open_allocs, 0) = 0
      ) AS has_disbursement_evidence
    FROM public.rent_requests rr
    JOIN tenants t ON t.id = rr.tenant_id
    CROSS JOIN actor a
    LEFT JOIN public.landlords l ON l.id = rr.landlord_id
    LEFT JOIN landlord_evidence le ON le.rent_request_id = rr.id
    WHERE (rr.agent_id = a.uid OR rr.assigned_agent_id = a.uid)
      AND rr.status IN ('pending', 'service_center_review', 'agent_verified', 'agent_ops_approved', 'tenant_ops_approved', 'landlord_ops_approved', 'partner_ops_approved', 'coo_approved', 'approved', 'funded', 'disbursed', 'repaying', 'completed')
  ),
  request_agg AS (
    SELECT
      rb.tenant_id,
      COALESCE(SUM(
        CASE
          WHEN rb.status IN ('funded', 'disbursed', 'repaying') AND rb.has_disbursement_evidence
          THEN GREATEST(0, rb.effective_total - COALESCE(rb.amount_repaid, 0))
          ELSE 0
        END
      ), 0) AS balance,
      COALESCE(SUM(
        CASE
          WHEN GREATEST(0, rb.effective_total - COALESCE(rb.amount_repaid, 0)) > 0
           AND rb.status IN ('approved', 'funded', 'disbursed', 'repaying')
           AND rb.has_disbursement_evidence
          THEN rb.effective_daily
          ELSE 0
        END
      ), 0) AS daily,
      COALESCE(SUM(
        CASE
          WHEN rb.status IN ('funded', 'disbursed', 'repaying')
          THEN rb.effective_total
          ELSE 0
        END
      ), 0) AS total_repayment,
      COALESCE(SUM(
        CASE
          WHEN rb.status IN ('funded', 'disbursed', 'repaying')
          THEN COALESCE(rb.amount_repaid, 0)
          ELSE 0
        END
      ), 0) AS amount_repaid,
      COALESCE(SUM(
        CASE
          WHEN rb.status = 'repaying' AND rb.has_disbursement_evidence
          THEN GREATEST(0, rb.effective_total - COALESCE(rb.amount_repaid, 0))
          ELSE 0
        END
      ), 0) AS repaying_balance,
      ARRAY_REMOVE(ARRAY_AGG(DISTINCT rb.agent_payment_status), NULL) AS payment_states,
      ARRAY_REMOVE(ARRAY_AGG(DISTINCT rb.status), NULL) AS statuses,
      COUNT(*)::integer AS request_count,
      COUNT(*) FILTER (
        WHERE rb.status = 'completed'
          AND rb.effective_total > 0
          AND COALESCE(rb.amount_repaid, 0) >= rb.effective_total
      )::integer AS completed_count
    FROM request_base rb
    GROUP BY rb.tenant_id
  ),
  latest_context AS (
    SELECT DISTINCT ON (rb.tenant_id)
      rb.tenant_id,
      rb.status AS latest_status,
      rb.landlord_name,
      rb.property_address,
      rb.latitude,
      rb.longitude
    FROM request_base rb
    ORDER BY rb.tenant_id, rb.created_at DESC
  ),
  last_repayment AS (
    SELECT DISTINCT ON (r.tenant_id)
      r.tenant_id,
      r.created_at AS last_paid_at,
      COALESCE(r.amount, 0) AS last_paid_amount
    FROM public.repayments r
    JOIN tenants t ON t.id = r.tenant_id
    ORDER BY r.tenant_id, r.created_at DESC
  ),
  today_repayments AS (
    SELECT
      r.tenant_id,
      COALESCE(SUM(r.amount), 0) AS today_paid_amount,
      COUNT(*)::integer AS today_paid_count
    FROM public.repayments r
    JOIN tenants t ON t.id = r.tenant_id
    WHERE r.created_at >= p_today_start
    GROUP BY r.tenant_id
  )
  SELECT
    t.id,
    t.full_name,
    t.phone,
    t.email,
    t.created_at,
    t.monthly_rent,
    t.verified,
    COALESCE(ra.balance, 0) AS balance,
    COALESCE(ra.daily, 0) AS daily,
    COALESCE(ra.total_repayment, 0) AS total_repayment,
    COALESCE(ra.amount_repaid, 0) AS amount_repaid,
    COALESCE(ra.statuses, ARRAY[]::text[]) AS statuses,
    lc.landlord_name,
    lc.property_address,
    lc.latitude,
    lc.longitude,
    COALESCE(ra.completed_count, 0) AS completed_count,
    COALESCE(ra.request_count, 0) AS request_count,
    lr.last_paid_at,
    COALESCE(lr.last_paid_amount, 0) AS last_paid_amount,
    COALESCE(tr.today_paid_amount, 0) AS today_paid_amount,
    COALESCE(tr.today_paid_count, 0) AS today_paid_count,
    COALESCE(ra.repaying_balance, 0) AS repaying_balance,
    COALESCE(ra.payment_states, ARRAY[]::text[]) AS payment_states,
    COALESCE(lc.latest_status, 'unknown') AS latest_status
  FROM tenants t
  LEFT JOIN request_agg ra ON ra.tenant_id = t.id
  LEFT JOIN latest_context lc ON lc.tenant_id = t.id
  LEFT JOIN last_repayment lr ON lr.tenant_id = t.id
  LEFT JOIN today_repayments tr ON tr.tenant_id = t.id
  ORDER BY COALESCE(ra.balance, 0) DESC, t.full_name ASC;
$function$;
