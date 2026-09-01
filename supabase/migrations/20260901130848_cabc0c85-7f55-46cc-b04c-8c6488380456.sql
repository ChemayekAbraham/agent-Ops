CREATE OR REPLACE FUNCTION public.guard_house_listing_verification_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_staff boolean;
  v_sc_manager boolean;
BEGIN
  IF v_uid IS NULL THEN
    RETURN NEW;
  END IF;

  -- Nested write from another trigger (bonus payers) — trusted server path.
  IF pg_trigger_depth() > 1 THEN
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

  SELECT EXISTS (
    SELECT 1 FROM public.service_center_managers m
    WHERE m.agent_id = v_uid
      AND m.status = 'active'
      AND m.revoked_at IS NULL
  ) INTO v_sc_manager;

  -- The manager this listing was actually routed to counts too: routing is set
  -- server-side, so an assigned reviewer is as trusted as a tagged one.
  IF NOT v_sc_manager THEN
    v_sc_manager := OLD.service_center_manager_id = v_uid;
  END IF;

  IF v_sc_manager THEN
    IF NEW.listed_bonus_paid IS DISTINCT FROM OLD.listed_bonus_paid
       OR NEW.house_verified_bonus_paid IS DISTINCT FROM OLD.house_verified_bonus_paid THEN
      RAISE EXCEPTION 'HOUSE_VERIFICATION_FORBIDDEN: bonus-payment fields on a house listing are set automatically and cannot be edited';
    END IF;
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
$function$;