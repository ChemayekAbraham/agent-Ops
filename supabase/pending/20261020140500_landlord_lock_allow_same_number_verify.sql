CREATE OR REPLACE FUNCTION public.lock_landlord_number_at_cfo_stage()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_phone_same boolean := public.landlord_number_norm(COALESCE(NEW.phone,'')) IS NOT DISTINCT FROM public.landlord_number_norm(COALESCE(OLD.phone,''));
  v_mm_same boolean := public.landlord_number_norm(COALESCE(NEW.mobile_money_number,'')) IS NOT DISTINCT FROM public.landlord_number_norm(COALESCE(OLD.mobile_money_number,''));
  v_ver_same boolean := public.landlord_number_norm(COALESCE(NEW.verified_mobile_money_number,'')) IS NOT DISTINCT FROM public.landlord_number_norm(COALESCE(OLD.verified_mobile_money_number,''));
BEGIN
  IF v_phone_same AND v_mm_same AND v_ver_same THEN RETURN NEW; END IF;
  -- Verification confirming the number already on file is not a number change.
  IF v_phone_same AND v_mm_same AND COALESCE(NEW.verified_mobile_money_number,'') <> ''
     AND public.landlord_number_norm(NEW.verified_mobile_money_number) IN (
           public.landlord_number_norm(COALESCE(OLD.phone,'')),
           public.landlord_number_norm(COALESCE(OLD.mobile_money_number,''))) THEN
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM public.rent_requests r WHERE r.landlord_id = OLD.id
       AND (r.coo_reviewed_at IS NOT NULL OR r.cfo_reviewed_at IS NOT NULL OR r.status IN ('funded','repaying'))
       AND r.status NOT IN ('cancelled','rejected','deleted_by_agent','completed')) THEN
    RAISE EXCEPTION 'This landlord''s number is locked because a Rent Plan has reached the CFO stage. It can only change if that Rent Plan is cancelled.' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $function$;
