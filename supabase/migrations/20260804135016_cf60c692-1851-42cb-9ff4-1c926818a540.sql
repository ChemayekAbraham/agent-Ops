CREATE OR REPLACE VIEW public.v_agent_daily_eligibility AS
WITH active_rents AS (
  SELECT rr.agent_id, rr.id AS rent_request_id, rr.daily_repayment, rr.amount_repaid, rr.total_repayment
  FROM rent_requests rr
  WHERE rr.status = ANY (ARRAY['funded'::text,'repaying'::text])
    AND COALESCE(rr.agent_payment_status,'paying') <> 'not_paying'
), paused AS (
  SELECT DISTINCT p.rent_request_id
  FROM rent_repayment_pauses p
  WHERE p.status = 'active'
    AND p.resumed_at IS NULL
    AND (p.resume_on IS NULL OR p.resume_on >= (now() AT TIME ZONE 'Africa/Kampala')::date)
), reversed AS (
  SELECT DISTINCT agent_tenant_float_reversals.rent_request_id FROM agent_tenant_float_reversals
), eligible_rents AS (
  SELECT ar.* FROM active_rents ar
  LEFT JOIN reversed rv ON rv.rent_request_id = ar.rent_request_id
  LEFT JOIN paused pz ON pz.rent_request_id = ar.rent_request_id
  WHERE (rv.rent_request_id IS NULL OR COALESCE(ar.amount_repaid,0) > 0)
    AND pz.rent_request_id IS NULL
    AND (COALESCE(ar.total_repayment,0) - COALESCE(ar.amount_repaid,0)) > 0
), expected AS (
  SELECT agent_id, count(*)::integer AS active_count, COALESCE(sum(daily_repayment),0) AS expected_daily
  FROM eligible_rents GROUP BY agent_id
), collection_events AS (
  SELECT ac.agent_id, ac.amount, ac.created_at FROM agent_collections ac
  WHERE ac.created_at >= (((now() AT TIME ZONE 'Africa/Kampala')::date - 1)::timestamp AT TIME ZONE 'Africa/Kampala')
), collected AS (
  SELECT ce.agent_id,
    sum(CASE WHEN (ce.created_at AT TIME ZONE 'Africa/Kampala')::date = (now() AT TIME ZONE 'Africa/Kampala')::date THEN ce.amount ELSE 0 END) AS paid_today,
    sum(CASE WHEN (ce.created_at AT TIME ZONE 'Africa/Kampala')::date = ((now() AT TIME ZONE 'Africa/Kampala')::date - 1) THEN ce.amount ELSE 0 END) AS paid_yesterday
  FROM collection_events ce GROUP BY ce.agent_id
)
SELECT e.agent_id, e.active_count, e.expected_daily,
  COALESCE(c.paid_today,0) AS paid_today,
  COALESCE(c.paid_yesterday,0) AS paid_yesterday,
  CASE WHEN e.expected_daily > 0 THEN round(COALESCE(c.paid_today,0)/e.expected_daily,4) ELSE 0 END AS today_pct,
  CASE WHEN e.expected_daily > 0 THEN round(COALESCE(c.paid_yesterday,0)/e.expected_daily,4) ELSE 0 END AS yesterday_pct,
  CASE WHEN e.expected_daily > 0 THEN GREATEST(COALESCE(c.paid_today,0)/e.expected_daily, COALESCE(c.paid_yesterday,0)/e.expected_daily) ELSE 0 END AS effective_pct
FROM expected e LEFT JOIN collected c USING (agent_id);