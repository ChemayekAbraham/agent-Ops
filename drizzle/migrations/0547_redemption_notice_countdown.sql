ALTER TABLE public.portfolio_action_requests
  ADD COLUMN IF NOT EXISTS processing_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS notice_ends_on date;

CREATE OR REPLACE FUNCTION public.set_redemption_notice_countdown()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.request_type = 'REDEMPTION_REQUEST'
     AND NEW.status = 'processing'
     AND NEW.processing_started_at IS NULL THEN
    NEW.processing_started_at := now();
    NEW.notice_ends_on := ((now() AT TIME ZONE 'Africa/Kampala')::date + 90);
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_set_redemption_notice_countdown ON public.portfolio_action_requests;
CREATE TRIGGER trg_set_redemption_notice_countdown
BEFORE INSERT OR UPDATE OF status ON public.portfolio_action_requests
FOR EACH ROW EXECUTE FUNCTION public.set_redemption_notice_countdown();