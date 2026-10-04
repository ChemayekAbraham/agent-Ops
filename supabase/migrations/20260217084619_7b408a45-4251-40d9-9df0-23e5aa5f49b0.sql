
-- Credit Access Limits: tracks each user's credit access limit
-- Auto-created on first access, starts at 30,000 UGX
CREATE TABLE public.credit_access_limits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE,
  base_limit NUMERIC NOT NULL DEFAULT 30000,
  bonus_from_ratings NUMERIC NOT NULL DEFAULT 0,
  bonus_from_receipts NUMERIC NOT NULL DEFAULT 0,
  bonus_from_rent_history NUMERIC NOT NULL DEFAULT 0,
  bonus_from_landlord_rent NUMERIC NOT NULL DEFAULT 0,
  total_limit NUMERIC GENERATED ALWAYS AS (
    LEAST(base_limit + bonus_from_ratings + bonus_from_receipts + bonus_from_rent_history + bonus_from_landlord_rent, 30000000)
  ) STORED,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.credit_access_limits ENABLE ROW LEVEL SECURITY;

-- Everyone can view any user's credit limit (visible to funders, managers, other users)
CREATE POLICY "Anyone authenticated can view credit limits"
  ON public.credit_access_limits FOR SELECT
  USING (true);

-- Users can insert their own limit record
CREATE POLICY "Users can insert own credit limit"
  ON public.credit_access_limits FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- System/managers can update limits
CREATE POLICY "System can update credit limits"
  ON public.credit_access_limits FOR UPDATE
  USING (true);

-- Trigger to update updated_at
CREATE TRIGGER update_credit_access_limits_updated_at
  BEFORE UPDATE ON public.credit_access_limits
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- Function to auto-calculate and upsert a user's credit limit
CREATE OR REPLACE FUNCTION public.recalculate_credit_limit(p_user_id UUID)
RETURNS NUMERIC AS $$
DECLARE
  v_rating_bonus NUMERIC := 0;
  v_receipt_bonus NUMERIC := 0;
  v_rent_history_bonus NUMERIC := 0;
  v_landlord_rent_bonus NUMERIC := 0;
  v_avg_rating NUMERIC;
  v_receipt_count INT;
  v_completed_requests INT;
  v_total_rent_collected NUMERIC;
  v_total NUMERIC;
BEGIN
  -- 1. Bonus from tenant ratings (avg rating * 100,000 per star above 3)
  SELECT AVG(rating) INTO v_avg_rating
  FROM tenant_ratings WHERE tenant_id = p_user_id;
  
  IF v_avg_rating IS NOT NULL AND v_avg_rating > 3 THEN
    v_rating_bonus := ROUND((v_avg_rating - 3) * 500000);
  END IF;

  -- 2. Bonus from receipts posted (each verified receipt = 50,000)
  SELECT COUNT(*) INTO v_receipt_count
  FROM user_receipts WHERE user_id = p_user_id AND verified = true;
  
  v_receipt_bonus := v_receipt_count * 50000;

  -- 3. Bonus from rent request history (each completed request = 200,000)
  SELECT COUNT(*) INTO v_completed_requests
  FROM rent_requests WHERE tenant_id = p_user_id AND status IN ('completed', 'repaid', 'disbursed', 'funded');
  
  v_rent_history_bonus := v_completed_requests * 200000;

  -- 4. Landlord bonus: based on total monthly rent they collect
  SELECT COALESCE(SUM(COALESCE(desired_rent_from_welile, monthly_rent, 0)), 0) INTO v_total_rent_collected
  FROM landlords WHERE registered_by = p_user_id AND tenant_id IS NOT NULL;
  
  v_landlord_rent_bonus := LEAST(v_total_rent_collected * 2, 10000000);

  v_total := LEAST(30000 + v_rating_bonus + v_receipt_bonus + v_rent_history_bonus + v_landlord_rent_bonus, 30000000);

  -- Upsert
  INSERT INTO credit_access_limits (user_id, base_limit, bonus_from_ratings, bonus_from_receipts, bonus_from_rent_history, bonus_from_landlord_rent)
  VALUES (p_user_id, 30000, v_rating_bonus, v_receipt_bonus, v_rent_history_bonus, v_landlord_rent_bonus)
  ON CONFLICT (user_id) DO UPDATE SET
    bonus_from_ratings = v_rating_bonus,
    bonus_from_receipts = v_receipt_bonus,
    bonus_from_rent_history = v_rent_history_bonus,
    bonus_from_landlord_rent = v_landlord_rent_bonus;

  RETURN v_total;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
