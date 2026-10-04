CREATE OR REPLACE FUNCTION public.get_agent_ops_monthly_kpis(_month date DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
WITH
ms AS (SELECT date_trunc('month', coalesce(_month::timestamptz, now())) AS s),
me AS (SELECT (SELECT s FROM ms) + interval '1 month' AS e),
ps AS (SELECT (SELECT s FROM ms) - interval '1 month' AS s),
qa AS (SELECT count(*) AS n FROM public.agent_ops_qualifying_agent_ids()),
adv_current AS (
  SELECT count(DISTINCT agent_id) AS n FROM agent_advances
  WHERE created_at < (SELECT e FROM me) AND status IN ('active','overdue')
),
adv_current_prev AS (
  SELECT count(DISTINCT agent_id) AS n FROM agent_advances
  WHERE created_at < (SELECT s FROM ms) AND status IN ('active','overdue')
),
adv_month AS (
  SELECT count(DISTINCT agent_id) AS n FROM agent_advances
  WHERE created_at >= (SELECT s FROM ms) AND created_at < (SELECT e FROM me)
),
adv_prev AS (
  SELECT count(DISTINCT agent_id) AS n FROM agent_advances
  WHERE created_at >= (SELECT s FROM ps) AND created_at < (SELECT s FROM ms)
),
first_adv AS (SELECT agent_id, min(created_at) mc FROM agent_advances GROUP BY agent_id),
new_month AS (SELECT count(*) AS n FROM first_adv WHERE mc >= (SELECT s FROM ms) AND mc < (SELECT e FROM me)),
new_prev AS (SELECT count(*) AS n FROM first_adv WHERE mc >= (SELECT s FROM ps) AND mc < (SELECT s FROM ms)),
vol_month AS (SELECT coalesce(sum(principal),0) AS v FROM agent_advances WHERE created_at >= (SELECT s FROM ms) AND created_at < (SELECT e FROM me)),
vol_prev AS (SELECT coalesce(sum(principal),0) AS v FROM agent_advances WHERE created_at >= (SELECT s FROM ps) AND created_at < (SELECT s FROM ms)),
repay AS (
  SELECT coalesce(sum(principal),0) AS principal, coalesce(sum(outstanding_balance),0) AS outstanding
  FROM agent_advances WHERE created_at < (SELECT e FROM me)
),
repay_prev AS (
  SELECT coalesce(sum(principal),0) AS principal, coalesce(sum(outstanding_balance),0) AS outstanding
  FROM agent_advances WHERE created_at < (SELECT s FROM ms)
),
del_month AS (SELECT count(*) AS n FROM agent_delivery_confirmations WHERE created_at >= (SELECT s FROM ms) AND created_at < (SELECT e FROM me)),
del_prev AS (SELECT count(*) AS n FROM agent_delivery_confirmations WHERE created_at >= (SELECT s FROM ps) AND created_at < (SELECT s FROM ms))
SELECT jsonb_build_object(
  'month', to_char((SELECT s FROM ms), 'Mon YYYY'),
  'month_start', to_char((SELECT s FROM ms), 'YYYY-MM-DD'),
  'is_current_month', ((SELECT s FROM ms) = date_trunc('month', now())),
  'total_agents', (SELECT n FROM qa),
  'adv_agents_current', (SELECT n FROM adv_current),
  'adv_agents_current_prev', (SELECT n FROM adv_current_prev),
  'adv_agents_month', (SELECT n FROM adv_month),
  'adv_agents_prev', (SELECT n FROM adv_prev),
  'new_adv_agents_month', (SELECT n FROM new_month),
  'new_adv_agents_prev', (SELECT n FROM new_prev),
  'volume_month', (SELECT v FROM vol_month),
  'volume_prev', (SELECT v FROM vol_prev),
  'principal_total', (SELECT principal FROM repay),
  'outstanding_total', (SELECT outstanding FROM repay),
  'principal_total_prev', (SELECT principal FROM repay_prev),
  'outstanding_total_prev', (SELECT outstanding FROM repay_prev),
  'deliveries_month', (SELECT n FROM del_month),
  'deliveries_prev', (SELECT n FROM del_prev)
);
$function$;

GRANT EXECUTE ON FUNCTION public.get_agent_ops_monthly_kpis(date) TO authenticated, service_role;