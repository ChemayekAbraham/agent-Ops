-- 2026-10-28: Postgres WARNING "trg_recheck_payout_destinations_for_user: record "new" has no field "user_id"" (about 32/day, ongoing).
-- The trigger function used CASE WHEN TG_TABLE_NAME = 'profiles' THEN NEW.id ELSE NEW.user_id END. plpgsql resolves every field in the expression up front, and
-- profiles has no user_id column, so every profile change (national id name/photo/selfie/number) raised, the error was swallowed by the EXCEPTION block, and the
-- waiting payout destinations were never re-checked after a profile change. Now two branches. Applied to production 2026-10-28 by hand (CREATE OR REPLACE keeps grants).
CREATE OR REPLACE FUNCTION public.trg_recheck_payout_destinations_for_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  BEGIN
    IF TG_TABLE_NAME = 'profiles' THEN
      PERFORM public.auto_verify_waiting_payout_destinations(NEW.id);
    ELSE
      PERFORM public.auto_verify_waiting_payout_destinations(NEW.user_id);
    END IF;
  EXCEPTION WHEN others THEN
    RAISE WARNING 'trg_recheck_payout_destinations_for_user: %', SQLERRM;
  END;
  RETURN NULL;
END;
$function$;
