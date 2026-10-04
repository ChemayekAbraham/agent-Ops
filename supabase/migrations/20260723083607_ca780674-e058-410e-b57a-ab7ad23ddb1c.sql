DROP TRIGGER IF EXISTS trg_referral_activation_landlord ON public.landlords;
CREATE TRIGGER trg_referral_activation_landlord
  AFTER INSERT ON public.landlords
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_referral_activation_registered_by();

DROP TRIGGER IF EXISTS trg_referral_activation_lc1 ON public.lc1_chairpersons;
CREATE TRIGGER trg_referral_activation_lc1
  AFTER INSERT ON public.lc1_chairpersons
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_referral_activation_registered_by();

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
     AND COALESCE(NEW.registration_verification_bonus_paid, false) = false
  THEN
    PERFORM public.create_ledger_transaction(
      jsonb_build_array(
        jsonb_build_object('user_id', NEW.registered_by,'amount',5000,'direction','cash_in','category','agent_commission','ledger_scope','wallet','recipient_type','user','source_table','landlords','source_id',NEW.id::text,'description','UGX 5,000 landlord registration bonus — landlord verified: ' || COALESCE(NEW.name, 'landlord'),'currency','UGX'),
        jsonb_build_object('user_id', NEW.registered_by,'amount',5000,'direction','cash_out','category','marketing_expense','ledger_scope','platform','source_table','landlords','source_id',NEW.id::text,'description','Platform expense: landlord registration bonus (verified) — ' || COALESCE(NEW.name, 'landlord'),'currency','UGX')
      ),
      'landlord_reg_verify_v2:' || NEW.id::text
    );

    UPDATE public.landlords
      SET registration_verification_bonus_paid = true,
          registration_verification_bonus_paid_at = now()
      WHERE id = NEW.id;
  END IF;

  RETURN NEW;
END;
$function$;