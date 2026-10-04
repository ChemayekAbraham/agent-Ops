-- 1) Partial unique index on real (non-placeholder) transaction_ids
-- Excludes NULL, empty, and known placeholders so legitimate "missing TID" rows
-- can still coexist while real references are forced to be globally unique.
CREATE UNIQUE INDEX IF NOT EXISTS deposit_requests_unique_real_tid
  ON public.deposit_requests (UPPER(TRIM(transaction_id)))
  WHERE transaction_id IS NOT NULL
    AND TRIM(transaction_id) <> ''
    AND UPPER(TRIM(transaction_id)) NOT IN ('NONE','N/A','NA','PENDING','TBD','UNKNOWN');

-- 2) Speed up the trigger's notes-substring check.
CREATE INDEX IF NOT EXISTS deposit_requests_notes_lower_idx
  ON public.deposit_requests (LOWER(notes));

-- 3) Trigger that blocks duplicate references on insert/update.
-- Looks at BOTH transaction_id and notes (receipt-pasted matches), and
-- raises a friendly error pointing at the existing deposit.
CREATE OR REPLACE FUNCTION public.guard_deposit_reference_uniqueness()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ref TEXT;
  v_existing_id UUID;
  v_existing_status TEXT;
BEGIN
  v_ref := NULLIF(TRIM(COALESCE(NEW.transaction_id, '')), '');

  -- Skip placeholders and missing values entirely.
  IF v_ref IS NULL OR UPPER(v_ref) IN ('NONE','N/A','NA','PENDING','TBD','UNKNOWN') THEN
    RETURN NEW;
  END IF;

  -- On UPDATE: skip if the reference hasn't actually changed.
  IF TG_OP = 'UPDATE'
     AND COALESCE(UPPER(TRIM(OLD.transaction_id)), '') = UPPER(v_ref) THEN
    RETURN NEW;
  END IF;

  -- 3a) Another deposit already carries this exact reference?
  SELECT id, status INTO v_existing_id, v_existing_status
  FROM public.deposit_requests
  WHERE id <> COALESCE(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid)
    AND transaction_id IS NOT NULL
    AND UPPER(TRIM(transaction_id)) = UPPER(v_ref)
  LIMIT 1;

  IF v_existing_id IS NOT NULL THEN
    RAISE EXCEPTION
      'Reference % is already reconciled on deposit % (status: %). Each receipt/reference can only be matched once.',
      v_ref, v_existing_id, v_existing_status
      USING ERRCODE = 'unique_violation';
  END IF;

  -- 3b) Reference already embedded in another deposit's notes (receipt paste)?
  SELECT id, status INTO v_existing_id, v_existing_status
  FROM public.deposit_requests
  WHERE id <> COALESCE(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid)
    AND notes IS NOT NULL
    AND POSITION(LOWER(v_ref) IN LOWER(notes)) > 0
  LIMIT 1;

  IF v_existing_id IS NOT NULL THEN
    RAISE EXCEPTION
      'Reference % already appears on deposit % (status: %) via its receipt notes. Each receipt/reference can only be matched once.',
      v_ref, v_existing_id, v_existing_status
      USING ERRCODE = 'unique_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_deposit_reference_uniqueness ON public.deposit_requests;
CREATE TRIGGER trg_guard_deposit_reference_uniqueness
  BEFORE INSERT OR UPDATE OF transaction_id, notes ON public.deposit_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_deposit_reference_uniqueness();