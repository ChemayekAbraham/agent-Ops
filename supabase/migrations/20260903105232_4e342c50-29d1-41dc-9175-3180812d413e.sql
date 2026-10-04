CREATE OR REPLACE FUNCTION public.enforce_roi_cycle_once()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_cycle_anchor text;
  v_cycle_key text;
  v_correction_key text;
  v_credited_exists boolean;
  v_open_pending_exists boolean;
BEGIN
  IF NEW.category IS DISTINCT FROM 'roi_payout'
     OR NEW.source_table IS DISTINCT FROM 'investor_portfolios'
     OR NEW.source_id IS NULL THEN
    RETURN NEW;
  END IF;

  v_correction_key := nullif(btrim(COALESCE(NEW.metadata->>'correction_key', '')), '');

  SELECT COALESCE(
           nullif(btrim(COALESCE(NEW.metadata->>'cycle_anchor', '')), ''),
           next_roi_date::text,
           to_char(now(), 'YYYY-MM-DD')
         )
    INTO v_cycle_anchor
    FROM public.investor_portfolios
   WHERE id = NEW.source_id;

  IF v_cycle_anchor IS NULL THEN
    v_cycle_anchor := to_char(now(), 'YYYY-MM-DD');
  END IF;

  v_cycle_key := CASE
    WHEN v_correction_key IS NOT NULL
      THEN 'roi-cycle-correction-' || v_correction_key
    ELSE 'roi-cycle-' || NEW.source_id::text || '-' || v_cycle_anchor
  END;

  SELECT EXISTS (
    SELECT 1 FROM public.general_ledger
     WHERE idempotency_key = v_cycle_key
  ) INTO v_credited_exists;

  IF v_credited_exists THEN
    RAISE EXCEPTION 'Duplicate ROI payout blocked: portfolio % already received its ROI for the % cycle.', NEW.source_id, v_cycle_anchor
      USING ERRCODE = 'unique_violation';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.pending_wallet_operations pwo
     WHERE pwo.source_id = NEW.source_id
       AND pwo.source_table = 'investor_portfolios'
       AND pwo.category = 'roi_payout'
       AND pwo.status IN ('pending', 'pending_coo_approval', 'coo_approved', 'awaiting_verification')
       AND (TG_OP <> 'INSERT' OR pwo.id IS DISTINCT FROM NEW.id)
       AND (
         v_correction_key IS NULL
         OR pwo.metadata->>'correction_key' = v_correction_key
       )
  ) INTO v_open_pending_exists;

  IF v_open_pending_exists THEN
    RAISE EXCEPTION 'Duplicate ROI payout blocked: portfolio % already has an ROI payout awaiting approval for the % cycle.', NEW.source_id, v_cycle_anchor
      USING ERRCODE = 'unique_violation';
  END IF;

  RETURN NEW;
END;
$function$;