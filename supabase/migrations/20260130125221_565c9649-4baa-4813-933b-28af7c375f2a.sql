
-- Remove the duplicate triggers I just created (the existing credit_referral_bonus handles this)
DROP TRIGGER IF EXISTS trg_handle_referral_on_signup ON public.profiles;
DROP TRIGGER IF EXISTS trg_handle_referral_on_update ON public.profiles;
DROP FUNCTION IF EXISTS public.handle_referral_on_signup();
