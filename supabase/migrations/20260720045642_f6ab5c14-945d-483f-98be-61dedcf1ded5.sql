
CREATE OR REPLACE FUNCTION public.enforce_no_duplicate_rent_request()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing_id uuid;
  v_existing_status text;
  v_existing_created timestamptz;
BEGIN
  IF NEW.tenant_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.status IN ('rejected','deleted_by_agent','completed','cancelled') THEN
    RETURN NEW;
  END IF;

  SELECT id, status, created_at
    INTO v_existing_id, v_existing_status, v_existing_created
  FROM public.rent_requests
  WHERE tenant_id = NEW.tenant_id
    AND id <> COALESCE(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid)
    AND status IN ('pending','tenant_ops_approved','agent_ops_approved','funded','repaying')
    AND COALESCE(schedule_status,'') <> 'cancelled'
    AND created_at >= now() - interval '14 days'
  ORDER BY created_at DESC
  LIMIT 1;

  IF v_existing_id IS NOT NULL THEN
    RAISE EXCEPTION
      'Duplicate rent request blocked: tenant already has an open request % (status=%, created=%). Cancel or complete it before creating another.',
      v_existing_id, v_existing_status, v_existing_created
    USING ERRCODE = 'unique_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_no_duplicate_rent_request ON public.rent_requests;
CREATE TRIGGER trg_enforce_no_duplicate_rent_request
BEFORE INSERT ON public.rent_requests
FOR EACH ROW
EXECUTE FUNCTION public.enforce_no_duplicate_rent_request();
