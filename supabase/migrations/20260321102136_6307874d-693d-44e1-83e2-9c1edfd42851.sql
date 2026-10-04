
-- Credit Access Draws: tracks each credit draw with compounding logic
CREATE TABLE public.credit_access_draws (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  agent_id UUID,
  amount NUMERIC NOT NULL,
  duration_months INTEGER NOT NULL DEFAULT 1,
  duration_days INTEGER GENERATED ALWAYS AS (duration_months * 30) STORED,
  monthly_rate NUMERIC NOT NULL DEFAULT 0.33,
  access_fee NUMERIC NOT NULL DEFAULT 0,
  total_payable NUMERIC NOT NULL DEFAULT 0,
  daily_charge NUMERIC NOT NULL DEFAULT 0,
  outstanding_balance NUMERIC NOT NULL DEFAULT 0,
  amount_repaid NUMERIC NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.credit_access_draws ENABLE ROW LEVEL SECURITY;

-- Users can view their own draws
CREATE POLICY "Users view own draws"
  ON public.credit_access_draws FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id OR auth.uid() = agent_id);

-- Managers can view all
CREATE POLICY "Managers view all draws"
  ON public.credit_access_draws FOR SELECT
  TO authenticated
  USING (
    EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid() AND role IN ('manager', 'coo', 'cfo'))
  );

-- System can insert/update
CREATE POLICY "System insert draws"
  ON public.credit_access_draws FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "System update draws"
  ON public.credit_access_draws FOR UPDATE
  TO authenticated
  USING (true);

-- Credit draw ledger for daily tracking
CREATE TABLE public.credit_draw_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  draw_id UUID NOT NULL REFERENCES public.credit_access_draws(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  opening_balance NUMERIC NOT NULL DEFAULT 0,
  daily_charge NUMERIC NOT NULL DEFAULT 0,
  amount_deducted NUMERIC NOT NULL DEFAULT 0,
  agent_deducted NUMERIC NOT NULL DEFAULT 0,
  closing_balance NUMERIC NOT NULL DEFAULT 0,
  deduction_status TEXT NOT NULL DEFAULT 'none',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.credit_draw_ledger ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users view own draw ledger"
  ON public.credit_draw_ledger FOR SELECT
  TO authenticated
  USING (
    EXISTS (SELECT 1 FROM credit_access_draws WHERE id = draw_id AND (user_id = auth.uid() OR agent_id = auth.uid()))
  );

CREATE POLICY "System insert draw ledger"
  ON public.credit_draw_ledger FOR INSERT
  TO authenticated
  WITH CHECK (true);

-- Add agent-specific bonus columns to credit_access_limits
ALTER TABLE public.credit_access_limits 
  ADD COLUMN IF NOT EXISTS bonus_from_houses_listed NUMERIC NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS bonus_from_partners_onboarded NUMERIC NOT NULL DEFAULT 0;

-- Drop and recreate the generated column to include new bonus sources
ALTER TABLE public.credit_access_limits DROP COLUMN IF EXISTS total_limit;
ALTER TABLE public.credit_access_limits ADD COLUMN total_limit NUMERIC GENERATED ALWAYS AS (
  LEAST(
    base_limit + bonus_from_ratings + bonus_from_receipts + bonus_from_rent_history + bonus_from_landlord_rent + bonus_from_houses_listed + bonus_from_partners_onboarded,
    30000000
  )
) STORED;

-- Updated recalculate function with agent-specific bonuses
CREATE OR REPLACE FUNCTION public.recalculate_credit_limit(p_user_id UUID)
RETURNS NUMERIC AS $$
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
  v_total NUMERIC;
BEGIN
  -- 1. Bonus from tenant ratings (avg rating * 500,000 per star above 3)
  SELECT AVG(rating) INTO v_avg_rating
  FROM tenant_ratings WHERE tenant_id = p_user_id;
  
  IF v_avg_rating IS NOT NULL AND v_avg_rating > 3 THEN
    v_rating_bonus := ROUND((v_avg_rating - 3) * 500000);
  END IF;

  -- 2. Bonus from receipts posted (each verified receipt = 50,000)
  SELECT COUNT(*) INTO v_receipt_count
  FROM user_receipts WHERE user_id = p_user_id AND verified = true;
  v_receipt_bonus := v_receipt_count * 50000;

  -- 3. Bonus from rent request history (each completed = 200,000)
  SELECT COUNT(*) INTO v_completed_requests
  FROM rent_requests WHERE tenant_id = p_user_id AND status IN ('completed', 'repaid', 'disbursed', 'funded');
  v_rent_history_bonus := v_completed_requests * 200000;

  -- 4. Landlord bonus: based on total monthly rent
  SELECT COALESCE(SUM(COALESCE(desired_rent_from_welile, monthly_rent, 0)), 0) INTO v_total_rent_collected
  FROM landlords WHERE registered_by = p_user_id AND tenant_id IS NOT NULL;
  v_landlord_rent_bonus := LEAST(v_total_rent_collected * 2, 10000000);

  -- 5. NEW: Houses listed bonus (each listed house = 50,000, max 5M)
  SELECT COUNT(*) INTO v_houses_count
  FROM house_listings WHERE agent_id = p_user_id;
  v_houses_listed_bonus := LEAST(v_houses_count * 50000, 5000000);

  -- 6. NEW: Partners onboarded bonus (each partner = 200,000, max 5M)
  SELECT COUNT(*) INTO v_partners_count
  FROM investor_portfolios WHERE agent_id = p_user_id AND status IN ('active', 'completed');
  v_partners_bonus := LEAST(v_partners_count * 200000, 5000000);

  -- 7. NEW: Tenant repayment bonus (each on-time repayment = 20,000)
  SELECT COUNT(*) INTO v_repayments_count
  FROM general_ledger WHERE user_id = p_user_id AND category = 'rent_repayment' AND direction = 'credit';
  v_rent_history_bonus := v_rent_history_bonus + LEAST(v_repayments_count * 20000, 5000000);

  v_total := LEAST(30000 + v_rating_bonus + v_receipt_bonus + v_rent_history_bonus + v_landlord_rent_bonus + v_houses_listed_bonus + v_partners_bonus, 30000000);

  -- Upsert
  INSERT INTO credit_access_limits (user_id, base_limit, bonus_from_ratings, bonus_from_receipts, bonus_from_rent_history, bonus_from_landlord_rent, bonus_from_houses_listed, bonus_from_partners_onboarded)
  VALUES (p_user_id, 30000, v_rating_bonus, v_receipt_bonus, v_rent_history_bonus, v_landlord_rent_bonus, v_houses_listed_bonus, v_partners_bonus)
  ON CONFLICT (user_id) DO UPDATE SET
    bonus_from_ratings = v_rating_bonus,
    bonus_from_receipts = v_receipt_bonus,
    bonus_from_rent_history = v_rent_history_bonus,
    bonus_from_landlord_rent = v_landlord_rent_bonus,
    bonus_from_houses_listed = v_houses_listed_bonus,
    bonus_from_partners_onboarded = v_partners_bonus;

  RETURN v_total;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Trigger for updated_at
CREATE TRIGGER update_credit_access_draws_updated_at
  BEFORE UPDATE ON public.credit_access_draws
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();
