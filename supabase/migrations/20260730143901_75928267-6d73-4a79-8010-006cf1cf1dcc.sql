CREATE OR REPLACE FUNCTION public.clamp_rent_request_amount_repaid()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.amount_repaid IS NULL THEN
    NEW.amount_repaid := 0;
  END IF;
  IF NEW.amount_repaid < 0 THEN
    NEW.amount_repaid := 0;
  END IF;
  IF COALESCE(NEW.total_repayment, 0) > 0 AND NEW.amount_repaid > NEW.total_repayment THEN
    NEW.amount_repaid := NEW.total_repayment;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_clamp_rent_request_amount_repaid ON public.rent_requests;
CREATE TRIGGER trg_clamp_rent_request_amount_repaid
BEFORE INSERT OR UPDATE ON public.rent_requests
FOR EACH ROW EXECUTE FUNCTION public.clamp_rent_request_amount_repaid();

-- Repair Mununuzi Alex's plan: no collection or repayment record exists,
-- the value came from a Tenant Ops correction that rewrote repaid instead of outstanding.
UPDATE public.rent_requests
SET amount_repaid = 0
WHERE id = '549263f7-ce0f-404a-a872-a84aae5ae28f';