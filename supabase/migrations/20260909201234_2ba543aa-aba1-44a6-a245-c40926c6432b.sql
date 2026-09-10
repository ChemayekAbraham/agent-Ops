-- Create the referral record for anyone who joins with a referrer, so the
-- existing trg_credit_signup_referral_bonus trigger credits UGX 100.
CREATE OR REPLACE FUNCTION public.ensure_referral_record_on_profile()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.referrer_id IS NULL OR NEW.referrer_id = NEW.id THEN
    RETURN NEW;
  END IF;

  -- Only act when the referrer is newly present (insert, or first time set).
  IF TG_OP = 'UPDATE' AND OLD.referrer_id IS NOT DISTINCT FROM NEW.referrer_id THEN
    RETURN NEW;
  END IF;

  BEGIN
    IF EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = NEW.referrer_id
        AND COALESCE(p.is_frozen, FALSE) = FALSE
    ) THEN
      INSERT INTO public.referrals (referrer_id, referred_id, bonus_amount, restricted_amount)
      VALUES (NEW.referrer_id, NEW.id, 100, 100)
      ON CONFLICT (referrer_id, referred_id) DO NOTHING;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- Never block profile creation / update because of the referral record.
    RAISE WARNING 'ensure_referral_record_on_profile failed for % (referrer %): %',
      NEW.id, NEW.referrer_id, SQLERRM;
  END;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_ensure_referral_record ON public.profiles;
CREATE TRIGGER trg_ensure_referral_record
  AFTER INSERT OR UPDATE OF referrer_id ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.ensure_referral_record_on_profile();