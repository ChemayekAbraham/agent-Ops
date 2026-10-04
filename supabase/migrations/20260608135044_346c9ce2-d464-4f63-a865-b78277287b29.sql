-- Split landlord registration bonus into instant (1,000) + post-verification (4,000)
-- Add idempotency markers on landlords for the registration bonus program.

ALTER TABLE public.landlords
  ADD COLUMN IF NOT EXISTS registration_bonus_paid boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS registration_bonus_paid_at timestamptz,
  ADD COLUMN IF NOT EXISTS registration_verification_bonus_paid boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS registration_verification_bonus_paid_at timestamptz;

-- Trigger: pay the UGX 4,000 verification leg to the registering agent when a
-- landlord is verified by Landlord Ops. Only fires if the instant UGX 1,000
-- registration leg was already paid (registration_bonus_paid = true), so
-- landlords onboarded before the split (who already received the full 5,000)
-- are never paid an extra 4,000.
CREATE OR REPLACE FUNCTION public.pay_landlord_registration_verified_bonus()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.verified = true
     AND (OLD.verified IS DISTINCT FROM true)
     AND NEW.registered_by IS NOT NULL
     AND COALESCE(NEW.registration_bonus_paid, false) = true
     AND COALESCE(NEW.registration_verification_bonus_paid, false) = false
  THEN
    PERFORM public.create_ledger_transaction(
      jsonb_build_array(
        jsonb_build_object(
          'user_id', NEW.registered_by,
          'amount', 4000,
          'direction', 'cash_in',
          'category', 'agent_commission',
          'ledger_scope', 'wallet',
          'recipient_type', 'user',
          'source_table', 'landlords',
          'source_id', NEW.id::text,
          'description', 'UGX 4,000 landlord registration verification bonus - ' || COALESCE(NEW.name, 'landlord'),
          'currency', 'UGX'
        ),
        jsonb_build_object(
          'user_id', NEW.registered_by,
          'amount', 4000,
          'direction', 'cash_out',
          'category', 'marketing_expense',
          'ledger_scope', 'platform',
          'source_table', 'landlords',
          'source_id', NEW.id::text,
          'description', 'Platform expense: landlord registration verification bonus - ' || COALESCE(NEW.name, 'landlord'),
          'currency', 'UGX'
        )
      ),
      'landlord_reg_verify:' || NEW.id::text
    );

    UPDATE public.landlords
      SET registration_verification_bonus_paid = true,
          registration_verification_bonus_paid_at = now()
      WHERE id = NEW.id;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_pay_landlord_registration_verified_bonus ON public.landlords;
CREATE TRIGGER trg_pay_landlord_registration_verified_bonus
  AFTER UPDATE OF verified ON public.landlords
  FOR EACH ROW
  EXECUTE FUNCTION public.pay_landlord_registration_verified_bonus();