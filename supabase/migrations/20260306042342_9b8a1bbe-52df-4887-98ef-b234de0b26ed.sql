-- Fix: sync_agent_wallet_on_earning should NOT credit wallet for commission types
-- Those go through pending_wallet_operations → manager approval → general_ledger → wallet
CREATE OR REPLACE FUNCTION public.sync_agent_wallet_on_earning()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' 
     AND NEW.earning_type NOT IN ('referral_bonus', 'commission', 'subagent_commission') 
  THEN
    INSERT INTO public.wallets (user_id, balance, created_at, updated_at)
    VALUES (NEW.agent_id, NEW.amount, now(), now())
    ON CONFLICT (user_id) 
    DO UPDATE SET 
      balance = wallets.balance + NEW.amount,
      updated_at = now();
  END IF;
  
  RETURN NEW;
END;
$$;