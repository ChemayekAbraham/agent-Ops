
-- Reconcile agent wallet balances to match their actual earnings
-- Formula: wallet_balance = agent_earnings_total - approved_withdrawals

-- First, fix Grace Paul's wallet specifically (and any other agents with mismatches)
WITH agent_calculations AS (
  SELECT 
    p.id as user_id,
    COALESCE(w.balance, 0) as current_balance,
    COALESCE((SELECT SUM(amount) FROM agent_earnings WHERE agent_id = p.id), 0) as total_earnings,
    COALESCE((SELECT SUM(amount) FROM agent_commission_payouts WHERE agent_id = p.id AND status = 'approved'), 0) as total_withdrawn,
    COALESCE((SELECT SUM(amount) FROM agent_earnings WHERE agent_id = p.id), 0) 
      - COALESCE((SELECT SUM(amount) FROM agent_commission_payouts WHERE agent_id = p.id AND status = 'approved'), 0) as expected_balance
  FROM profiles p
  JOIN user_roles ur ON ur.user_id = p.id AND ur.role = 'agent'
  LEFT JOIN wallets w ON w.user_id = p.id
)
UPDATE wallets w
SET 
  balance = ac.expected_balance,
  updated_at = now()
FROM agent_calculations ac
WHERE w.user_id = ac.user_id
  AND ac.current_balance < ac.expected_balance;

-- Create a function to keep agent wallet in sync with earnings
CREATE OR REPLACE FUNCTION sync_agent_wallet_on_earning()
RETURNS TRIGGER AS $$
BEGIN
  -- When a new earning is inserted, ensure wallet is updated
  IF TG_OP = 'INSERT' THEN
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
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Drop existing trigger if it exists
DROP TRIGGER IF EXISTS trg_sync_agent_wallet_on_earning ON agent_earnings;

-- Create trigger to auto-sync wallet on new earnings
CREATE TRIGGER trg_sync_agent_wallet_on_earning
AFTER INSERT ON agent_earnings
FOR EACH ROW
EXECUTE FUNCTION sync_agent_wallet_on_earning();
