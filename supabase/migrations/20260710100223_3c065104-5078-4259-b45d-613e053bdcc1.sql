CREATE OR REPLACE FUNCTION public.credit_referral_bonus()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.referrer_id IS NULL OR NEW.referrer_id = NEW.id THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.referrals (referrer_id, referred_id, bonus_amount, credited)
  VALUES (NEW.referrer_id, NEW.id, 300, false)
  ON CONFLICT (referrer_id, referred_id) DO NOTHING;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'credit_referral_bonus failed for profile %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$function$;

ALTER TABLE public.referrals ALTER COLUMN bonus_amount SET DEFAULT 300;