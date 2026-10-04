
CREATE OR REPLACE VIEW public.v_agent_daily_eligibility AS
WITH active_rents AS (
  SELECT rr.agent_id, rr.id AS rent_request_id, rr.daily_repayment, rr.amount_repaid, rr.total_repayment
  FROM rent_requests rr
  WHERE rr.status = ANY (ARRAY['funded'::text, 'repaying'::text])
    AND COALESCE(rr.agent_payment_status, 'paying') <> 'not_paying'
),
reversed AS (SELECT DISTINCT rent_request_id FROM agent_tenant_float_reversals),
eligible_rents AS (
  SELECT ar.*
  FROM active_rents ar
  LEFT JOIN reversed rv ON rv.rent_request_id = ar.rent_request_id
  WHERE (rv.rent_request_id IS NULL OR COALESCE(ar.amount_repaid,0) > 0)
    AND (COALESCE(ar.total_repayment,0) - COALESCE(ar.amount_repaid,0)) > 0
),
expected AS (
  SELECT agent_id, count(*)::int AS active_count, COALESCE(sum(daily_repayment),0) AS expected_daily
  FROM eligible_rents GROUP BY agent_id
),
collection_events AS (
  -- Direct tenant collections
  SELECT agent_id, amount, created_at
  FROM agent_collections
  WHERE created_at >= (((now() AT TIME ZONE 'Africa/Kampala')::date - 1)::timestamp AT TIME ZONE 'Africa/Kampala')
  UNION ALL
  -- Per-tenant landlord float allocations count as collections (money committed to a tenant's landlord)
  SELECT agent_id, allocated_amount AS amount, created_at
  FROM agent_landlord_float_allocations
  WHERE created_at >= (((now() AT TIME ZONE 'Africa/Kampala')::date - 1)::timestamp AT TIME ZONE 'Africa/Kampala')
    AND tenant_id IS NOT NULL
    AND status <> 'cancelled'
),
collected AS (
  SELECT agent_id,
    sum(CASE WHEN (created_at AT TIME ZONE 'Africa/Kampala')::date = (now() AT TIME ZONE 'Africa/Kampala')::date THEN amount ELSE 0 END) AS paid_today,
    sum(CASE WHEN (created_at AT TIME ZONE 'Africa/Kampala')::date = ((now() AT TIME ZONE 'Africa/Kampala')::date - 1) THEN amount ELSE 0 END) AS paid_yesterday
  FROM collection_events GROUP BY agent_id
)
SELECT e.agent_id, e.active_count, e.expected_daily,
  COALESCE(c.paid_today,0) AS paid_today,
  COALESCE(c.paid_yesterday,0) AS paid_yesterday,
  CASE WHEN e.expected_daily > 0 THEN round(COALESCE(c.paid_today,0)/e.expected_daily, 4) ELSE 0 END AS today_pct,
  CASE WHEN e.expected_daily > 0 THEN round(COALESCE(c.paid_yesterday,0)/e.expected_daily, 4) ELSE 0 END AS yesterday_pct,
  CASE WHEN e.expected_daily > 0 THEN GREATEST(COALESCE(c.paid_today,0)/e.expected_daily, COALESCE(c.paid_yesterday,0)/e.expected_daily) ELSE 0 END AS effective_pct
FROM expected e
LEFT JOIN collected c USING (agent_id);
