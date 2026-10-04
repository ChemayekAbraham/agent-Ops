CREATE OR REPLACE FUNCTION public.enforce_landlord_verified_before_approval()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_approving_statuses text[] := ARRAY['approved','funded','repaying','disbursed','force_approved'];
  v_landlord_verified boolean;
  v_landlord_name text;
BEGIN
  IF NEW.status IS NULL OR NOT (NEW.status = ANY (v_approving_statuses)) THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.status IS NOT DISTINCT FROM NEW.status THEN
    RETURN NEW;
  END IF;

  IF NEW.landlord_id IS NULL THEN
    RAISE EXCEPTION 'LANDLORD_NOT_VERIFIED: rent request has no landlord attached'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT l.verified, COALESCE(l.name, 'landlord')
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
$function$;