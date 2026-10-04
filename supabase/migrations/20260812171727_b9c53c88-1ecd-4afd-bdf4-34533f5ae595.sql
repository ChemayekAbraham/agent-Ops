CREATE OR REPLACE FUNCTION public.advance_landlord_payout_on_withdrawal_completion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.landlord_payout_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.status NOT IN ('completed','paid') THEN
    RETURN NEW;
  END IF;

  IF OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;

  UPDATE public.landlord_payouts lp
  SET status = 'awaiting_agent_receipt',
      disbursed_at = COALESCE(lp.disbursed_at, now()),
      external_reference = COALESCE(lp.external_reference, NEW.transaction_id),
      metadata = COALESCE(lp.metadata, '{}'::jsonb) || jsonb_build_object(
        'advanced_by_withdrawal_completion', jsonb_build_object(
          'withdrawal_request_id', NEW.id,
          'at', now(),
          'previous_status', lp.status
        )
      ),
      updated_at = now()
  WHERE lp.id = NEW.landlord_payout_id
    AND lp.status IN ('otp_verified','pending_merchant_payout','pending_finops_disbursement','disbursing');

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_advance_landlord_payout_on_withdrawal_completion ON public.withdrawal_requests;

CREATE TRIGGER trg_advance_landlord_payout_on_withdrawal_completion
AFTER UPDATE OF status ON public.withdrawal_requests
FOR EACH ROW
EXECUTE FUNCTION public.advance_landlord_payout_on_withdrawal_completion();