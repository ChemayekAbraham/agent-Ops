CREATE OR REPLACE FUNCTION public.enforce_no_duplicate_after_rejection()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_open record;
BEGIN
  IF NEW.status NOT IN ('pending', 'service_center_review') THEN
    RETURN NEW;
  END IF;
  IF NEW.tenant_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Renewals are exempt: a renewal re-posts a previously funded and fully
  -- repaid cycle for the same tenant/house.
  IF COALESCE(NEW.registration_type, '') = 'renewal' THEN
    RETURN NEW;
  END IF;

  SELECT id, rejected_reason, created_at, COALESCE(reopen_count, 0) AS reopen_count
    INTO v_open
    FROM public.rent_requests
   WHERE tenant_id = NEW.tenant_id
     AND status = 'rejected'
     AND COALESCE(reopen_count, 0) < 5
     -- Only a recent rejection is a real "resubmit this one instead" signal.
     AND created_at >= now() - interval '30 days'
   ORDER BY created_at DESC
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  -- Superseded rejection: the tenant already went on to a funded/repaying or
  -- completed cycle after that rejection, so it is history, not a pending fix.
  IF EXISTS (
    SELECT 1 FROM public.rent_requests r
     WHERE r.tenant_id = NEW.tenant_id
       AND r.created_at > v_open.created_at
       AND r.status IN ('funded', 'repaying', 'completed')
  ) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'DUPLICATE_AFTER_REJECTION: this tenant already has a rejected rent request (%). Open it and resubmit with the correction instead of creating a new one. Reviewer comment: %',
    v_open.id,
    COALESCE(NULLIF(btrim(v_open.rejected_reason), ''), 'not stated')
    USING ERRCODE = 'P0001', HINT = v_open.id::text;
END;
$$;