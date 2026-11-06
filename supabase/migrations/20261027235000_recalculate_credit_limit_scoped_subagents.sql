-- recalculate_credit_limit was timing out (authenticated statement_timeout is 8s)
-- because scoring ONE agent computed the whole network twice:
--
--   1. agent_ops_qualifying_agent_ids() walks every listing, promissory note,
--      rent request, sub-agent link, referral and profile referrer, then the
--      caller keeps only this parent's sub-agents. The function did that twice.
--   2. JOIN v_agent_daily_eligibility, whose pin_days CTE calls
--      _agent_expected_effective(NULL) and rent_plan_billable_from for every
--      plan, just to test active_count > 0 on those same sub-agents.
--
-- The bonus formula is unchanged:
--   LEAST(active * 30000 + registered * 9000, 3000000)
--   active is still a subset of registered, and an active sub-agent still
--   earns both weights. Reversed collections stay excluded. Non-agents are
--   untouched. Caps and the 20,000 base are untouched.
--
-- Registered: a linked sub-agent (active/verified, or accepted) who is in the
-- qualifying set. That set is unchanged: base_ops (a listing, a promissory
-- note, or a rent request where agent_id <> tenant_id) plus anyone who can
-- reach base_ops by walking parent edges (sub-agent, referral, profile
-- referrer). Membership of a candidate is "the candidate or a descendant is
-- in base_ops", so the walk starts at THIS parent's sub-agents and follows
-- child edges only. UNION closes cycles.
--
-- Active: the same predicate as v_agent_daily_eligibility.active_count > 0.
-- A live rent (the view's live_rents filters) counts when it is repaying, or
-- when it is not repaying but has a positive pin in agent_expected_day_plans
-- for yesterday or today (Kampala). Normal-day rows from
-- _agent_expected_effective cannot add an agent: they are emitted only for
-- repaying plans, and a repaying live rent already counts. Checked read-only
-- against production on 2026-10-27: the active set matched the view for every
-- agent (110 = 110), and the parent with the most qualifying sub-agents
-- matched on both counts (registered 173, active 7, no id on either side
-- missing). The largest linked book (4,194 sub-agents, none qualifying) plans
-- as index lookups on that parent's rows, not a scan of the eligibility view.
--
-- _credit_limit_subagent_counts is owner-only. Default privileges would grant
-- EXECUTE to anon and authenticated; it has no caller check, so those grants
-- are revoked in this file. recalculate_credit_limit keeps its existing ACL
-- (CREATE OR REPLACE does not reset grants). No client call site changes.

CREATE OR REPLACE FUNCTION public._credit_limit_subagent_counts(p_user_id uuid)
RETURNS TABLE(registered_subagents integer, active_subagents integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
  WITH RECURSIVE subs AS (
    SELECT s.sub_agent_id AS id
    FROM public.agent_subagents s
    WHERE s.parent_agent_id = p_user_id
      AND s.sub_agent_id IS NOT NULL
      AND (s.status IN ('active', 'verified') OR s.accepted_at IS NOT NULL)
  ), down AS (
    SELECT id AS root, id AS node FROM subs
    UNION
    SELECT d.root, nxt.child
    FROM down d
    JOIN LATERAL (
      SELECT c.sub_agent_id AS child
      FROM public.agent_subagents c
      WHERE c.parent_agent_id = d.node
        AND c.sub_agent_id IS NOT NULL
      UNION ALL
      SELECT r.referred_id
      FROM public.referrals r
      WHERE r.referrer_id = d.node
        AND r.referred_id IS NOT NULL
      UNION ALL
      SELECT p.id
      FROM public.profiles p
      WHERE p.referrer_id = d.node
    ) nxt ON true
  ), qualifying AS (
    SELECT DISTINCT d.root AS id
    FROM down d
    WHERE EXISTS (SELECT 1 FROM public.house_listings hl WHERE hl.agent_id = d.node)
       OR EXISTS (SELECT 1 FROM public.promissory_notes pn WHERE pn.agent_id = d.node)
       OR EXISTS (
         SELECT 1 FROM public.rent_requests rr
         WHERE rr.agent_id = d.node
           AND rr.agent_id <> rr.tenant_id
       )
  ), day_start AS (
    SELECT ((now() AT TIME ZONE 'Africa/Kampala')::date::timestamp AT TIME ZONE 'Africa/Kampala') AS ts,
           (now() AT TIME ZONE 'Africa/Kampala')::date AS d_today,
           ((now() AT TIME ZONE 'Africa/Kampala')::date - 1) AS d_yesterday
  ), all_rents AS (
    SELECT rr.agent_id,
           rr.status,
           rr.id AS rent_request_id,
           rr.tenant_id,
           rr.amount_repaid,
           rr.total_repayment,
           rr.funded_at
    FROM qualifying q
    JOIN public.rent_requests rr ON rr.agent_id = q.id
    CROSS JOIN day_start ds
    WHERE (
      rr.status = ANY (ARRAY['funded', 'repaying'])
      OR (
        rr.status = 'completed'
        AND EXISTS (
          SELECT 1 FROM public.agent_collections ac0
          WHERE ac0.reversed_at IS NULL
            AND ac0.amount > 0
            AND ac0.created_at >= ds.ts
            AND (
              ac0.rent_request_id = rr.id
              OR (ac0.rent_request_id IS NULL AND ac0.tenant_id IS NOT NULL AND ac0.tenant_id = rr.tenant_id)
            )
        )
      )
    )
    AND COALESCE(rr.agent_payment_status, 'paying') <> 'not_paying'
  ), prior_paid AS (
    SELECT ac.rent_request_id, sum(ac.amount) AS paid_before_today
    FROM public.agent_collections ac
    JOIN all_rents ar ON ar.rent_request_id = ac.rent_request_id
    CROSS JOIN day_start ds
    WHERE ac.created_at < ds.ts
    GROUP BY ac.rent_request_id
  ), paused AS (
    SELECT DISTINCT p.rent_request_id
    FROM public.rent_repayment_pauses p
    CROSS JOIN day_start ds
    WHERE p.status = 'active'
      AND p.resumed_at IS NULL
      AND (p.resume_on IS NULL OR p.resume_on >= ds.d_today)
  ), reversal_marks AS (
    SELECT r.rent_request_id, r.created_at AS reversed_at
    FROM public.agent_tenant_float_reversals r
    WHERE r.rent_request_id IS NOT NULL
    UNION ALL
    SELECT arr.rent_request_id,
           COALESCE(arr.cfo_decision_at, arr.updated_at, arr.created_at)
    FROM public.agent_allocation_return_requests arr
    WHERE arr.status = 'approved'
      AND arr.rent_request_id IS NOT NULL
  ), reversal_latest AS (
    SELECT rent_request_id, max(reversed_at) AS reversed_at
    FROM reversal_marks
    GROUP BY rent_request_id
  ), reversed AS (
    SELECT rl.rent_request_id
    FROM reversal_latest rl
    WHERE NOT EXISTS (
      SELECT 1 FROM public.agent_landlord_float_allocations al
      WHERE al.rent_request_id = rl.rent_request_id
        AND al.paid_out_amount > 0
        AND COALESCE(al.updated_at, al.created_at) > rl.reversed_at
    )
  ), landlord_settled AS (
    SELECT DISTINCT a.rent_request_id
    FROM public.agent_landlord_float_allocations a
    WHERE a.rent_request_id IS NOT NULL
      AND a.paid_out_amount > 0
  ), alloc_activity AS (
    SELECT a.rent_request_id,
           max(GREATEST(a.created_at, COALESCE(a.updated_at, a.created_at))) AS last_change
    FROM public.agent_landlord_float_allocations a
    WHERE a.rent_request_id IS NOT NULL
    GROUP BY a.rent_request_id
  ), live_rents AS (
    SELECT ar.agent_id, ar.status, ar.rent_request_id
    FROM all_rents ar
    CROSS JOIN day_start ds
    LEFT JOIN prior_paid pp ON pp.rent_request_id = ar.rent_request_id
    LEFT JOIN alloc_activity aa ON aa.rent_request_id = ar.rent_request_id
    LEFT JOIN reversed rv ON rv.rent_request_id = ar.rent_request_id
    LEFT JOIN paused pz ON pz.rent_request_id = ar.rent_request_id
    LEFT JOIN landlord_settled ls ON ls.rent_request_id = ar.rent_request_id
    LEFT JOIN LATERAL (
      SELECT count(*) AS open_allocs
      FROM public.agent_landlord_float_allocations oa
      WHERE oa.rent_request_id = ar.rent_request_id
        AND oa.status = ANY (ARRAY['open', 'partially_paid', 'return_pending'])
    ) oa ON true
    WHERE (rv.rent_request_id IS NULL OR COALESCE(pp.paid_before_today, 0) > 0)
      AND pz.rent_request_id IS NULL
      AND (
        (COALESCE(ar.total_repayment, 0) - COALESCE(ar.amount_repaid, 0)) > 0
        OR EXISTS (
          SELECT 1 FROM public.agent_collections ac2
          WHERE ac2.amount > 0
            AND ac2.created_at >= ds.ts
            AND (
              ac2.rent_request_id = ar.rent_request_id
              OR (ac2.rent_request_id IS NULL AND ac2.tenant_id IS NOT NULL AND ac2.tenant_id = ar.tenant_id)
            )
        )
      )
      AND (
        COALESCE(pp.paid_before_today, 0) > 0
        OR (
          (ar.funded_at IS NULL OR ar.funded_at < ds.ts)
          AND (aa.last_change IS NULL OR aa.last_change < ds.ts)
          AND (ls.rent_request_id IS NOT NULL OR COALESCE(oa.open_allocs, 0) = 0)
        )
      )
  ), active_agents AS (
    SELECT DISTINCT lr.agent_id
    FROM live_rents lr
    CROSS JOIN day_start ds
    WHERE lr.status = 'repaying'
       OR EXISTS (
         SELECT 1 FROM public.agent_expected_day_plans e
         WHERE e.rent_request_id = lr.rent_request_id
           AND e.day IN (ds.d_yesterday, ds.d_today)
           AND e.expected_ugx > 0
           AND e.agent_id IS NOT NULL
       )
  )
  SELECT
    (SELECT count(*)::integer FROM qualifying),
    (SELECT count(*)::integer FROM active_agents);
$function$;

COMMENT ON FUNCTION public._credit_limit_subagent_counts(uuid) IS
  'Internal counts for recalculate_credit_limit. Owner-only; not a browser RPC.';

REVOKE ALL ON FUNCTION public._credit_limit_subagent_counts(uuid) FROM PUBLIC, anon, authenticated;

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
  v_rent_requests INT := 0;
  v_promissory_count INT := 0;
  v_total NUMERIC;
BEGIN
  IF public.has_role(p_user_id, 'agent') THEN
    -- Driver 1 (biggest): sub-agents, weighted heavily towards ACTIVE ones.
    -- Counts come from this parent's sub-agents only. See
    -- _credit_limit_subagent_counts for why this is not the global qualifying
    -- set or v_agent_daily_eligibility.
    SELECT c.registered_subagents, c.active_subagents
      INTO v_registered_subagents, v_active_subagents
    FROM public._credit_limit_subagent_counts(p_user_id) c;

    v_registered_subagents := COALESCE(v_registered_subagents, 0);
    v_active_subagents := COALESCE(v_active_subagents, 0);

    v_subagents_bonus := LEAST(
      (v_active_subagents * 30000) + (v_registered_subagents * 9000),
      3000000
    );

    -- Driver 2: rent collected (6% of lifetime collections).
    -- Reversed collections are excluded: money that was taken back must not
    -- buy borrowing capacity. The 2026-09-10 inverted collection incident put
    -- 353,842.08 of limit on one agent this way before this was fixed.
    SELECT COALESCE(SUM(amount), 0) INTO v_collections_total
    FROM public.agent_collections WHERE agent_id = p_user_id AND reversed_at IS NULL;
    v_agent_allocations_bonus := LEAST(v_collections_total * 0.06, 2400000);

    -- Driver 3: rent requests raised for tenants.
    SELECT COUNT(*) INTO v_rent_requests
    FROM public.rent_requests rr
    WHERE rr.agent_id = p_user_id
      AND rr.tenant_id IS NOT NULL
      AND rr.agent_id <> rr.tenant_id;
    v_rent_history_bonus := LEAST(v_rent_requests * 9000, 1500000);

    -- Driver 4: activated promissory notes.
    SELECT COUNT(*) INTO v_promissory_count
    FROM public.promissory_notes pn
    WHERE pn.agent_id = p_user_id
      AND (pn.status IN ('activated','approved') OR pn.approved_at IS NOT NULL);
    v_partners_bonus := LEAST(v_promissory_count * 9000, 600000);

    -- Retired for agents.
    v_houses_listed_bonus := 0;
    v_rating_bonus := 0;
    v_receipt_bonus := 0;
    v_landlord_rent_bonus := 0;

  ELSE
    -- Non-agent users: every ingredient cut to 30% of its previous weight.
    SELECT AVG(rating) INTO v_avg_rating FROM public.tenant_ratings WHERE tenant_id = p_user_id;
    IF v_avg_rating IS NOT NULL AND v_avg_rating > 3 THEN
      v_rating_bonus := ROUND((v_avg_rating - 3) * 150000);
    END IF;

    SELECT COUNT(*) INTO v_receipt_count FROM public.user_receipts WHERE user_id = p_user_id AND verified = true;
    v_receipt_bonus := v_receipt_count * 15000;

    SELECT COUNT(*) INTO v_completed_requests FROM public.rent_requests
      WHERE tenant_id = p_user_id AND status IN ('completed','repaid','disbursed','funded');
    v_rent_history_bonus := v_completed_requests * 60000;

    SELECT COALESCE(SUM(COALESCE(desired_rent_from_welile, monthly_rent, 0)), 0) INTO v_total_rent_collected
      FROM public.landlords WHERE registered_by = p_user_id AND tenant_id IS NOT NULL;
    v_landlord_rent_bonus := LEAST(v_total_rent_collected * 0.6, 3000000);

    SELECT COUNT(*) INTO v_houses_count FROM public.house_listings WHERE agent_id = p_user_id;
    v_houses_listed_bonus := LEAST(v_houses_count * 15000, 1500000);

    SELECT COUNT(*) INTO v_partners_count FROM public.investor_portfolios
      WHERE agent_id = p_user_id AND status IN ('active','completed');
    v_partners_bonus := LEAST(v_partners_count * 60000, 1500000);

    SELECT COUNT(*) INTO v_repayments_count FROM public.general_ledger
      WHERE user_id = p_user_id AND category = 'rent_repayment' AND direction = 'credit';
    v_rent_history_bonus := v_rent_history_bonus + LEAST(v_repayments_count * 6000, 1500000);

    -- Reversed collections excluded here too. The weighting is 60%, so the
    -- distortion would be ten times worse than on the agent branch.
    SELECT COALESCE(SUM(amount), 0) INTO v_agent_allocations_total
      FROM public.agent_collections WHERE agent_id = p_user_id AND reversed_at IS NULL;
    v_agent_allocations_bonus := LEAST(v_agent_allocations_total * 0.6, 9000000);

    v_subagents_bonus := 0;
  END IF;

  v_total := LEAST(
    20000 + v_rating_bonus + v_receipt_bonus + v_rent_history_bonus
          + v_landlord_rent_bonus + v_houses_listed_bonus + v_partners_bonus
          + v_agent_allocations_bonus + v_subagents_bonus,
    9000000
  );

  INSERT INTO public.credit_access_limits (
    user_id, base_limit, bonus_from_ratings, bonus_from_receipts,
    bonus_from_rent_history, bonus_from_landlord_rent,
    bonus_from_houses_listed, bonus_from_partners_onboarded,
    bonus_from_agent_allocations, bonus_from_subagents
  ) VALUES (
    p_user_id, 20000, v_rating_bonus, v_receipt_bonus,
    v_rent_history_bonus, v_landlord_rent_bonus,
    v_houses_listed_bonus, v_partners_bonus,
    v_agent_allocations_bonus, v_subagents_bonus
  )
  ON CONFLICT (user_id) DO UPDATE SET
    base_limit = 20000,
    bonus_from_ratings = v_rating_bonus,
    bonus_from_receipts = v_receipt_bonus,
    bonus_from_rent_history = v_rent_history_bonus,
    bonus_from_landlord_rent = v_landlord_rent_bonus,
    bonus_from_houses_listed = v_houses_listed_bonus,
    bonus_from_partners_onboarded = v_partners_bonus,
    bonus_from_agent_allocations = v_agent_allocations_bonus,
    bonus_from_subagents = v_subagents_bonus,
    updated_at = now();

  RETURN v_total;
END;
$function$;

-- CREATE OR REPLACE keeps the ACL already on this function. Restate it so the
-- grants stay authenticated + service_role, which is what production has.
REVOKE ALL ON FUNCTION public.recalculate_credit_limit(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.recalculate_credit_limit(uuid) TO authenticated, service_role;
