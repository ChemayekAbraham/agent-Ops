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
    -- Plus a flat +50,000 per active sub-agent, added on top of the
    -- weighted sub-agent bonus above.
    -- ============================================================

    -- Active sub-agents (accepted / active / verified) — 70% weight.
    SELECT COUNT(*) INTO v_active_subagents
    FROM public.agent_subagents
    WHERE parent_agent_id = p_user_id
      AND sub_agent_id IS NOT NULL
      AND (status IN ('active','verified') OR accepted_at IS NOT NULL);
    -- Weighted bonus (capped) PLUS a flat 50,000 per sub-agent added on top.
    v_subagents_bonus := LEAST(v_active_subagents * 1500000, 21000000)
                       + (v_active_subagents * 50000);

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