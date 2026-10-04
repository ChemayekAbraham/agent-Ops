CREATE OR REPLACE FUNCTION public.recalculate_credit_limit(p_user_id uuid)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_rating_bonus NUMERIC := 0;
  v_receipt_bonus NUMERIC := 0;
  v_rent_history_bonus NUMERIC := 0;
  v_landlord_rent_bonus NUMERIC := 0;
  v_houses_listed_bonus NUMERIC := 0;
  v_partners_bonus NUMERIC := 0;
  v_agent_allocations_bonus NUMERIC := 0;
  v_subagents_bonus NUMERIC := 0;
  v_avg_rating NUMERIC;
  v_receipt_count INT;
  v_completed_requests INT;
  v_total_rent_collected NUMERIC;
  v_houses_count INT;
  v_partners_count INT;
  v_repayments_count INT;
  v_agent_allocations_total NUMERIC := 0;
  v_registered_subagents INT := 0;
  v_active_subagents INT := 0;
  v_collections_total NUMERIC := 0;
  v_placements_count INT := 0;
  v_total NUMERIC;
BEGIN
  IF public.has_role(p_user_id, 'agent') THEN
    SELECT COUNT(*) INTO v_registered_subagents
    FROM public.agent_subagents
    WHERE parent_agent_id = p_user_id
      AND sub_agent_id IS NOT NULL
      AND (status IN ('active','verified') OR accepted_at IS NOT NULL);

    SELECT COUNT(*) INTO v_active_subagents
    FROM public.agent_subagents s
    JOIN public.v_agent_daily_eligibility e ON e.agent_id = s.sub_agent_id
    WHERE s.parent_agent_id = p_user_id
      AND s.sub_agent_id IS NOT NULL
      AND (s.status IN ('active','verified') OR s.accepted_at IS NOT NULL)
      AND e.active_count > 0;

    v_subagents_bonus := (v_registered_subagents * 50000) + (v_active_subagents * 50000);

    SELECT COALESCE(SUM(amount), 0) INTO v_collections_total
    FROM public.agent_collections WHERE agent_id = p_user_id;
    v_agent_allocations_bonus := LEAST(v_collections_total * 0.3, 6000000);

    SELECT COUNT(*) INTO v_houses_count
    FROM public.house_listings WHERE agent_id = p_user_id;
    v_houses_listed_bonus := LEAST(v_houses_count * 30000, 1000000);

    SELECT COUNT(*) INTO v_placements_count
    FROM public.rent_requests
    WHERE agent_id = p_user_id AND agent_id <> tenant_id;
    v_rent_history_bonus := LEAST(v_placements_count * 50000, 2250000);

    v_rating_bonus := 0;
    v_receipt_bonus := 0;
    v_landlord_rent_bonus := 0;
    v_partners_bonus := 0;

  ELSE
    SELECT AVG(rating) INTO v_avg_rating FROM public.tenant_ratings WHERE tenant_id = p_user_id;
    IF v_avg_rating IS NOT NULL AND v_avg_rating > 3 THEN
      v_rating_bonus := ROUND((v_avg_rating - 3) * 500000);
    END IF;

    SELECT COUNT(*) INTO v_receipt_count FROM public.user_receipts WHERE user_id = p_user_id AND verified = true;
    v_receipt_bonus := v_receipt_count * 50000;

    SELECT COUNT(*) INTO v_completed_requests FROM public.rent_requests
      WHERE tenant_id = p_user_id AND status IN ('completed','repaid','disbursed','funded');
    v_rent_history_bonus := v_completed_requests * 200000;

    SELECT COALESCE(SUM(COALESCE(desired_rent_from_welile, monthly_rent, 0)), 0) INTO v_total_rent_collected
      FROM public.landlords WHERE registered_by = p_user_id AND tenant_id IS NOT NULL;
    v_landlord_rent_bonus := LEAST(v_total_rent_collected * 2, 10000000);

    SELECT COUNT(*) INTO v_houses_count FROM public.house_listings WHERE agent_id = p_user_id;
    v_houses_listed_bonus := LEAST(v_houses_count * 50000, 5000000);

    SELECT COUNT(*) INTO v_partners_count FROM public.investor_portfolios
      WHERE agent_id = p_user_id AND status IN ('active','completed');
    v_partners_bonus := LEAST(v_partners_count * 200000, 5000000);

    SELECT COUNT(*) INTO v_repayments_count FROM public.general_ledger
      WHERE user_id = p_user_id AND category = 'rent_repayment' AND direction = 'credit';
    v_rent_history_bonus := v_rent_history_bonus + LEAST(v_repayments_count * 20000, 5000000);

    SELECT COALESCE(SUM(amount), 0) INTO v_agent_allocations_total
      FROM public.agent_collections WHERE agent_id = p_user_id;
    v_agent_allocations_bonus := LEAST(v_agent_allocations_total * 2, 30000000);

    v_subagents_bonus := 0;
  END IF;

  v_total := LEAST(
    30000 + v_rating_bonus + v_receipt_bonus + v_rent_history_bonus
          + v_landlord_rent_bonus + v_houses_listed_bonus + v_partners_bonus
          + v_agent_allocations_bonus + v_subagents_bonus,
    30000000
  );

  INSERT INTO public.credit_access_limits (
    user_id, base_limit, bonus_from_ratings, bonus_from_receipts,
    bonus_from_rent_history, bonus_from_landlord_rent,
    bonus_from_houses_listed, bonus_from_partners_onboarded,
    bonus_from_agent_allocations, bonus_from_subagents
  ) VALUES (
    p_user_id, 30000, v_rating_bonus, v_receipt_bonus,
    v_rent_history_bonus, v_landlord_rent_bonus,
    v_houses_listed_bonus, v_partners_bonus,
    v_agent_allocations_bonus, v_subagents_bonus
  )
  ON CONFLICT (user_id) DO UPDATE SET
    base_limit = 30000,
    bonus_from_ratings = v_rating_bonus,
    bonus_from_receipts = v_receipt_bonus,
    bonus_from_rent_history = v_rent_history_bonus,
    bonus_from_landlord_rent = v_landlord_rent_bonus,
    bonus_from_houses_listed = v_houses_listed_bonus,
    bonus_from_partners_onboarded = v_partners_bonus,
    bonus_from_agent_allocations = v_agent_allocations_bonus,
    bonus_from_subagents = v_subagents_bonus;

  RETURN v_total;
