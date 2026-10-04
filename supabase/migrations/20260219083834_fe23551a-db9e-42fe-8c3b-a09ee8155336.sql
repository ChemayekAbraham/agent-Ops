
-- Enforce one withdrawal request per user per calendar day (EAT = UTC+3)
CREATE OR REPLACE FUNCTION public.enforce_one_withdrawal_per_day()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  existing_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO existing_count
  FROM public.withdrawal_requests
  WHERE user_id = NEW.user_id
    AND status = 'pending'
    AND DATE(created_at AT TIME ZONE 'Africa/Nairobi') = DATE(NOW() AT TIME ZONE 'Africa/Nairobi');

  IF existing_count > 0 THEN
    RAISE EXCEPTION 'You have already submitted a withdrawal request today. Only one withdrawal is allowed per day.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_one_withdrawal_per_day ON public.withdrawal_requests;

CREATE TRIGGER trg_enforce_one_withdrawal_per_day
  BEFORE INSERT ON public.withdrawal_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_one_withdrawal_per_day();
