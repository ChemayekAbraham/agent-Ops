
-- Simplify credit_referral_bonus: only insert referral record, let the referrals trigger handle wallet credits
CREATE OR REPLACE FUNCTION public.credit_referral_bonus()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.referrer_id IS NOT NULL THEN
    -- Insert referral record (ON CONFLICT prevents duplicates)
    -- The credit_signup_referral_bonus trigger on referrals table handles wallet credits
    INSERT INTO public.referrals (referrer_id, referred_id, bonus_amount, credited, credited_at)
    VALUES (NEW.referrer_id, NEW.id, 500, true, now())
    ON CONFLICT (referrer_id, referred_id) DO NOTHING;

    -- Create earnings record if referrer is an agent
    IF FOUND AND has_role(NEW.referrer_id, 'agent'::app_role) THEN
      INSERT INTO public.agent_earnings (agent_id, amount, earning_type, source_user_id, description)
      VALUES (NEW.referrer_id, 500, 'referral_bonus', NEW.id, 'New member registration bonus');
    END IF;
  END IF;
  
  RETURN NEW;
END;
$$;