END;
$function$;

DROP FUNCTION IF EXISTS public.get_agent_advance_limits(text, int, int);

CREATE FUNCTION public.get_agent_advance_limits(
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
  registered_subagents bigint,
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
           count(*) FILTER (WHERE s.status IN ('active','verified') OR s.accepted_at IS NOT NULL) AS registered,
           count(*) FILTER (
             WHERE (s.status IN ('active','verified') OR s.accepted_at IS NOT NULL)
               AND elig.active_count > 0
           ) AS active
    FROM public.agent_subagents s
    LEFT JOIN public.v_agent_daily_eligibility elig ON elig.agent_id = s.sub_agent_id
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
      coalesce(sd.total, 0)      AS direct_subs,
      coalesce(sd.registered, 0) AS registered_subs,
      coalesce(sd.active, 0)     AS active_subs,
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
      ((m.registered_subs * 50000) + (m.active_subs * 50000))::numeric AS c_subs,
      LEAST(m.rent_collected * 0.3, 6000000)::numeric AS c_coll,
      LEAST(m.houses_listed * 30000, 1000000)::numeric AS c_house,
      LEAST(m.rent_requests * 50000, 2250000)::numeric AS c_req
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
    cf.direct_subs, cf.registered_subs, cf.active_subs, cf.rent_collected, cf.collections_count,
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