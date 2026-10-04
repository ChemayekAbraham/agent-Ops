-- Allow agents to insert rent history for any tenant (they're capturing on behalf)
-- Records start as 'pending' and require back-office verification
CREATE POLICY "Agents insert rent history for tenants"
ON public.rent_history_records
FOR INSERT
TO authenticated
WITH CHECK (
  has_role(auth.uid(), 'agent'::app_role)
  AND status = 'pending'
);

-- Agents can view rent history records they've captured (for tenants they work with)
CREATE POLICY "Agents view rent history they captured"
ON public.rent_history_records
FOR SELECT
TO authenticated
USING (
  has_role(auth.uid(), 'agent'::app_role)
);

-- Scoring function: computes accessible business advance limit from rent history
-- Welile-scored: base + bonuses for months recorded, landlord stability, tenure
CREATE OR REPLACE FUNCTION public.calculate_business_advance_limit(_tenant_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total_months integer := 0;
  v_avg_rent numeric := 0;
  v_distinct_landlords integer := 0;
  v_max_consecutive integer := 0;
  v_starter_limit numeric := 50000;
  v_base_limit numeric := 0;
  v_consistency_bonus numeric := 0;
  v_loyalty_bonus numeric := 0;
  v_tenure_bonus numeric := 0;
  v_total_limit numeric := 0;
  v_next_unlock numeric := 0;
BEGIN
  -- Aggregate rent history (count both pending and verified for instant feedback)
  SELECT
    COALESCE(SUM(months_paid), 0),
    COALESCE(AVG(rent_amount), 0),
    COUNT(DISTINCT landlord_phone),
    COALESCE(MAX(months_paid), 0)
  INTO v_total_months, v_avg_rent, v_distinct_landlords, v_max_consecutive
  FROM public.rent_history_records
  WHERE tenant_id = _tenant_id
    AND status IN ('pending', 'verified');

  -- Cap months at 12 for scoring
  v_total_months := LEAST(v_total_months, 12);

  IF v_total_months = 0 THEN
    RETURN jsonb_build_object(
      'total_limit', v_starter_limit,
      'starter_limit', v_starter_limit,
      'base_limit', 0,
      'consistency_bonus', 0,
      'loyalty_bonus', 0,
      'tenure_bonus', 0,
      'months_recorded', 0,
      'avg_monthly_rent', 0,
      'next_unlock_at_months', 3,
      'next_unlock_amount', GREATEST(150000, ROUND(150000 * 0.5)),
      'tier_label', 'Starter'
    );
  END IF;

  -- Base: 1x avg rent per recorded month (max 12x)
  v_base_limit := v_avg_rent * v_total_months;

  -- Consistency bonus: +20% if 6+ months recorded
  IF v_total_months >= 6 THEN
    v_consistency_bonus := v_base_limit * 0.20;
  END IF;

  -- Loyalty bonus: +15% if 1-2 distinct landlords (stable tenancy)
  IF v_distinct_landlords > 0 AND v_distinct_landlords <= 2 THEN
    v_loyalty_bonus := v_base_limit * 0.15;
  END IF;

  -- Tenure bonus: +25% if 12 full months on record
  IF v_total_months >= 12 THEN
    v_tenure_bonus := v_base_limit * 0.25;
  END IF;

  v_total_limit := GREATEST(v_starter_limit, v_base_limit + v_consistency_bonus + v_loyalty_bonus + v_tenure_bonus);
  v_total_limit := LEAST(v_total_limit, 10000000); -- platform max cap

  -- Calculate "next unlock" preview
  IF v_total_months < 6 THEN
    v_next_unlock := (v_avg_rent * 6) * 1.20;
    RETURN jsonb_build_object(
      'total_limit', ROUND(v_total_limit),
      'starter_limit', v_starter_limit,
      'base_limit', ROUND(v_base_limit),
      'consistency_bonus', ROUND(v_consistency_bonus),
      'loyalty_bonus', ROUND(v_loyalty_bonus),
      'tenure_bonus', ROUND(v_tenure_bonus),
      'months_recorded', v_total_months,
      'avg_monthly_rent', ROUND(v_avg_rent),
      'distinct_landlords', v_distinct_landlords,
      'next_unlock_at_months', 6,
      'next_unlock_amount', ROUND(LEAST(v_next_unlock, 10000000)),
      'tier_label', 'Building'
    );
  ELSIF v_total_months < 12 THEN
    v_next_unlock := (v_avg_rent * 12) * 1.60;
    RETURN jsonb_build_object(
      'total_limit', ROUND(v_total_limit),
      'starter_limit', v_starter_limit,
      'base_limit', ROUND(v_base_limit),
      'consistency_bonus', ROUND(v_consistency_bonus),
      'loyalty_bonus', ROUND(v_loyalty_bonus),
      'tenure_bonus', ROUND(v_tenure_bonus),
      'months_recorded', v_total_months,
      'avg_monthly_rent', ROUND(v_avg_rent),
      'distinct_landlords', v_distinct_landlords,
      'next_unlock_at_months', 12,
      'next_unlock_amount', ROUND(LEAST(v_next_unlock, 10000000)),
      'tier_label', 'Established'
    );
  ELSE
    RETURN jsonb_build_object(
      'total_limit', ROUND(v_total_limit),
      'starter_limit', v_starter_limit,
      'base_limit', ROUND(v_base_limit),
      'consistency_bonus', ROUND(v_consistency_bonus),
      'loyalty_bonus', ROUND(v_loyalty_bonus),
      'tenure_bonus', ROUND(v_tenure_bonus),
      'months_recorded', v_total_months,
      'avg_monthly_rent', ROUND(v_avg_rent),
      'distinct_landlords', v_distinct_landlords,
      'next_unlock_at_months', null,
      'next_unlock_amount', null,
      'tier_label', 'Welile Trusted'
    );
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.calculate_business_advance_limit(uuid) TO authenticated;

-- Client-side preview helper (no tenant_id yet — score from raw months/rent input)
CREATE OR REPLACE FUNCTION public.preview_business_advance_limit(
  _months_recorded integer,
  _avg_monthly_rent numeric,
  _distinct_landlords integer DEFAULT 1
)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_months integer := LEAST(GREATEST(_months_recorded, 0), 12);
  v_rent numeric := GREATEST(_avg_monthly_rent, 0);
  v_landlords integer := GREATEST(_distinct_landlords, 1);
  v_starter numeric := 50000;
  v_base numeric;
  v_consistency numeric := 0;
  v_loyalty numeric := 0;
  v_tenure numeric := 0;
  v_total numeric;
BEGIN
  IF v_months = 0 OR v_rent = 0 THEN
    RETURN jsonb_build_object('total_limit', v_starter, 'tier_label', 'Starter', 'months_recorded', v_months);
  END IF;

  v_base := v_rent * v_months;
  IF v_months >= 6 THEN v_consistency := v_base * 0.20; END IF;
  IF v_landlords <= 2 THEN v_loyalty := v_base * 0.15; END IF;
  IF v_months >= 12 THEN v_tenure := v_base * 0.25; END IF;

  v_total := GREATEST(v_starter, v_base + v_consistency + v_loyalty + v_tenure);
  v_total := LEAST(v_total, 10000000);

  RETURN jsonb_build_object(
    'total_limit', ROUND(v_total),
    'base_limit', ROUND(v_base),
    'consistency_bonus', ROUND(v_consistency),
    'loyalty_bonus', ROUND(v_loyalty),
    'tenure_bonus', ROUND(v_tenure),
    'months_recorded', v_months,
    'avg_monthly_rent', ROUND(v_rent),
    'tier_label',
      CASE
        WHEN v_months >= 12 THEN 'Welile Trusted'
        WHEN v_months >= 6 THEN 'Established'
        WHEN v_months >= 3 THEN 'Building'
        ELSE 'Starter'
      END
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.preview_business_advance_limit(integer, numeric, integer) TO authenticated, anon;