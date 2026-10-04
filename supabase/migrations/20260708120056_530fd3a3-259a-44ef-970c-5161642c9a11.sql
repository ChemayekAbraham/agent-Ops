-- 1) Add a dedicated sub-agent bonus column and fold it into the generated total.
ALTER TABLE public.credit_access_limits
  ADD COLUMN IF NOT EXISTS bonus_from_subagents numeric NOT NULL DEFAULT 0;

ALTER TABLE public.credit_access_limits
  ALTER COLUMN total_limit
  SET EXPRESSION AS (
    LEAST(
      COALESCE(base_limit, 0)
      + COALESCE(bonus_from_ratings, 0)
      + COALESCE(bonus_from_receipts, 0)
      + COALESCE(bonus_from_rent_history, 0)
      + COALESCE(bonus_from_landlord_rent, 0)
      + COALESCE(bonus_from_houses_listed, 0)
      + COALESCE(bonus_from_partners_onboarded, 0)
      + COALESCE(bonus_from_agent_allocations, 0)
      + COALESCE(bonus_from_subagents, 0),
      30000000
    )
  );

-- 2) Revise the limit engine. Agents get a sub-agent-driven limit (≈70% of the
--    cap from active sub-agents), with rent collection contributing
--    significantly and houses listed + tenant rent requests contributing too.
--    Non-agents (tenants) keep the existing rent-history-based rent-access limit.
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
  v_active_subagents INT := 0;
  v_collections_total NUMERIC := 0;
  v_placements_count INT := 0;
  v_total NUMERIC;
BEGIN
  IF public.has_role(p_user_id, 'agent') THEN
    -- ============================================================
    -- AGENT ADVANCE LIMIT
    -- Composition when maxed (30M cap):
    --   Sub-agents        70%  (21,000,000)  ← primary driver
    --   Rent collection   ~20% ( 6,000,000)  ← significant
    --   Houses listed     ~7.5%( 2,250,000)
    --   Rent requests     ~7.5%( 2,250,000)
    -- ============================================================

    -- Active sub-agents (accepted / active / verified) — 70% weight.
    SELECT COUNT(*) INTO v_active_subagents
    FROM public.agent_subagents
    WHERE parent_agent_id = p_user_id
      AND sub_agent_id IS NOT NULL
      AND (status IN ('active','verified') OR accepted_at IS NOT NULL);
    v_subagents_bonus := LEAST(v_active_subagents * 1500000, 21000000);

    -- Rent collected by the agent — significant contribution.
    SELECT COALESCE(SUM(amount), 0) INTO v_collections_total
    FROM public.agent_collections WHERE agent_id = p_user_id;
    v_agent_allocations_bonus := LEAST(v_collections_total * 0.5, 6000000);

    -- Houses listed by the agent.
    SELECT COUNT(*) INTO v_houses_count
    FROM public.house_listings WHERE agent_id = p_user_id;
    v_houses_listed_bonus := LEAST(v_houses_count * 100000, 2250000);

    -- Rent requests the agent raised for tenants (tenant placements).
    SELECT COUNT(*) INTO v_placements_count
    FROM public.rent_requests
    WHERE agent_id = p_user_id AND agent_id <> tenant_id;
    v_rent_history_bonus := LEAST(v_placements_count * 150000, 2250000);

    -- Legacy tenant-style bonuses do not apply to the agent advance limit.
    v_rating_bonus := 0;
    v_receipt_bonus := 0;
    v_landlord_rent_bonus := 0;
    v_partners_bonus := 0;

  ELSE
    -- ============================================================
    -- TENANT RENT-ACCESS LIMIT (unchanged behaviour)
    -- ============================================================
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

-- 3) Re-weight the ops scoring so collection is significant and, crucially,
--    make the suggested advance track the agent's actual current limit.
CREATE OR REPLACE FUNCTION public.get_agent_advance_potential(_search text DEFAULT NULL::text, _limit integer DEFAULT 100, _offset integer DEFAULT 0)
 RETURNS TABLE(agent_id uuid, full_name text, phone text, email text, avatar_url text, verified boolean, territory text, direct_subagents bigint, active_subagents bigint, grand_subagents bigint, rent_collected numeric, collections_count bigint, house_listings bigint, rent_requests bigint, advances_count bigint, principal_total numeric, outstanding_total numeric, repayment_rate numeric, current_limit numeric, has_active_advance boolean, network_score numeric, collections_score numeric, repayment_score numeric, listings_score numeric, requests_score numeric, potential_score numeric, suggested_amount numeric, total_matched bigint)
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
           count(*) FILTER (WHERE aa.status IN ('completed','repaid','closed','settled')) AS repaid_cnt,
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
    WHERE (
      v_search IS NULL
      OR lower(coalesce(p.full_name,'')) LIKE v_pattern
      OR lower(coalesce(p.email,'')) LIKE v_pattern
      OR lower(coalesce(p.territory,'')) LIKE v_pattern
      OR (v_digits IS NOT NULL AND regexp_replace(coalesce(p.phone,''), '\D','','g') LIKE '%'||v_digits||'%')
    )
  ),
  scored AS (
    -- 70% sub-agents, collection significant (15), repayment (5),
    -- houses (5), rent requests (5).
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
    -- Suggested advance TRACKS the agent's actual limit: a fraction of the
    -- current limit driven by repayment track record, never exceeding it.
    -- New agents (no advances) start at 30% of their limit.
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
  ),
  counted AS (
    SELECT *, count(*) OVER ()::bigint AS total_matched FROM suggested
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