-- Create supporter referrals table to track who invited whom
CREATE TABLE public.supporter_referrals (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  referrer_id UUID NOT NULL,
  referred_id UUID NOT NULL UNIQUE,
  bonus_amount NUMERIC DEFAULT 5000,
  bonus_credited BOOLEAN DEFAULT false,
  bonus_credited_at TIMESTAMP WITH TIME ZONE,
  first_investment_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.supporter_referrals ENABLE ROW LEVEL SECURITY;

-- Policies for supporter referrals
CREATE POLICY "Users can view their own referrals"
ON public.supporter_referrals
FOR SELECT
USING (auth.uid() = referrer_id OR auth.uid() = referred_id);

CREATE POLICY "System can insert referrals"
ON public.supporter_referrals
FOR INSERT
WITH CHECK (auth.uid() = referred_id);

-- Create function to credit referral bonus when first investment is made
CREATE OR REPLACE FUNCTION public.credit_supporter_referral_bonus()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  referral_record RECORD;
  referrer_wallet_balance NUMERIC;
BEGIN
  -- Check if this is the user's first investment (funding an investment account)
  -- We check if the investment_accounts balance increased from 0
  IF NEW.balance > 0 AND OLD.balance = 0 THEN
    -- Find if this user was referred
    SELECT * INTO referral_record
    FROM supporter_referrals
    WHERE referred_id = NEW.user_id
      AND bonus_credited = false
      AND first_investment_at IS NULL;
    
    IF FOUND THEN
      -- Mark the first investment
      UPDATE supporter_referrals
      SET first_investment_at = now()
      WHERE id = referral_record.id;
      
      -- Get referrer's wallet balance
      SELECT balance INTO referrer_wallet_balance
      FROM wallets
      WHERE user_id = referral_record.referrer_id;
      
      -- Credit the referrer's wallet
      IF referrer_wallet_balance IS NOT NULL THEN
        UPDATE wallets
        SET balance = balance + referral_record.bonus_amount
        WHERE user_id = referral_record.referrer_id;
        
        -- Mark bonus as credited
        UPDATE supporter_referrals
        SET bonus_credited = true,
            bonus_credited_at = now()
        WHERE id = referral_record.id;
        
        -- Send notification to referrer
        INSERT INTO notifications (user_id, title, message, type, metadata)
        VALUES (
          referral_record.referrer_id,
          '🎉 Referral Bonus Earned!',
          'Your referred supporter made their first investment. ' || referral_record.bonus_amount || ' UGX has been added to your wallet!',
          'earning',
          jsonb_build_object('referral_id', referral_record.id, 'bonus_amount', referral_record.bonus_amount)
        );
      END IF;
    END IF;
  END IF;
  
  RETURN NEW;
END;
$$;

-- Create trigger on investment_accounts
CREATE TRIGGER on_first_investment_credit_referral
  AFTER UPDATE ON public.investment_accounts
  FOR EACH ROW
  EXECUTE FUNCTION public.credit_supporter_referral_bonus();