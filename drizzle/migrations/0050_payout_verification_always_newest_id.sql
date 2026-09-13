-- Keep national_id_submitted_at truthful for EVERY edit path, not just the
-- submit_national_id RPC: any direct profiles.national_id change re-stamps the
-- user's payout destination rows so the FinOps queue (and withdraw prompt) stay
-- newest-first after edits and resubmissions.
CREATE OR REPLACE FUNCTION public.stamp_payout_destination_id_submitted_at()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.national_id IS DISTINCT FROM OLD.national_id
     AND coalesce(btrim(NEW.national_id), '') <> '' THEN
    UPDATE public.payout_destination_verifications d
    SET national_id = upper(btrim(NEW.national_id)),
        national_id_name = coalesce(nullif(btrim(NEW.national_id_name), ''), d.national_id_name),
        national_id_submitted_at = now()
    WHERE d.user_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_stamp_payout_destination_id_submitted_at ON public.profiles;
CREATE TRIGGER trg_stamp_payout_destination_id_submitted_at
AFTER UPDATE OF national_id ON public.profiles
FOR EACH ROW
EXECUTE FUNCTION public.stamp_payout_destination_id_submitted_at();