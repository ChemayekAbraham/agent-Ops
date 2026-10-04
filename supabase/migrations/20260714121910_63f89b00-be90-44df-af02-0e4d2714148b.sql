CREATE OR REPLACE FUNCTION public.pay_landlord_registration_verified_bonus()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  -- Pay the full UGX 5,000 landlord-registration bonus ONLY on verification.
  -- The instant-signup bonus has been retired — agents earn nothing until
  -- Landlord Ops confirms the landlord is real.
  IF NEW.verified = true
     AND (OLD.verified IS DISTINCT FROM true)
     AND NEW.registered_by IS NOT NULL
     AND COALESCE(NEW.registration_verification_bonus_paid, false) = false
  THEN
    PERFORM public.create_ledger_transaction(
      jsonb_build_array(
        jsonb_build_object(
          'user_id', NEW.registered_by,
          'amount', 5000,
          'direction', 'cash_in',
          'category', 'agent_commission',
          'ledger_scope', 'wallet',
          'recipient_type', 'user',
          'source_table', 'landlords',
          'source_id', NEW.id::text,
          'description', 'UGX 5,000 landlord registration verification bonus - ' || COALESCE(NEW.name, 'landlord'),
          'currency', 'UGX'
        ),
        jsonb_build_object(
          'user_id', NEW.registered_by,
          'amount', 5000,
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