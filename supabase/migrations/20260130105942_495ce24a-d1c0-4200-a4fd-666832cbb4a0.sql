
-- Fix 1: Update the sync_agent_wallet_on_earning trigger to SKIP referral_bonus types
-- (those are already credited by the referrals table trigger)
CREATE OR REPLACE FUNCTION public.sync_agent_wallet_on_earning()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  -- When a new earning is inserted, ensure wallet is updated
  -- SKIP referral_bonus type since it's already credited by the referrals trigger
  IF TG_OP = 'INSERT' AND NEW.earning_type != 'referral_bonus' THEN
    -- Upsert wallet with the earning amount
    INSERT INTO public.wallets (user_id, balance, created_at, updated_at)
    VALUES (NEW.agent_id, NEW.amount, now(), now())
    ON CONFLICT (user_id) 
    DO UPDATE SET 
      balance = wallets.balance + NEW.amount,
      updated_at = now();
  END IF;
  
  RETURN NEW;
END;
$function$;

-- Fix 2: Recalculate ALL wallet balances based on correct sources
-- Formula: (referrer_bonuses) + (welcome_bonuses) + (agent_earnings EXCLUDING referral_bonus) - (approved_withdrawals)
WITH correct_balances AS (
  SELECT 
    p.id as user_id,
    -- Referral bonuses (500 each as referrer)
    COALESCE((
      SELECT COUNT(*) * 500 
      FROM referrals r 
      WHERE r.referrer_id = p.id AND r.credited = true
    ), 0) as referrer_bonus,
    -- Welcome bonus (500 if they were referred)
    COALESCE((
      SELECT COUNT(*) * 500 
      FROM referrals r 
      WHERE r.referred_id = p.id AND r.credited = true
    ), 0) as welcome_bonus,
    -- Agent earnings EXCLUDING referral_bonus (to avoid double count)
    COALESCE((
      SELECT SUM(amount) 
      FROM agent_earnings ae 
      WHERE ae.agent_id = p.id AND ae.earning_type != 'referral_bonus'
    ), 0) as other_earnings,
    -- Approved withdrawals (subtract)
    COALESCE((
      SELECT SUM(amount) 
      FROM agent_commission_payouts acp 
      WHERE acp.agent_id = p.id AND acp.status = 'approved'
    ), 0) as withdrawals
  FROM profiles p
),
final_balances AS (
  SELECT 
    user_id,
    GREATEST(0, referrer_bonus + welcome_bonus + other_earnings - withdrawals) as correct_balance
  FROM correct_balances
)
UPDATE wallets w
SET 
  balance = fb.correct_balance,
  updated_at = now()
FROM final_balances fb
WHERE w.user_id = fb.user_id
AND w.balance != fb.correct_balance;

-- Log how many were fixed
DO $$
DECLARE
  fixed_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO fixed_count
  FROM wallets w
  JOIN (
    SELECT 
      p.id as user_id,
      GREATEST(0, 
        COALESCE((SELECT COUNT(*) * 500 FROM referrals r WHERE r.referrer_id = p.id AND r.credited = true), 0) +
        COALESCE((SELECT COUNT(*) * 500 FROM referrals r WHERE r.referred_id = p.id AND r.credited = true), 0) +
        COALESCE((SELECT SUM(amount) FROM agent_earnings ae WHERE ae.agent_id = p.id AND ae.earning_type != 'referral_bonus'), 0) -
        COALESCE((SELECT SUM(amount) FROM agent_commission_payouts acp WHERE acp.agent_id = p.id AND acp.status = 'approved'), 0)
      ) as correct_balance
    FROM profiles p
  ) calc ON calc.user_id = w.user_id
  WHERE w.balance != calc.correct_balance;
  
  RAISE NOTICE 'Wallet balance recalculation complete. Checked all wallets.';
END $$;
