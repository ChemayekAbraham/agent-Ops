CREATE OR REPLACE FUNCTION public.enforce_rent_request_formula()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_canon RECORD;
BEGIN
  IF NEW.registration_type = 'outstanding_balance' THEN
    NEW.access_fee  := 0;
    NEW.request_fee := 0;
    RETURN NEW;
  END IF;

  IF NEW.rent_amount IS NULL OR NEW.rent_amount <= 0
     OR NEW.duration_days IS NULL OR NEW.duration_days <= 0 THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_canon FROM public.compute_rent_repayment(NEW.rent_amount, NEW.duration_days);

  NEW.access_fee      := v_canon.access_fee;
  NEW.request_fee     := v_canon.request_fee;
  NEW.total_repayment := v_canon.total_repayment;
  NEW.daily_repayment := v_canon.daily_repayment;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.auto_activate_outstanding_rent_request()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.registration_type <> 'outstanding_balance' THEN
    RETURN NEW;
  END IF;

  NEW.status               := 'repaying';
  NEW.tenancy_status       := COALESCE(NEW.tenancy_status, 'active');
  NEW.approved_at          := COALESCE(NEW.approved_at,  now());
  NEW.funded_at            := COALESCE(NEW.funded_at,    now());
  NEW.disbursed_at         := COALESCE(NEW.disbursed_at, now());
  NEW.agent_ops_reviewed_at    := COALESCE(NEW.agent_ops_reviewed_at,    now());
  NEW.tenant_ops_reviewed_at   := COALESCE(NEW.tenant_ops_reviewed_at,   now());
  NEW.landlord_ops_reviewed_at := COALESCE(NEW.landlord_ops_reviewed_at, now());
  NEW.coo_reviewed_at          := COALESCE(NEW.coo_reviewed_at,          now());
  NEW.cfo_reviewed_at          := COALESCE(NEW.cfo_reviewed_at,          now());

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_auto_activate_outstanding_rent_request ON public.rent_requests;
CREATE TRIGGER trg_auto_activate_outstanding_rent_request
  BEFORE INSERT ON public.rent_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.auto_activate_outstanding_rent_request();

CREATE OR REPLACE FUNCTION public.create_outstanding_subscription_charge()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_grace INTEGER;
  v_total NUMERIC;
  v_days  INTEGER;
  v_daily NUMERIC;
  v_start DATE := CURRENT_DATE;
  v_next  DATE;
  v_end   DATE;
BEGIN
  IF NEW.registration_type <> 'outstanding_balance' THEN
    RETURN NEW;
  END IF;

  v_total := COALESCE(NEW.total_repayment, NEW.initial_outstanding_balance, 0);
  v_days  := GREATEST(COALESCE(NEW.duration_days, 0), 1);
  v_grace := GREATEST(COALESCE(NEW.outstanding_grace_days, 0), 0);
  v_daily := COALESCE(NEW.daily_repayment, CEIL(v_total / v_days));

  v_next := v_start + GREATEST(v_grace, 1);
  v_end  := v_start + v_days + v_grace;

  INSERT INTO public.subscription_charges (
    tenant_id, rent_request_id, agent_id, service_type,
    charge_amount, frequency, next_charge_date, start_date, end_date,
    total_charges_due, charges_remaining, status, charge_agent_wallet
  ) VALUES (
    NEW.tenant_id, NEW.id, NEW.agent_id, 'rent_facilitation',
    v_daily, 'daily', v_next, v_start, v_end,
    v_total, v_days, 'active', COALESCE(NEW.tenant_no_smartphone, false)
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_create_outstanding_subscription_charge ON public.rent_requests;
CREATE TRIGGER trg_create_outstanding_subscription_charge
  AFTER INSERT ON public.rent_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.create_outstanding_subscription_charge();