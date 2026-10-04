
SET lock_timeout = '3s';

CREATE OR REPLACE FUNCTION public.enforce_payouts_ui_flag_on_withdrawals()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_enabled boolean;
BEGIN
  IF NEW.landlord_payout_id IS NOT NULL OR NEW.proxy_partner_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT enabled INTO v_enabled
  FROM public.treasury_controls
  WHERE control_key = 'payouts_ui_enabled'
  LIMIT 1;

  IF COALESCE(v_enabled, false) = false THEN
    RAISE EXCEPTION 'Withdrawals are temporarily disabled by platform administrators. Please try again later.'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_payouts_ui_flag_on_withdrawals ON public.withdrawal_requests;
CREATE TRIGGER trg_enforce_payouts_ui_flag_on_withdrawals
BEFORE INSERT ON public.withdrawal_requests
FOR EACH ROW
EXECUTE FUNCTION public.enforce_payouts_ui_flag_on_withdrawals();
