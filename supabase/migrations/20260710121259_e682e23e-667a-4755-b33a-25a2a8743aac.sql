-- Single-agent advance-potential evaluation.
-- Mirrors get_agent_advance_potential's scoring EXACTLY but for ONE agent id,
-- and is NOT restricted to the qualifying-agent set. This lets Agent Ops
-- evaluate anyone who requests an advance even if they have not yet met the
-- "who is an agent" criteria, so requests are never vetted blind.
CREATE OR REPLACE FUNCTION public.get_agent_advance_potential_for(_agent_id uuid)
RETURNS TABLE(
  agent_id uuid, full_name text, phone text, email text, avatar_url text,
  verified boolean, territory text, direct_subagents bigint, active_subagents bigint,
  grand_subagents bigint, rent_collected numeric, collections_count bigint,
  house_listings bigint, rent_requests bigint, advances_count bigint,
  principal_total numeric, outstanding_total numeric, repayment_rate numeric,
  current_limit numeric, has_active_advance boolean, network_score numeric,
  collections_score numeric, repayment_score numeric, listings_score numeric,
  requests_score numeric, potential_score numeric, suggested_amount numeric,
  is_qualifying boolean
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  RETURN QUERY
  WITH agents AS (
    SELECT _agent_id AS uid
  ),
  sub_direct AS (
    SELECT s.parent_agent_id AS uid,
           count(*) AS total,
           count(*) FILTER (WHERE s.status = 'active' OR s.status = 'verified' OR s.accepted_at IS NOT NULL) AS active
    FROM public.agent_subagents s
    WHERE s.parent_agent_id = _agent_id AND s.sub_agent_id IS NOT NULL
    GROUP BY s.parent_agent_id
  ),
  sub_grand AS (
    SELECT s1.parent_agent_id AS uid, count(*) AS total
    FROM public.agent_subagents s1
    JOIN public.agent_subagents s2 ON s2.parent_agent_id = s1.sub_agent_id
    WHERE s1.parent_agent_id = _agent_id AND s2.sub_agent_id IS NOT NULL
    GROUP BY s1.parent_agent_id
  ),
  coll AS (
    SELECT ac.agent_id AS uid, coalesce(sum(ac.amount),0) AS amt, count(*) AS cnt
    FROM public.agent_collections ac
    WHERE ac.agent_id = _agent_id
    GROUP BY ac.agent_id
  ),
  listings AS (
    SELECT hl.agent_id AS uid, count(*) AS cnt
    FROM public.house_listings hl
    WHERE hl.agent_id = _agent_id
    GROUP BY hl.agent_id
  ),
  reqs AS (
    SELECT rr.agent_id AS uid, count(*) AS cnt
    FROM public.rent_requests rr
    WHERE rr.agent_id = _agent_id AND rr.agent_id <> rr.tenant_id
    GROUP BY rr.agent_id
  ),
  adv AS (
    SELECT aa.agent_id AS uid,
           count(*) AS cnt,
           coalesce(sum(aa.principal),0) AS principal,
           coalesce(sum(aa.outstanding_balance),0) AS outstanding,
           count(*) FILTER (WHERE aa.status IN ('completed','repaid','closed','settled')) AS repaid_cnt,
           bool_or(aa.status IN ('active','overdue')) AS has_active
    FROM public.agent_advances aa
    WHERE aa.agent_id = _agent_id
    GROUP BY aa.agent_id
  ),
  lim AS (
    SELECT cal.user_id AS uid, cal.total_limit AS lim
    FROM public.credit_access_limits cal
    WHERE cal.user_id = _agent_id
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
      coalesce(av.repaid_cnt, 0)       AS repaid_count,
      coalesce(av.principal, 0)        AS principal_total,
      coalesce(av.outstanding, 0)      AS outstanding_total,
      coalesce(av.has_active, false)   AS has_active_advance,
      coalesce(lm.lim, 0)              AS current_limit,
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
  ),
  scored AS (
    SELECT m.*,
      ROUND((LEAST(m.direct_subagents::numeric / 10.0, 1) * 55
           + LEAST(m.grand_subagents::numeric / 20.0, 1) * 15)::numeric, 1) AS net_score,
      ROUND((LEAST(m.rent_collected / 2000000.0, 1) * 15)::numeric, 1) AS coll_score,
      ROUND((coalesce(m.repay_rate, 0.7) * 5)::numeric, 1) AS repay_score,
      ROUND((LEAST(m.house_listings::numeric / 10.0, 1) * 5)::numeric, 1) AS list_score,
      ROUND((LEAST(m.rent_requests::numeric / 10.0, 1) * 5)::numeric, 1) AS req_score
    FROM metrics m
  ),
  finalized AS (
    SELECT s.*,
      ROUND((s.net_score + s.coll_score + s.repay_score + s.list_score + s.req_score)::numeric, 1) AS total_score
    FROM scored s
  ),
  suggested AS (
    SELECT f.*,
      LEAST(
        GREATEST(COALESCE(NULLIF(f.current_limit, 0), 0),
                 power(LEAST(GREATEST(f.total_score, 0), 100) / 100.0, 1.3) * 3000000),
        GREATEST(30000,
          ROUND(
            (
              GREATEST(COALESCE(NULLIF(f.current_limit, 0), 0),
                       power(LEAST(GREATEST(f.total_score, 0), 100) / 100.0, 1.3) * 3000000)
              * CASE
                  WHEN f.advances_count = 0 THEN 0.30
                  ELSE LEAST(1.0,
                         0.50
                         + 0.40 * COALESCE(f.repay_rate, 0)
                         + 0.10 * LEAST(f.repaid_count::numeric / 3.0, 1)
                       )
                END
            ) / 10000.0
          ) * 10000
        )
      ) AS suggested_amt
    FROM finalized f
  )
  SELECT
    sf.uid, sf.full_name, sf.phone, sf.email, sf.avatar_url, sf.verified, sf.territory,
    sf.direct_subagents, sf.active_subagents, sf.grand_subagents,
    sf.rent_collected, sf.collections_count, sf.house_listings, sf.rent_requests,
    sf.advances_count, sf.principal_total, sf.outstanding_total,
    sf.repay_rate AS repayment_rate,
    sf.current_limit, sf.has_active_advance,
    sf.net_score, sf.coll_score, sf.repay_score, sf.list_score, sf.req_score,
    sf.total_score, sf.suggested_amt,
    EXISTS (SELECT 1 FROM public.agent_ops_qualifying_agent_ids() q WHERE q.agent_id = _agent_id) AS is_qualifying
  FROM suggested sf;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_agent_advance_potential_for(uuid) TO authenticated, service_role;