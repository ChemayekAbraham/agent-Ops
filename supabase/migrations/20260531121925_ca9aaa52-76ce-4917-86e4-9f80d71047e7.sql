CREATE OR REPLACE VIEW public.v_agent_daily_eligibility AS
WITH active_rents AS (
  SELECT rr.agent_id,
         rr.id AS rent_request_id,
         rr.daily_repayment,
         rr.amount_repaid,
         rr.total_repayment
  FROM rent_requests rr
  -- A tenant only becomes "active" once the CFO has sent the money to the
  -- landlord float (status flips to 'funded', then 'repaying' as they pay).
  -- Pre-funding pipeline stages no longer count toward the agent daily target.
  WHERE rr.status = ANY (ARRAY['funded'::text, 'repaying'::text])
), reversed AS (
  SELECT DISTINCT agent_tenant_float_reversals.rent_request_id
  FROM agent_tenant_float_reversals
), eligible_rents AS (
  SELECT ar.agent_id,
         ar.rent_request_id,
         ar.daily_repayment,
         ar.amount_repaid,
         ar.total_repayment
  FROM active_rents ar
  LEFT JOIN reversed rv ON rv.rent_request_id = ar.rent_request_id
  -- Exclude tenants the agent fully "marked not funded" (reversed + no net repayment),
  -- and only count tenants who still have a rent balance to pay (under owing).
  WHERE (rv.rent_request_id IS NULL OR COALESCE(ar.amount_repaid, 0::numeric) > 0::numeric)
    AND (COALESCE(ar.total_repayment, 0::numeric) - COALESCE(ar.amount_repaid, 0::numeric)) > 0::numeric
), expected AS (
  SELECT eligible_rents.agent_id,
         count(*)::integer AS active_count,
         COALESCE(sum(eligible_rents.daily_repayment), 0::numeric) AS expected_daily
  FROM eligible_rents
  GROUP BY eligible_rents.agent_id
), collected AS (
  SELECT ac.agent_id,
         sum(CASE WHEN (ac.created_at AT TIME ZONE 'Africa/Kampala'::text)::date = (now() AT TIME ZONE 'Africa/Kampala'::text)::date THEN ac.amount ELSE 0::numeric END) AS paid_today,
         sum(CASE WHEN (ac.created_at AT TIME ZONE 'Africa/Kampala'::text)::date = ((now() AT TIME ZONE 'Africa/Kampala'::text)::date - 1) THEN ac.amount ELSE 0::numeric END) AS paid_yesterday
  FROM agent_collections ac
  WHERE ac.created_at >= (((now() AT TIME ZONE 'Africa/Kampala'::text)::date - 1)::timestamp without time zone AT TIME ZONE 'Africa/Kampala'::text)
  GROUP BY ac.agent_id
)
SELECT e.agent_id,
       e.active_count,
       e.expected_daily,
       COALESCE(c.paid_today, 0::numeric) AS paid_today,
       COALESCE(c.paid_yesterday, 0::numeric) AS paid_yesterday,
       CASE WHEN e.expected_daily > 0::numeric THEN round(COALESCE(c.paid_today, 0::numeric) / e.expected_daily, 4) ELSE 0::numeric END AS today_pct,
       CASE WHEN e.expected_daily > 0::numeric THEN round(COALESCE(c.paid_yesterday, 0::numeric) / e.expected_daily, 4) ELSE 0::numeric END AS yesterday_pct,
       CASE WHEN e.expected_daily > 0::numeric THEN GREATEST(COALESCE(c.paid_today, 0::numeric) / e.expected_daily, COALESCE(c.paid_yesterday, 0::numeric) / e.expected_daily) ELSE 0::numeric END AS effective_pct
FROM expected e
LEFT JOIN collected c USING (agent_id);