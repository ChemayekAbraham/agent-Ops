
DROP TRIGGER IF EXISTS trg_credit_referral_bonus ON public.profiles;
COMMENT ON FUNCTION public.credit_referral_bonus() IS
  'RETIRED 2026-07-20: previously attached to profiles AFTER INSERT; wrote to inert wallets.balance and pre-set referrals.credited=true, blocking the ledger-based path. Kept unattached for historical reference only.';

CREATE OR REPLACE FUNCTION public.credit_signup_referral_bonus()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM public.try_credit_qualified_referrals(NEW.referred_id);
  RETURN NEW;
END;
$function$;

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT rf.id, rf.referred_id
      FROM public.referrals rf
      JOIN public.profiles p ON p.id = rf.referrer_id
     WHERE rf.credited = true
       AND rf.bonus_amount > 0
       AND rf.referrer_id IS NOT NULL
       AND rf.referrer_id <> rf.referred_id
       AND COALESCE(p.is_frozen, false) = false
       AND NOT EXISTS (
         SELECT 1 FROM public.general_ledger gl
          WHERE gl.idempotency_key = 'referral_signup:' || rf.id::text
       )
  LOOP
    UPDATE public.referrals
       SET credited = false, credited_at = NULL
     WHERE id = r.id;

    PERFORM public.try_credit_qualified_referrals(r.referred_id);
  END LOOP;
END $$;
