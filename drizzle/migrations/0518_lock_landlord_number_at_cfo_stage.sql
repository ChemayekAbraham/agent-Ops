CREATE OR REPLACE FUNCTION public.lock_landlord_number_at_cfo_stage()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF public.landlord_number_norm(COALESCE(NEW.phone,'')) IS NOT DISTINCT FROM public.landlord_number_norm(COALESCE(OLD.phone,''))
     AND public.landlord_number_norm(COALESCE(NEW.mobile_money_number,'')) IS NOT DISTINCT FROM public.landlord_number_norm(COALESCE(OLD.mobile_money_number,''))
     AND public.landlord_number_norm(COALESCE(NEW.verified_mobile_money_number,'')) IS NOT DISTINCT FROM public.landlord_number_norm(COALESCE(OLD.verified_mobile_money_number,'')) THEN
    RETURN NEW;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.rent_requests r
     WHERE r.landlord_id = OLD.id
       AND (r.coo_reviewed_at IS NOT NULL OR r.cfo_reviewed_at IS NOT NULL OR r.status IN ('funded','repaying'))
       AND r.status NOT IN ('cancelled','rejected','deleted_by_agent','completed')
  ) THEN
    RAISE EXCEPTION 'This landlord''s number is locked because a Rent Plan has reached the CFO stage. It can only change if that Rent Plan is cancelled.'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_a0_lock_landlord_number_cfo_stage ON public.landlords;
CREATE TRIGGER trg_a0_lock_landlord_number_cfo_stage
BEFORE UPDATE OF phone, mobile_money_number, verified_mobile_money_number ON public.landlords
FOR EACH ROW EXECUTE FUNCTION public.lock_landlord_number_at_cfo_stage();