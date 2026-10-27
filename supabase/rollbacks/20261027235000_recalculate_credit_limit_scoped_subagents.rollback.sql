-- Rollback for 20261027235000_recalculate_credit_limit_scoped_subagents.
-- Restores recalculate_credit_limit from 20260910170000 (the definition this
-- change replaced) and drops the owner-only count helper. Does not recompute
-- stored limits.

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
    SELECT COUNT(*) INTO v_registered_subagents
    FROM public.agent_subagents s
    WHERE s.parent_agent_id = p_user_id
      AND s.sub_agent_id IS NOT NULL
      AND (s.status IN ('active','verified') OR s.accepted_at IS NOT NULL)
      AND s.sub_agent_id IN (SELECT q.agent_id FROM public.agent_ops_qualifying_agent_ids() q);

    SELECT COUNT(*) INTO v_active_subagents
    FROM public.agent_subagents s
    JOIN public.v_agent_daily_eligibility e ON e.agent_id = s.sub_agent_id
    WHERE s.parent_agent_id = p_user_id
      AND s.sub_agent_id IS NOT NULL
      AND (s.status IN ('active','verified') OR s.accepted_at IS NOT NULL)
      AND e.active_count > 0
      AND s.sub_agent_id IN (SELECT q.agent_id FROM public.agent_ops_qualifying_agent_ids() q);

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

DROP FUNCTION IF EXISTS public._credit_limit_subagent_counts(uuid);

