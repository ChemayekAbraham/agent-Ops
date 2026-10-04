ALTER TABLE public.agent_advances
  ADD COLUMN IF NOT EXISTS access_fee NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS access_fee_collected NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS access_fee_status TEXT DEFAULT 'unpaid';

-- Validation trigger for access_fee_status
CREATE OR REPLACE FUNCTION public.validate_access_fee_status()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.access_fee_status NOT IN ('unpaid', 'partial', 'settled') THEN
    RAISE EXCEPTION 'Invalid access_fee_status: %. Must be unpaid, partial, or settled.', NEW.access_fee_status;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_access_fee_status ON public.agent_advances;
CREATE TRIGGER trg_validate_access_fee_status
  BEFORE INSERT OR UPDATE ON public.agent_advances
  FOR EACH ROW EXECUTE FUNCTION public.validate_access_fee_status();