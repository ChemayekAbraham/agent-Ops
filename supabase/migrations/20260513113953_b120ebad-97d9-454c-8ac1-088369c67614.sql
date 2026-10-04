CREATE OR REPLACE FUNCTION public.enforce_outstanding_total_repayment()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_principal numeric;
  v_days integer;
BEGIN
  IF NEW.registration_type IS DISTINCT FROM 'outstanding_balance' THEN
    RETURN NEW;
  END IF;

  v_principal := COALESCE(NEW.initial_outstanding_balance, NEW.total_repayment, 0);
  v_days := GREATEST(COALESCE(NEW.duration_days, 30), 1);

  IF v_principal <= 0 THEN
    NEW.total_repayment := COALESCE(NEW.total_repayment, 0);
    NEW.daily_repayment := COALESCE(NEW.daily_repayment, 0);
    RETURN NEW;
  END IF;

  NEW.total_repayment := v_principal;
  NEW.daily_repayment := CEIL(v_principal / v_days);

  RETURN NEW;
END;
$$;