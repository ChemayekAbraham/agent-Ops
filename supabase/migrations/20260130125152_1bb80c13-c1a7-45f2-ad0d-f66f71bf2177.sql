
-- Create a trigger function to automatically create referral records when a new profile has a referrer_id
CREATE OR REPLACE FUNCTION public.handle_referral_on_signup()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  -- Only process if there's a referrer_id and it's a new user (INSERT)
  IF NEW.referrer_id IS NOT NULL THEN
    -- Check if a referral record already exists to prevent duplicates
    IF NOT EXISTS (
      SELECT 1 FROM public.referrals 
      WHERE referrer_id = NEW.referrer_id 
      AND referred_id = NEW.id
    ) THEN
      -- Create the referral record with bonus credited
      INSERT INTO public.referrals (
        referrer_id, 
        referred_id, 
        bonus_amount, 
        credited, 
        credited_at
      )
      VALUES (
        NEW.referrer_id,
        NEW.id,
        500,  -- Standard referral bonus
        true,
        now()
      );
    END IF;
  END IF;
  
  RETURN NEW;
END;
$$;

-- Create the trigger on profiles table
DROP TRIGGER IF EXISTS trg_handle_referral_on_signup ON public.profiles;

CREATE TRIGGER trg_handle_referral_on_signup
  AFTER INSERT ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_referral_on_signup();

-- Also create a trigger for updates (in case referrer_id is set later)
DROP TRIGGER IF EXISTS trg_handle_referral_on_update ON public.profiles;

CREATE TRIGGER trg_handle_referral_on_update
  AFTER UPDATE OF referrer_id ON public.profiles
  FOR EACH ROW
  WHEN (OLD.referrer_id IS NULL AND NEW.referrer_id IS NOT NULL)
  EXECUTE FUNCTION public.handle_referral_on_signup();
