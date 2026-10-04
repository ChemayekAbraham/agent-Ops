-- Create referrals table to track agent signups
CREATE TABLE public.referrals (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  referrer_id UUID NOT NULL,
  referred_id UUID NOT NULL,
  bonus_amount NUMERIC NOT NULL DEFAULT 100,
  credited BOOLEAN NOT NULL DEFAULT false,
  credited_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.referrals ENABLE ROW LEVEL SECURITY;

-- Agents can view their own referrals
CREATE POLICY "Agents can view own referrals"
ON public.referrals
FOR SELECT
USING (auth.uid() = referrer_id);

-- Managers can view all referrals
CREATE POLICY "Managers can view all referrals"
ON public.referrals
FOR SELECT
USING (has_role(auth.uid(), 'manager'::app_role));

-- System can insert referrals
CREATE POLICY "System can insert referrals"
ON public.referrals
FOR INSERT
WITH CHECK (true);

-- System can update referrals
CREATE POLICY "System can update referrals"
ON public.referrals
FOR UPDATE
USING (true);

-- Add referrer_id column to profiles to track who referred them
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS referrer_id UUID;

-- Create function to credit referrer when user completes signup
CREATE OR REPLACE FUNCTION public.credit_referral_bonus()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  bonus_amount NUMERIC := 100;
BEGIN
  -- Only process if referrer_id is set and is an agent
  IF NEW.referrer_id IS NOT NULL AND has_role(NEW.referrer_id, 'agent'::app_role) THEN
    -- Create referral record
    INSERT INTO public.referrals (referrer_id, referred_id, bonus_amount, credited, credited_at)
    VALUES (NEW.referrer_id, NEW.id, bonus_amount, true, now());
    
    -- Credit agent's wallet
    UPDATE public.wallets
    SET balance = balance + bonus_amount,
        updated_at = now()
    WHERE user_id = NEW.referrer_id;
    
    -- Create earnings record
    INSERT INTO public.agent_earnings (agent_id, amount, earning_type, source_user_id, description)
    VALUES (NEW.referrer_id, bonus_amount, 'referral_bonus', NEW.id, 'New member registration bonus');
    
    -- Notify the agent
    INSERT INTO public.notifications (user_id, title, message, type, metadata)
    VALUES (
      NEW.referrer_id,
      'New Referral Bonus!',
      'You earned UGX ' || bonus_amount || ' for registering a new member.',
      'success',
      jsonb_build_object('referred_user_id', NEW.id, 'bonus_amount', bonus_amount)
    );
  END IF;
  
  RETURN NEW;
END;
$$;

-- Create trigger for referral bonus
DROP TRIGGER IF EXISTS on_profile_referral ON public.profiles;
CREATE TRIGGER on_profile_referral
  AFTER INSERT ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.credit_referral_bonus();