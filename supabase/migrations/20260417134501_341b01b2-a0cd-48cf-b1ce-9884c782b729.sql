-- Auto-update parent withdrawal_request when payout_code is marked paid
CREATE OR REPLACE FUNCTION public.sync_withdrawal_on_payout_paid()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Only act when status transitions to 'paid'
  IF NEW.status = 'paid' AND (OLD.status IS DISTINCT FROM 'paid') THEN
    UPDATE public.withdrawal_requests
    SET 
      status = 'approved',
      processed_at = COALESCE(processed_at, NEW.paid_at, now()),
      processed_by = COALESCE(processed_by, NEW.paid_by),
      updated_at = now()
    WHERE id = NEW.withdrawal_request_id
      AND status NOT IN ('approved', 'completed', 'rejected', 'cancelled');
  END IF;
  
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_withdrawal_on_payout_paid ON public.payout_codes;

CREATE TRIGGER trg_sync_withdrawal_on_payout_paid
AFTER UPDATE ON public.payout_codes
FOR EACH ROW
EXECUTE FUNCTION public.sync_withdrawal_on_payout_paid();