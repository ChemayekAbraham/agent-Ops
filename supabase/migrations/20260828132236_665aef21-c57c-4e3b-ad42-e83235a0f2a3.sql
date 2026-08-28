CREATE OR REPLACE FUNCTION public.guard_house_listing_verification_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_staff boolean;
BEGIN
  -- Server-side / trusted contexts (triggers, edge functions, cron) have no auth.uid()
  IF v_uid IS NULL THEN
    RETURN NEW;
  END IF;

  v_staff := public.has_role(v_uid, 'landlord_ops')
          OR public.has_role(v_uid, 'agent_ops')
          OR public.has_role(v_uid, 'tenant_ops')
          OR public.has_role(v_uid, 'operations')
          OR public.has_role(v_uid, 'financial_ops')
          OR public.has_role(v_uid, 'manager')
          OR public.has_role(v_uid, 'coo')
          OR public.has_role(v_uid, 'ceo')
          OR public.has_role(v_uid, 'cfo')
          OR public.has_role(v_uid, 'super_admin')
          OR public.has_role(v_uid, 'admin');

  IF v_staff THEN
    RETURN NEW;
  END IF;

  IF NEW.verified IS DISTINCT FROM OLD.verified
     OR NEW.verified_by IS DISTINCT FROM OLD.verified_by
     OR NEW.verified_at IS DISTINCT FROM OLD.verified_at
     OR NEW.listed_bonus_paid IS DISTINCT FROM OLD.listed_bonus_paid
     OR NEW.house_verified_bonus_paid IS DISTINCT FROM OLD.house_verified_bonus_paid
     OR NEW.service_center_status IS DISTINCT FROM OLD.service_center_status THEN
    RAISE EXCEPTION 'HOUSE_VERIFICATION_FORBIDDEN: only operations staff may change verification or bonus-payment fields on a house listing';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_house_listing_verification ON public.house_listings;
CREATE TRIGGER trg_guard_house_listing_verification
BEFORE UPDATE ON public.house_listings
FOR EACH ROW
EXECUTE FUNCTION public.guard_house_listing_verification_columns();