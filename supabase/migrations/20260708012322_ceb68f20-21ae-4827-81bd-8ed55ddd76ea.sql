
-- Agent Advance Potential engine
-- Ranks qualifying agents by how much they can grow the advance program.
-- Weighting (per user request):
--   * Sub-agent network (direct + grand) = 70% (the KEY driver)
--   * Rent collections                    = 12%
--   * Advance repayment performance       = 8%
--   * House listings                      = 5%
--   * Rent requests on behalf of tenants  = 5%
CREATE OR REPLACE FUNCTION public.get_agent_advance_potential(
  _search text DEFAULT NULL,
  _limit integer DEFAULT 100,
  _offset integer DEFAULT 0
)
RETURNS TABLE(
  agent_id uuid,
  full_name text,
  phone text,
  email text,
  avatar_url text,
  verified boolean,
  territory text,
  direct_subagents bigint,
  active_subagents bigint,
  grand_subagents bigint,
  rent_collected numeric,
  collections_count bigint,
  house_listings bigint,
  rent_requests bigint,
  advances_count bigint,
  principal_total numeric,
  outstanding_total numeric,
  repayment_rate numeric,
  current_limit numeric,
  has_active_advance boolean,
  network_score numeric,
  collections_score numeric,
  repayment_score numeric,
  listings_score numeric,
  requests_score numeric,
  potential_score numeric,
  suggested_amount numeric,
  total_matched bigint
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_limit INT := LEAST(GREATEST(COALESCE(_limit, 100), 1), 300);
  v_offset INT := GREATEST(COALESCE(_offset, 0), 0);
  v_search TEXT := NULLIF(TRIM(COALESCE(_search, '')), '');
  v_pattern TEXT;
  v_digits TEXT;
BEGIN
  IF v_search IS NOT NULL THEN
    v_pattern := '%' || lower(v_search) || '%';
    v_digits := NULLIF(regexp_replace(v_search, '\D', '', 'g'), '');
  END IF;

  RETURN QUERY
  WITH agents AS (
    SELECT q.agent_id AS uid FROM public.agent_ops_qualifying_agent_ids() q
  ),
  sub_direct AS (
    SELECT s.parent_agent_id AS uid,
           count(*) AS total,
           count(*) FILTER (WHERE s.status = 'active' OR s.status = 'verified' OR s.accepted_at IS NOT NULL) AS active
    FROM public.agent_subagents s
    WHERE s.parent_agent_id IS NOT NULL AND s.sub_agent_id IS NOT NULL
    GROUP BY s.parent_agent_id
  ),
  -- grand sub-agents: sub-agents under the user's own sub-agents
  sub_grand AS (
    SELECT s1.parent_agent_id AS uid, count(*) AS total
    FROM public.agent_subagents s1
    JOIN public.agent_subagents s2 ON s2.parent_agent_id = s1.sub_agent_id
    WHERE s1.parent_agent_id IS NOT NULL AND s2.sub_agent_id IS NOT NULL
    GROUP BY s1.parent_agent_id
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
  adv AS (
    SELECT aa.agent_id AS uid,
           count(*) AS cnt,
           coalesce(sum(aa.principal),0) AS principal,
           coalesce(sum(aa.outstanding_balance),0) AS outstanding,
           bool_or(aa.status IN ('active','overdue')) AS has_active
    FROM public.agent_advances aa
    GROUP BY aa.agent_id
  ),
  lim AS (
    SELECT cal.user_id AS uid, cal.total_limit AS lim
    FROM public.credit_access_limits cal
  ),
  metrics AS (
    SELECT
      a.uid,
      p.full_name, p.phone, p.email, p.avatar_url, p.verified, p.territory,
      coalesce(sd.total, 0)            AS direct_subagents,
      coalesce(sd.active, 0)           AS active_subagents,
      coalesce(sg.total, 0)            AS grand_subagents,
      coalesce(c.amt, 0)               AS rent_collected,
      coalesce(c.cnt, 0)               AS collections_count,
      coalesce(l.cnt, 0)               AS house_listings,
      coalesce(rq.cnt, 0)              AS rent_requests,
      coalesce(av.cnt, 0)              AS advances_count,
      coalesce(av.principal, 0)        AS principal_total,
      coalesce(av.outstanding, 0)      AS outstanding_total,
      coalesce(av.has_active, false)   AS has_active_advance,
      coalesce(lm.lim, 0)              AS current_limit,
      -- repayment rate: paid/principal among their advances (NULL if none)
      CASE WHEN coalesce(av.principal,0) > 0
        THEN GREATEST(0, LEAST(1, (av.principal - av.outstanding) / av.principal))
        ELSE NULL END                  AS repay_rate
    FROM agents a
    JOIN public.profiles p ON p.id = a.uid
    LEFT JOIN sub_direct sd ON sd.uid = a.uid
    LEFT JOIN sub_grand sg  ON sg.uid = a.uid
    LEFT JOIN coll c        ON c.uid = a.uid
    LEFT JOIN listings l    ON l.uid = a.uid
    LEFT JOIN reqs rq       ON rq.uid = a.uid
    LEFT JOIN adv av        ON av.uid = a.uid
    LEFT JOIN lim lm        ON lm.uid = a.uid
    WHERE (
      v_search IS NULL
      OR lower(coalesce(p.full_name,'')) LIKE v_pattern
      OR lower(coalesce(p.email,'')) LIKE v_pattern
      OR lower(coalesce(p.territory,'')) LIKE v_pattern
      OR (v_digits IS NOT NULL AND regexp_replace(coalesce(p.phone,''), '\D','','g') LIKE '%'||v_digits||'%')
    )
  ),
  scored AS (
    SELECT m.*,
      -- Network 70pts: direct heavily (target 10 -> 55), grand lighter (target 20 -> 15)
      ROUND((LEAST(m.direct_subagents::numeric / 10.0, 1) * 55
           + LEAST(m.grand_subagents::numeric / 20.0, 1) * 15)::numeric, 1) AS net_score,
      -- Collections 12pts: target 2,000,000 UGX
      ROUND((LEAST(m.rent_collected / 2000000.0, 1) * 12)::numeric, 1) AS coll_score,
      -- Repayment 8pts: no history => neutral 0.7
      ROUND((coalesce(m.repay_rate, 0.7) * 8)::numeric, 1) AS repay_score,
      -- Listings 5pts: target 10
      ROUND((LEAST(m.house_listings::numeric / 10.0, 1) * 5)::numeric, 1) AS list_score,
      -- Requests 5pts: target 10
      ROUND((LEAST(m.rent_requests::numeric / 10.0, 1) * 5)::numeric, 1) AS req_score
    FROM metrics m
  ),
  finalized AS (
    SELECT s.*,
      ROUND((s.net_score + s.coll_score + s.repay_score + s.list_score + s.req_score)::numeric, 1) AS total_score,
      -- Suggested advance value (UGX), network-heavy, capped at 30M
      LEAST(30000000, ROUND(
          s.direct_subagents * 500000
        + s.grand_subagents * 150000
        + s.rent_collected * 0.5
        + s.house_listings * 50000
        + s.rent_requests * 100000
        + coalesce(s.repay_rate, 0.7) * 2000000
      )) AS suggested_amt
    FROM scored s
  ),
  counted AS (
    SELECT *, count(*) OVER ()::bigint AS total_matched FROM finalized
  )
  SELECT
    cf.uid, cf.full_name, cf.phone, cf.email, cf.avatar_url, cf.verified, cf.territory,
    cf.direct_subagents, cf.active_subagents, cf.grand_subagents,
    cf.rent_collected, cf.collections_count, cf.house_listings, cf.rent_requests,
    cf.advances_count, cf.principal_total, cf.outstanding_total,
    cf.repay_rate AS repayment_rate,
    cf.current_limit, cf.has_active_advance,
    cf.net_score, cf.coll_score, cf.repay_score, cf.list_score, cf.req_score,
    cf.total_score, cf.suggested_amt,
    cf.total_matched
  FROM counted cf
  ORDER BY cf.total_score DESC, cf.direct_subagents DESC, cf.rent_collected DESC
  LIMIT v_limit OFFSET v_offset;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_agent_advance_potential(text, integer, integer) TO authenticated, service_role;
