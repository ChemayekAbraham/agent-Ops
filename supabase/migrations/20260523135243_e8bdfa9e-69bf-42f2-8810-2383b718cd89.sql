-- Add dedicated bonus column for agent tenant float allocations
ALTER TABLE public.credit_access_limits
  ADD COLUMN IF NOT EXISTS bonus_from_agent_allocations numeric NOT NULL DEFAULT 0;

-- Update recalculate to track the 2x allocation bonus in its own bucket
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
  v_avg_rating NUMERIC;
  v_receipt_count INT;
  v_completed_requests INT;
  v_total_rent_collected NUMERIC;
  v_houses_count INT;
  v_partners_count INT;
  v_repayments_count INT;
  v_agent_allocations_total NUMERIC := 0;
  v_agent_allocations_bonus NUMERIC := 0;
  v_total NUMERIC;
BEGIN
  SELECT AVG(rating) INTO v_avg_rating FROM tenant_ratings WHERE tenant_id = p_user_id;
  IF v_avg_rating IS NOT NULL AND v_avg_rating > 3 THEN
    v_rating_bonus := ROUND((v_avg_rating - 3) * 500000);
  END IF;

  SELECT COUNT(*) INTO v_receipt_count FROM user_receipts WHERE user_id = p_user_id AND verified = true;
  v_receipt_bonus := v_receipt_count * 50000;

  SELECT COUNT(*) INTO v_completed_requests FROM rent_requests
    WHERE tenant_id = p_user_id AND status IN ('completed','repaid','disbursed','funded');
  v_rent_history_bonus := v_completed_requests * 200000;

  SELECT COALESCE(SUM(COALESCE(desired_rent_from_welile, monthly_rent, 0)), 0) INTO v_total_rent_collected
    FROM landlords WHERE registered_by = p_user_id AND tenant_id IS NOT NULL;
  v_landlord_rent_bonus := LEAST(v_total_rent_collected * 2, 10000000);

  SELECT COUNT(*) INTO v_houses_count FROM house_listings WHERE agent_id = p_user_id;
  v_houses_listed_bonus := LEAST(v_houses_count * 50000, 5000000);

  SELECT COUNT(*) INTO v_partners_count FROM investor_portfolios
    WHERE agent_id = p_user_id AND status IN ('active','completed');
  v_partners_bonus := LEAST(v_partners_count * 200000, 5000000);

  SELECT COUNT(*) INTO v_repayments_count FROM general_ledger
    WHERE user_id = p_user_id AND category = 'rent_repayment' AND direction = 'credit';
  v_rent_history_bonus := v_rent_history_bonus + LEAST(v_repayments_count * 20000, 5000000);

  -- Agent tenant-allocation bonus: 2x the cumulative amount allocated, capped at 30M
  SELECT COALESCE(SUM(amount), 0) INTO v_agent_allocations_total
    FROM agent_collections WHERE agent_id = p_user_id;
  v_agent_allocations_bonus := LEAST(v_agent_allocations_total * 2, 30000000);

  v_total := LEAST(
    30000 + v_rating_bonus + v_receipt_bonus + v_rent_history_bonus
          + v_landlord_rent_bonus + v_houses_listed_bonus + v_partners_bonus
          + v_agent_allocations_bonus,
    30000000
  );

  INSERT INTO credit_access_limits (
    user_id, base_limit, bonus_from_ratings, bonus_from_receipts,
    bonus_from_rent_history, bonus_from_landlord_rent,
    bonus_from_houses_listed, bonus_from_partners_onboarded,
    bonus_from_agent_allocations
  ) VALUES (
    p_user_id, 30000, v_rating_bonus, v_receipt_bonus,
    v_rent_history_bonus, v_landlord_rent_bonus,
    v_houses_listed_bonus, v_partners_bonus,
    v_agent_allocations_bonus
  )
  ON CONFLICT (user_id) DO UPDATE SET
    bonus_from_ratings = v_rating_bonus,
    bonus_from_receipts = v_receipt_bonus,
    bonus_from_rent_history = v_rent_history_bonus,
    bonus_from_landlord_rent = v_landlord_rent_bonus,
    bonus_from_houses_listed = v_houses_listed_bonus,
    bonus_from_partners_onboarded = v_partners_bonus,
    bonus_from_agent_allocations = v_agent_allocations_bonus;

  RETURN v_total;
END;
$function$;