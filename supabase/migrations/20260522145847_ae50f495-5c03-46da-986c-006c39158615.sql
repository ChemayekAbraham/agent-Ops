-- Auto landlord monthly payout: schema for rent_requests
ALTER TABLE public.rent_requests
  ADD COLUMN IF NOT EXISTS landlord_payout_day smallint,
  ADD COLUMN IF NOT EXISTS landlord_payout_next_run_at timestamptz,
  ADD COLUMN IF NOT EXISTS landlord_payout_last_run_at timestamptz,
  ADD COLUMN IF NOT EXISTS landlord_payout_enabled boolean NOT NULL DEFAULT true;

-- Validation trigger (not CHECK, per project rules favoring triggers for time-aware constraints)
CREATE OR REPLACE FUNCTION public.validate_landlord_payout_day()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.landlord_payout_day IS NOT NULL
     AND (NEW.landlord_payout_day < 1 OR NEW.landlord_payout_day > 28) THEN
    RAISE EXCEPTION 'landlord_payout_day must be between 1 and 28 (got %)', NEW.landlord_payout_day;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_landlord_payout_day ON public.rent_requests;
CREATE TRIGGER trg_validate_landlord_payout_day
BEFORE INSERT OR UPDATE OF landlord_payout_day ON public.rent_requests
FOR EACH ROW EXECUTE FUNCTION public.validate_landlord_payout_day();

-- Hot-path index for cron picker
CREATE INDEX IF NOT EXISTS idx_rent_requests_landlord_payout_due
  ON public.rent_requests (landlord_payout_next_run_at)
  WHERE landlord_payout_enabled = true AND landlord_payout_day IS NOT NULL;

COMMENT ON COLUMN public.rent_requests.landlord_payout_day IS 'Day of month (1-28) Welile pays landlord wallet, set by agent at placement';
COMMENT ON COLUMN public.rent_requests.landlord_payout_next_run_at IS 'Next scheduled landlord payout. Advanced by 1 month after each successful payout.';