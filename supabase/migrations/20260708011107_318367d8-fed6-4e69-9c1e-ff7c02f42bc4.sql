-- Canonical, behavior-based set of qualifying agents (recursive closure)
CREATE OR REPLACE FUNCTION public.agent_ops_qualifying_agent_ids()
RETURNS TABLE(agent_id uuid)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
WITH RECURSIVE
base_ops AS (
  SELECT hl.agent_id AS uid FROM house_listings hl WHERE hl.agent_id IS NOT NULL
  UNION SELECT pn.agent_id FROM promissory_notes pn WHERE pn.agent_id IS NOT NULL
  UNION SELECT rr.agent_id FROM rent_requests rr WHERE rr.agent_id IS NOT NULL AND rr.agent_id <> rr.tenant_id
),
edges AS (
  SELECT s.parent_agent_id AS parent, s.sub_agent_id AS child FROM agent_subagents s WHERE s.parent_agent_id IS NOT NULL AND s.sub_agent_id IS NOT NULL
  UNION SELECT r.referrer_id, r.referred_id FROM referrals r WHERE r.referrer_id IS NOT NULL AND r.referred_id IS NOT NULL
  UNION SELECT pr.referrer_id, pr.id FROM profiles pr WHERE pr.referrer_id IS NOT NULL
),
agents_rec AS (
  SELECT uid FROM base_ops
  UNION
  SELECT e.parent FROM edges e JOIN agents_rec a ON a.uid = e.child
)
SELECT DISTINCT ar.uid FROM agents_rec ar WHERE ar.uid IS NOT NULL;
$function$;

GRANT EXECUTE ON FUNCTION public.agent_ops_qualifying_agent_ids() TO authenticated, service_role;

