CREATE OR REPLACE FUNCTION public.enforce_no_duplicate_after_rejection()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_open record;
BEGIN
  -- Only guard fresh, agent-created submissions entering the pipeline.
  IF NEW.status NOT IN ('pending', 'service_center_review') THEN
    RETURN NEW;
  END IF;
  IF NEW.tenant_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT id, rejected_reason, COALESCE(reopen_count, 0) AS reopen_count
    INTO v_open
    FROM public.rent_requests
   WHERE tenant_id = NEW.tenant_id
     AND status = 'rejected'
     AND COALESCE(reopen_count, 0) < 5
   ORDER BY created_at DESC
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'DUPLICATE_AFTER_REJECTION: this tenant already has a rejected rent request (%). Open it and resubmit with the correction instead of creating a new one. Reviewer comment: %',
      v_open.id,
      COALESCE(NULLIF(btrim(v_open.rejected_reason), ''), 'not stated')
      USING ERRCODE = 'P0001', HINT = v_open.id::text;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_no_duplicate_after_rejection ON public.rent_requests;
CREATE TRIGGER trg_no_duplicate_after_rejection
BEFORE INSERT ON public.rent_requests
FOR EACH ROW EXECUTE FUNCTION public.enforce_no_duplicate_after_rejection();