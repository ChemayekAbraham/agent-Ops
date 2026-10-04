
-- Fix: Only credit the referrer, not the new user
CREATE OR REPLACE FUNCTION public.credit_signup_referral_bonus()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  signup_bonus NUMERIC := 500;
BEGIN
  -- Only process if not already credited
  IF NEW.credited = true AND (OLD IS NULL OR OLD.credited = false) THEN
    
    -- Ensure referrer has a wallet
    INSERT INTO wallets (user_id, balance)
    VALUES (NEW.referrer_id, 0)
    ON CONFLICT (user_id) DO NOTHING;
    
    -- Credit ONLY the referrer's wallet
    UPDATE wallets
    SET balance = balance + signup_bonus,
        updated_at = now()
    WHERE user_id = NEW.referrer_id;
    
    -- Notify referrer only
    INSERT INTO notifications (user_id, title, message, type, metadata)
    VALUES (
      NEW.referrer_id,
      '🎉 Referral Bonus!',
      'You earned ' || signup_bonus || ' UGX for referring a new user!',
      'earning',
      jsonb_build_object('referral_id', NEW.id, 'bonus_amount', signup_bonus, 'referred_id', NEW.referred_id)
    );
    
  END IF;
  
  RETURN NEW;
END;
$$;
