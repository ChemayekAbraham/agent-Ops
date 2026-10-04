CREATE OR REPLACE FUNCTION public.get_agent_advance_limits(
  _search text DEFAULT NULL,
  _limit int DEFAULT 100,
  _offset int DEFAULT 0
)
RETURNS TABLE (
  agent_id uuid,
  full_name text,
  phone text,
  email text,
  avatar_url text,
  verified boolean,
  territory text,
  direct_subagents bigint,
  active_subagents bigint,
  rent_collected numeric,
  collections_count bigint,
  houses_listed bigint,
  rent_requests bigint,
  base_limit numeric,
  subagents_bonus numeric,
  collections_bonus numeric,
  houses_bonus numeric,
  requests_bonus numeric,
  total_limit numeric,
  stored_total_limit numeric,
  total_matched bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_limit int := LEAST(GREATEST(COALESCE(_limit, 100), 1), 300);
  v_offset int := GREATEST(COALESCE(_offset, 0), 0);
  v_search text := NULLIF(TRIM(COALESCE(_search, '')), '');
  v_pattern text;
  v_digits text;
BEGIN
  IF v_search IS NOT NULL THEN
    v_pattern := '%' || lower(v_search) || '%';
    v_digits := NULLIF(regexp_replace(v_search, '\D', '', 'g'), '');
  END IF;

  RETURN QUERY
  WITH agents AS (
    SELECT DISTINCT ur.user_id AS uid
    FROM public.user_roles ur
    WHERE ur.role = 'agent'
  ),
  sub_direct AS (
    SELECT s.parent_agent_id AS uid,
           count(*) AS total,
           count(*) FILTER (WHERE s.status IN ('active','verified') OR s.accepted_at IS NOT NULL) AS active
    FROM public.agent_subagents s
    WHERE s.parent_agent_id IS NOT NULL AND s.sub_agent_id IS NOT NULL
    GROUP BY s.parent_agent_id
  ),
  coll AS (
    SELECT ac.agent_id AS uid, coalesce(sum(ac.amount),0) AS amt, count(*) AS cnt
    FROM public.agent_collections ac
    GROUP BY ac.agent_id
  ),
  listings AS (
    SELECT hl.agent_id AS uid, count(*) AS cnt
    FROM public.house_listings hl
    WHERE hl.agent_id IS NOT NULL
    GROUP BY hl.agent_id
  ),
  reqs AS (
    SELECT rr.agent_id AS uid, count(*) AS cnt
    FROM public.rent_requests rr
    WHERE rr.agent_id IS NOT NULL AND rr.agent_id <> rr.tenant_id
    GROUP BY rr.agent_id
  ),
  stored AS (
    SELECT cal.user_id AS uid, cal.total_limit AS lim
    FROM public.credit_access_limits cal
  ),
  metrics AS (
    SELECT
      a.uid,
      p.full_name, p.phone, p.email, p.avatar_url, p.verified, p.territory,
      coalesce(sd.total, 0)  AS direct_subs,
      coalesce(sd.active, 0) AS active_subs,
      coalesce(c.amt, 0)     AS rent_collected,
      coalesce(c.cnt, 0)     AS collections_count,
      coalesce(l.cnt, 0)     AS houses_listed,
      coalesce(rq.cnt, 0)    AS rent_requests,
      coalesce(st.lim, 0)    AS stored_total_limit
    FROM agents a
    JOIN public.profiles p ON p.id = a.uid
    LEFT JOIN sub_direct sd ON sd.uid = a.uid
    LEFT JOIN coll c        ON c.uid = a.uid
    LEFT JOIN listings l    ON l.uid = a.uid
    LEFT JOIN reqs rq       ON rq.uid = a.uid
    LEFT JOIN stored st     ON st.uid = a.uid
    WHERE (
      v_search IS NULL
      OR lower(coalesce(p.full_name,'')) LIKE v_pattern
      OR lower(coalesce(p.email,'')) LIKE v_pattern
      OR lower(coalesce(p.territory,'')) LIKE v_pattern
      OR (v_digits IS NOT NULL AND regexp_replace(coalesce(p.phone,''), '\D','','g') LIKE '%'||v_digits||'%')
    )
  ),
  computed AS (
    SELECT m.*,
      30000::numeric AS c_base,
      (LEAST(m.active_subs * 1500000, 21000000) + (m.active_subs * 50000))::numeric AS c_subs,
      LEAST(m.rent_collected * 0.5, 6000000)::numeric AS c_coll,
      LEAST(m.houses_listed * 100000, 2250000)::numeric AS c_house,
      LEAST(m.rent_requests * 150000, 2250000)::numeric AS c_req
    FROM metrics m
  ),
  finalized AS (
    SELECT cp.*,
      LEAST(cp.c_base + cp.c_subs + cp.c_coll + cp.c_house + cp.c_req, 30000000)::numeric AS c_total
    FROM computed cp
  ),
  counted AS (
    SELECT *, count(*) OVER ()::bigint AS total_matched FROM finalized
  )
  SELECT
    cf.uid, cf.full_name, cf.phone, cf.email, cf.avatar_url, cf.verified, cf.territory,
    cf.direct_subs, cf.active_subs, cf.rent_collected, cf.collections_count,
    cf.houses_listed, cf.rent_requests,
    cf.c_base, cf.c_subs, cf.c_coll, cf.c_house, cf.c_req, cf.c_total,
    cf.stored_total_limit,
    cf.total_matched
  FROM counted cf
  ORDER BY cf.c_total DESC, cf.active_subs DESC, cf.rent_collected DESC
  LIMIT v_limit OFFSET v_offset;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_agent_advance_limits(text, int, int) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_agent_advance_limits(text, int, int) TO service_role;