-- Rebuild directory totals off the qualifying set
CREATE OR REPLACE FUNCTION public.get_agent_directory_totals()
 RETURNS TABLE(total_count bigint, verified_count bigint, with_territory bigint, active_30d bigint, new_30d bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT
    COUNT(*)::BIGINT AS total_count,
    COUNT(*) FILTER (WHERE p.verified IS TRUE)::BIGINT AS verified_count,
    COUNT(*) FILTER (WHERE p.territory IS NOT NULL AND p.territory <> '')::BIGINT AS with_territory,
    COUNT(*) FILTER (WHERE p.last_active_at >= now() - interval '30 days')::BIGINT AS active_30d,
    COUNT(*) FILTER (WHERE p.created_at >= now() - interval '30 days')::BIGINT AS new_30d
  FROM public.agent_ops_qualifying_agent_ids() q
  JOIN public.profiles p ON p.id = q.agent_id;
$function$;

-- Rebuild directory rows off the qualifying set
CREATE OR REPLACE FUNCTION public.get_agent_directory_rows(_search text DEFAULT NULL::text, _sort text DEFAULT 'name'::text, _verified_only boolean DEFAULT false, _limit integer DEFAULT 50, _offset integer DEFAULT 0)
 RETURNS TABLE(user_id uuid, full_name text, phone text, email text, avatar_url text, verified boolean, created_at timestamp with time zone, territory text, last_active_at timestamp with time zone, total_matched bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_limit INT := LEAST(GREATEST(COALESCE(_limit, 50), 1), 200);
  v_offset INT := GREATEST(COALESCE(_offset, 0), 0);
  v_search TEXT := NULLIF(TRIM(COALESCE(_search, '')), '');
  v_search_pattern TEXT;
  v_search_digits TEXT;
BEGIN
  IF v_search IS NOT NULL THEN
    v_search_pattern := '%' || lower(v_search) || '%';
    v_search_digits := regexp_replace(v_search, '\D', '', 'g');
    IF v_search_digits = '' THEN v_search_digits := NULL; END IF;
  END IF;

  RETURN QUERY
  WITH base AS (
    SELECT
      q.agent_id AS user_id,
      p.full_name,
      p.phone,
      p.email,
      p.avatar_url,
      p.verified,
      p.created_at,
      p.territory,
      p.last_active_at
    FROM public.agent_ops_qualifying_agent_ids() q
    JOIN public.profiles p ON p.id = q.agent_id
    WHERE (NOT _verified_only OR p.verified IS TRUE)
      AND (
        v_search IS NULL
        OR lower(COALESCE(p.full_name, '')) LIKE v_search_pattern
        OR lower(COALESCE(p.email, '')) LIKE v_search_pattern
        OR lower(COALESCE(p.territory, '')) LIKE v_search_pattern
        OR (v_search_digits IS NOT NULL AND regexp_replace(COALESCE(p.phone, ''), '\D', '', 'g') LIKE '%' || v_search_digits || '%')
        OR q.agent_id::text ILIKE v_search_pattern
      )
  ),
  counted AS (
    SELECT *, COUNT(*) OVER ()::BIGINT AS total_matched FROM base
  )
  SELECT
    c.user_id, c.full_name, c.phone, c.email, c.avatar_url,
    c.verified, c.created_at, c.territory, c.last_active_at,
    c.total_matched
  FROM counted c
  ORDER BY
    CASE WHEN _sort = 'name' THEN lower(c.full_name) END ASC NULLS LAST,
    CASE WHEN _sort = 'recent' THEN c.created_at END DESC NULLS LAST,
    CASE WHEN _sort = 'active' THEN c.last_active_at END DESC NULLS LAST,
    CASE WHEN _sort = 'territory' THEN lower(c.territory) END ASC NULLS LAST,
    c.user_id
  LIMIT v_limit
  OFFSET v_offset;
END;
$function$;

-- Monthly advances scorecard raw metrics
CREATE OR REPLACE FUNCTION public.get_agent_ops_monthly_kpis()
RETURNS jsonb
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
WITH
ms AS (SELECT date_trunc('month', now()) AS s),
ps AS (SELECT date_trunc('month', now()) - interval '1 month' AS s),
qa AS (SELECT count(*) AS n FROM public.agent_ops_qualifying_agent_ids()),
adv_current AS (
  SELECT count(DISTINCT agent_id) AS n FROM agent_advances WHERE status IN ('active','overdue')
),
adv_month AS (
  SELECT count(DISTINCT agent_id) AS n FROM agent_advances WHERE created_at >= (SELECT s FROM ms)
),
adv_prev AS (
  SELECT count(DISTINCT agent_id) AS n FROM agent_advances
  WHERE created_at >= (SELECT s FROM ps) AND created_at < (SELECT s FROM ms)
),
first_adv AS (SELECT agent_id, min(created_at) mc FROM agent_advances GROUP BY agent_id),
new_month AS (SELECT count(*) AS n FROM first_adv WHERE mc >= (SELECT s FROM ms)),
new_prev AS (SELECT count(*) AS n FROM first_adv WHERE mc >= (SELECT s FROM ps) AND mc < (SELECT s FROM ms)),
vol_month AS (SELECT coalesce(sum(principal),0) AS v FROM agent_advances WHERE created_at >= (SELECT s FROM ms)),
vol_prev AS (SELECT coalesce(sum(principal),0) AS v FROM agent_advances WHERE created_at >= (SELECT s FROM ps) AND created_at < (SELECT s FROM ms)),
repay AS (SELECT coalesce(sum(principal),0) AS principal, coalesce(sum(outstanding_balance),0) AS outstanding FROM agent_advances),
del_month AS (SELECT count(*) AS n FROM agent_delivery_confirmations WHERE created_at >= (SELECT s FROM ms)),
del_prev AS (SELECT count(*) AS n FROM agent_delivery_confirmations WHERE created_at >= (SELECT s FROM ps) AND created_at < (SELECT s FROM ms))
SELECT jsonb_build_object(
  'month', to_char(now(), 'Mon YYYY'),
  'total_agents', (SELECT n FROM qa),
  'adv_agents_current', (SELECT n FROM adv_current),
  'adv_agents_month', (SELECT n FROM adv_month),
  'adv_agents_prev', (SELECT n FROM adv_prev),
  'new_adv_agents_month', (SELECT n FROM new_month),
  'new_adv_agents_prev', (SELECT n FROM new_prev),
  'volume_month', (SELECT v FROM vol_month),
  'volume_prev', (SELECT v FROM vol_prev),
  'principal_total', (SELECT principal FROM repay),
  'outstanding_total', (SELECT outstanding FROM repay),
  'deliveries_month', (SELECT n FROM del_month),
  'deliveries_prev', (SELECT n FROM del_prev)
);
$function$;

GRANT EXECUTE ON FUNCTION public.get_agent_ops_monthly_kpis() TO authenticated, service_role;