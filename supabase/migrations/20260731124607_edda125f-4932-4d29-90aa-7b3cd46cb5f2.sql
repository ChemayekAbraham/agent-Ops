CREATE OR REPLACE FUNCTION public.pay_lc1_registration_verified_bonus()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  IF NEW.verified = true
     AND (OLD.verified IS DISTINCT FROM true)
     AND NEW.registered_by IS NOT NULL
     AND COALESCE(NEW.registration_verification_bonus_paid, false) = false
  THEN
    PERFORM public.create_ledger_transaction(
      jsonb_build_array(
        jsonb_build_object('user_id', NEW.registered_by,'amount',2000,'direction','cash_in','category','agent_commission','ledger_scope','wallet','recipient_type','user','source_table','lc1_chairpersons','source_id',NEW.id::text,'description','UGX 2,000 LC1 chairperson registration bonus — verified: ' || COALESCE(NEW.name, 'LC1 chairperson'),'currency','UGX'),
        jsonb_build_object('user_id', NEW.registered_by,'amount',2000,'direction','cash_out','category','marketing_expense','ledger_scope','platform','source_table','lc1_chairpersons','source_id',NEW.id::text,'description','Platform expense: LC1 chairperson registration bonus (verified) — ' || COALESCE(NEW.name, 'LC1 chairperson'),'currency','UGX')
      ),
      'lc1_reg_verify_v1:' || NEW.id::text
    );

    UPDATE public.lc1_chairpersons
      SET registration_verification_bonus_paid = true,
          registration_verification_bonus_paid_at = now()
      WHERE id = NEW.id;
  END IF;

  RETURN NEW;
END;
$fn$;

INSERT INTO public.system_config (key, value, updated_at)
VALUES ('agent_perf_gate_disabled_until', to_jsonb((now() + interval '1 hour')::text), now())
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();