
CREATE OR REPLACE FUNCTION public.enforce_tiered_advance_rate()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_completed_count INT;
  v_expected_rate NUMERIC;
  v_recompute_fees BOOLEAN := false;
BEGIN
  SELECT COUNT(*) INTO v_completed_count
  FROM public.agent_advances
  WHERE agent_id = NEW.agent_id
    AND status = 'completed';

  v_expected_rate := CASE WHEN v_completed_count > 0 THEN 0.28 ELSE 0.33 END;

  IF NEW.monthly_rate IS DISTINCT FROM v_expected_rate THEN
    NEW.monthly_rate := v_expected_rate;
    v_recompute_fees := true;
  END IF;

  IF v_recompute_fees AND NEW.principal IS NOT NULL AND NEW.cycle_days IS NOT NULL THEN
    NEW.access_fee := ROUND(NEW.principal * v_expected_rate * (NEW.cycle_days::NUMERIC / 30.0));
    NEW.total_payable := NEW.principal + COALESCE(NEW.access_fee,0) + COALESCE(NEW.registration_fee,0);
    IF NEW.cycle_days > 0 THEN
      NEW.daily_payment := ROUND(NEW.total_payable / NEW.cycle_days);
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_tiered_advance_rate ON public.agent_advance_requests;
CREATE TRIGGER trg_enforce_tiered_advance_rate
BEFORE INSERT ON public.agent_advance_requests
FOR EACH ROW EXECUTE FUNCTION public.enforce_tiered_advance_rate();
