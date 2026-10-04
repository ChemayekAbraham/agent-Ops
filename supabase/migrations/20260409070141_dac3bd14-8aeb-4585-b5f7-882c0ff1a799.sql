CREATE OR REPLACE FUNCTION public.credit_referral_bonus()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_referrer_role TEXT;
  v_new_user_role TEXT;
  v_bonus_amount NUMERIC := 500;
BEGIN
  -- Only process if the new profile has a referrer
  IF NEW.referrer_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Check if referrer is an agent
  SELECT role INTO v_referrer_role
  FROM public.profiles
  WHERE id = NEW.referrer_id;

  -- Check the new user's role from user_roles table (profiles has no role column)
  SELECT role INTO v_new_user_role
  FROM public.user_roles
  WHERE user_id = NEW.id
  LIMIT 1;

  -- If the referrer is an agent and new user is also an agent (sub-agent registration),
  -- set bonus to 0 because activate-supporter RPC handles the 10,000 bonus
  IF v_referrer_role = 'agent' AND v_new_user_role = 'agent' THEN
    v_bonus_amount := 0;
  END IF;

  -- Create referral record (idempotent: unique constraint on referred_user_id)
  INSERT INTO public.referrals (
    referrer_id,
    referred_user_id,
    bonus_amount,
    credited
  ) VALUES (
    NEW.referrer_id,
    NEW.id,
    v_bonus_amount,
    CASE WHEN v_bonus_amount > 0 THEN TRUE ELSE FALSE END
  )
  ON CONFLICT (referred_user_id) DO NOTHING;

  RETURN NEW;
END;
$$;