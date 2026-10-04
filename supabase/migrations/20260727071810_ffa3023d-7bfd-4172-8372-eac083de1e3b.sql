
-- Gate: no rent request may be approved before its landlord is verified.

CREATE OR REPLACE FUNCTION public.enforce_landlord_verified_before_approval()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_approving_statuses text[] := ARRAY['approved','funded','repaying','disbursed','force_approved'];
  v_landlord_verified boolean;
  v_landlord_name text;
BEGIN
  -- Only care about transitions INTO an approving status.
  IF NEW.status IS NULL OR NOT (NEW.status = ANY (v_approving_statuses)) THEN
    RETURN NEW;
  END IF;

  -- If not actually changing status into approval, allow (idempotent updates).
  IF TG_OP = 'UPDATE'
     AND OLD.status IS NOT DISTINCT FROM NEW.status THEN
    RETURN NEW;
  END IF;

  IF NEW.landlord_id IS NULL THEN
    RAISE EXCEPTION 'LANDLORD_NOT_VERIFIED: rent request has no landlord attached'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT l.verified, COALESCE(l.full_name, l.name, 'landlord')
    INTO v_landlord_verified, v_landlord_name
  FROM public.landlords l
  WHERE l.id = NEW.landlord_id;

  IF v_landlord_verified IS NOT TRUE THEN
    RAISE EXCEPTION 'LANDLORD_NOT_VERIFIED: Landlord % is not yet verified. Approve the landlord first, then approve this rent request.', v_landlord_name
      USING ERRCODE = 'check_violation',
            HINT = 'Verify the landlord in Landlord Ops, then retry approval.';
  END IF;

  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_enforce_landlord_verified_before_approval ON public.rent_requests;
CREATE TRIGGER trg_enforce_landlord_verified_before_approval
BEFORE INSERT OR UPDATE OF status ON public.rent_requests
FOR EACH ROW
EXECUTE FUNCTION public.enforce_landlord_verified_before_approval();
