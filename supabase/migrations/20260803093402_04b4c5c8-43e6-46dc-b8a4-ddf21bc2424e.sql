CREATE OR REPLACE FUNCTION public.enforce_single_rent_disbursement()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_net integer;
BEGIN
  IF NEW.category <> 'rent_disbursement'
     OR NEW.ledger_scope <> 'platform'
     OR NEW.direction <> 'cash_out'
     OR NEW.source_table <> 'rent_requests'
     OR NEW.source_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(SUM(CASE WHEN direction = 'cash_out' THEN 1 ELSE -1 END), 0)
    INTO v_net
  FROM public.general_ledger
  WHERE source_id = NEW.source_id
    AND source_table = 'rent_requests'
    AND category = 'rent_disbursement'
    AND ledger_scope = 'platform';

  IF v_net >= 1 THEN
    RAISE EXCEPTION 'Rent request % is already funded in the ledger (duplicate rent_disbursement blocked)', NEW.source_id
      USING ERRCODE = 'unique_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_single_rent_disbursement ON public.general_ledger;
CREATE TRIGGER trg_enforce_single_rent_disbursement
BEFORE INSERT ON public.general_ledger
FOR EACH ROW EXECUTE FUNCTION public.enforce_single_rent_disbursement();