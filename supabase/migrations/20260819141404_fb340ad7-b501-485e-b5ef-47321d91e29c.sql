CREATE OR REPLACE FUNCTION public.ops_agent_ops_weekly_bundle(p_from timestamptz, p_to timestamptz)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
WITH d AS (
  SELECT generate_series(
    (p_from AT TIME ZONE 'Africa/Kampala')::date,
    (p_to   AT TIME ZONE 'Africa/Kampala')::date,
    '1 day'::interval)::date AS day
),
daily AS (
  SELECT d.day,
    (SELECT count(*) FROM agent_collections c WHERE (c.created_at AT TIME ZONE 'Africa/Kampala')::date = d.day) AS collections,
    (SELECT coalesce(sum(c.amount),0) FROM agent_collections c WHERE (c.created_at AT TIME ZONE 'Africa/Kampala')::date = d.day) AS volume,
    (SELECT count(DISTINCT c.agent_id) FROM agent_collections c WHERE (c.created_at AT TIME ZONE 'Africa/Kampala')::date = d.day) AS active_agents,
    (SELECT count(DISTINCT c.tenant_id) FROM agent_collections c WHERE (c.created_at AT TIME ZONE 'Africa/Kampala')::date = d.day) AS tenants_paid,
    (SELECT count(*) FROM wallet_deposits w WHERE (w.created_at AT TIME ZONE 'Africa/Kampala')::date = d.day) AS deposits,
    (SELECT coalesce(sum(w.amount),0) FROM wallet_deposits w WHERE (w.created_at AT TIME ZONE 'Africa/Kampala')::date = d.day) AS deposits_amount,
    (SELECT count(*) FROM agent_advance_requests a WHERE (a.created_at AT TIME ZONE 'Africa/Kampala')::date = d.day) AS advances_raised,
    (SELECT coalesce(sum(a.principal),0) FROM agent_advance_requests a WHERE (a.created_at AT TIME ZONE 'Africa/Kampala')::date = d.day) AS advances_principal,
    (SELECT count(*) FROM agent_advance_requests a WHERE (a.cfo_paid_at AT TIME ZONE 'Africa/Kampala')::date = d.day) AS advances_disbursed,
    (SELECT count(*) FROM agent_advance_requests a WHERE a.created_at < (d.day + 1)::date AND a.status = 'pending') AS advances_pending_now
  FROM d
),
win AS (
  SELECT count(*) AS collections, coalesce(sum(amount),0) AS volume,
         count(DISTINCT agent_id) AS agents, count(DISTINCT tenant_id) AS tenants
  FROM agent_collections WHERE created_at >= p_from AND created_at <= p_to
),
prev AS (
  SELECT count(*) AS collections, coalesce(sum(amount),0) AS volume, count(DISTINCT agent_id) AS agents
  FROM agent_collections
  WHERE created_at >= p_from - (p_to - p_from) - interval '1 second' AND created_at < p_from
),
tops AS (
  SELECT coalesce(p.full_name,'Unknown') AS agent, p.phone,
         count(*) AS collections, coalesce(sum(c.amount),0) AS volume,
         count(DISTINCT c.tenant_id) AS tenants,
         count(DISTINCT (c.created_at AT TIME ZONE 'Africa/Kampala')::date) AS days_active
  FROM agent_collections c LEFT JOIN profiles p ON p.id = c.agent_id
  WHERE c.created_at >= p_from AND c.created_at <= p_to
  GROUP BY 1,2 ORDER BY 4 DESC LIMIT 15
),
methods AS (
  SELECT payment_method::text AS method, count(*) AS n, coalesce(sum(amount),0) AS amount
  FROM agent_collections WHERE created_at >= p_from AND created_at <= p_to
  GROUP BY 1 ORDER BY 3 DESC
),
statuses AS (
  SELECT status, count(*) AS n, coalesce(sum(principal),0) AS principal
  FROM agent_advance_requests WHERE created_at >= p_from AND created_at <= p_to
  GROUP BY 1 ORDER BY 2 DESC
)
SELECT jsonb_build_object(
  'daily', (SELECT coalesce(jsonb_agg(to_jsonb(daily) ORDER BY day),'[]'::jsonb) FROM daily),
  'window', (SELECT to_jsonb(win) FROM win),
  'previous', (SELECT to_jsonb(prev) FROM prev),
  'top_agents', (SELECT coalesce(jsonb_agg(to_jsonb(tops)),'[]'::jsonb) FROM tops),
  'methods', (SELECT coalesce(jsonb_agg(to_jsonb(methods)),'[]'::jsonb) FROM methods),
  'advance_statuses', (SELECT coalesce(jsonb_agg(to_jsonb(statuses)),'[]'::jsonb) FROM statuses),
  'context', jsonb_build_object(
    'agents_with_live_rents', (SELECT count(DISTINCT agent_id) FROM rent_requests WHERE status IN ('funded','repaying') AND agent_id IS NOT NULL),
    'active_advances', (SELECT count(*) FROM agent_advances WHERE status = 'active'),
    'active_advances_principal', (SELECT coalesce(sum(principal),0) FROM agent_advances WHERE status = 'active'),
    'wallet_deposits_total_rows', (SELECT count(*) FROM wallet_deposits),
    'wallet_deposits_latest', (SELECT max(created_at) FROM wallet_deposits)
  )
);
$$;

REVOKE ALL ON FUNCTION public.ops_agent_ops_weekly_bundle(timestamptz, timestamptz) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.ops_agent_ops_weekly_bundle(timestamptz, timestamptz) TO service_role;