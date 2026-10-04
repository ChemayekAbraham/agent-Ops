
CREATE OR REPLACE FUNCTION public.enforce_outstanding_total_repayment()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_principal numeric;
  v_days integer;
  v_computed record;
BEGIN
  IF NEW.registration_type IS DISTINCT FROM 'outstanding_balance' THEN
    RETURN NEW;
  END IF;

  v_principal := COALESCE(NEW.initial_outstanding_balance, 0);
  v_days := COALESCE(NEW.outstanding_grace_days, NEW.duration_days, 30);

  IF v_principal <= 0 THEN
    RETURN NEW;
  END IF;

  -- Recompute when total_repayment is missing, zero, or smaller than the
  -- raw outstanding principal (which means fees were not applied).
  IF COALESCE(NEW.total_repayment, 0) <= 0
     OR COALESCE(NEW.total_repayment, 0) < v_principal THEN
    SELECT * INTO v_computed
    FROM public.compute_outstanding_repayment(v_principal, v_days);

    NEW.total_repayment := v_computed.total_repayment;
    NEW.daily_repayment := v_computed.daily_repayment;
  END IF;

  RETURN NEW;
END;
$$;
