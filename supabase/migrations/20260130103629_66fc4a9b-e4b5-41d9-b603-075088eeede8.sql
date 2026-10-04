-- Create function to credit signup bonus when referral is created
CREATE OR REPLACE FUNCTION public.credit_signup_referral_bonus()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  signup_bonus NUMERIC := 500;
  referrer_wallet_id UUID;
  referred_wallet_id UUID;
BEGIN
  -- Only process if not already credited
  IF NEW.credited = true AND (OLD IS NULL OR OLD.credited = false) THEN
    
    -- Ensure referrer has a wallet (create if not exists)
    INSERT INTO wallets (user_id, balance)
    VALUES (NEW.referrer_id, 0)
    ON CONFLICT (user_id) DO NOTHING;
    
    -- Ensure referred user has a wallet (create if not exists)
    INSERT INTO wallets (user_id, balance)
    VALUES (NEW.referred_id, 0)
    ON CONFLICT (user_id) DO NOTHING;
    
    -- Credit the referrer's wallet
    UPDATE wallets
    SET balance = balance + signup_bonus,
        updated_at = now()
    WHERE user_id = NEW.referrer_id;
    
    -- Credit the referred user's wallet (new signup gets bonus too)
    UPDATE wallets
    SET balance = balance + signup_bonus,
        updated_at = now()
    WHERE user_id = NEW.referred_id;
    
    -- Create notification for referrer
    INSERT INTO notifications (user_id, title, message, type, metadata)
    VALUES (
      NEW.referrer_id,
      '🎉 Referral Bonus!',
      'You earned ' || signup_bonus || ' UGX for referring a new user!',
      'earning',
      jsonb_build_object('referral_id', NEW.id, 'bonus_amount', signup_bonus, 'referred_id', NEW.referred_id)
    );
    
    -- Create notification for new user
    INSERT INTO notifications (user_id, title, message, type, metadata)
    VALUES (
      NEW.referred_id,
      '🎁 Welcome Bonus!',
      'You received ' || signup_bonus || ' UGX welcome bonus in your wallet!',
      'earning',
      jsonb_build_object('referral_id', NEW.id, 'bonus_amount', signup_bonus)
    );
    
  END IF;
  
  RETURN NEW;
END;
$function$;

-- Create trigger for INSERT (new referrals that are immediately credited)
DROP TRIGGER IF EXISTS trg_credit_signup_bonus_insert ON referrals;
CREATE TRIGGER trg_credit_signup_bonus_insert
  AFTER INSERT ON referrals
  FOR EACH ROW
  WHEN (NEW.credited = true)
  EXECUTE FUNCTION credit_signup_referral_bonus();

-- Create trigger for UPDATE (when credited changes from false to true)
DROP TRIGGER IF EXISTS trg_credit_signup_bonus_update ON referrals;
CREATE TRIGGER trg_credit_signup_bonus_update
  AFTER UPDATE ON referrals
  FOR EACH ROW
  WHEN (NEW.credited = true AND OLD.credited = false)
  EXECUTE FUNCTION credit_signup_referral_bonus();

-- IMPORTANT: Fix existing users who have credited=true but 0 balance
-- Credit all referred users who should have received the bonus
UPDATE wallets w
SET balance = balance + 500,
    updated_at = now()
FROM referrals r
WHERE r.referred_id = w.user_id
  AND r.credited = true
  AND w.balance = 0;

-- Credit all referrers for their referrals
UPDATE wallets w
SET balance = w.balance + (
  SELECT COALESCE(COUNT(*) * 500, 0)
  FROM referrals r
  WHERE r.referrer_id = w.user_id
    AND r.credited = true
)
WHERE EXISTS (
  SELECT 1 FROM referrals r 
  WHERE r.referrer_id = w.user_id AND r.credited = true
);