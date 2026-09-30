CREATE OR REPLACE FUNCTION public.auto_repaying_on_landlord_payment()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.rent_request_id IS NULL
     OR COALESCE(NEW.paid_out_amount,0) <= 0
     OR (TG_OP = 'UPDATE' AND COALESCE(OLD.paid_out_amount,0) >= COALESCE(NEW.paid_out_amount,0)) THEN
    RETURN NEW;
  END IF;

  -- Clear a stale "Not paying" flag: the landlord has just been paid, so the plan is live.
  UPDATE public.rent_requests
     SET agent_payment_status = 'paying',
         agent_payment_status_reason = 'Auto: landlord payment recorded',
         agent_payment_status_set_at = now()
   WHERE id = NEW.rent_request_id
     AND agent_payment_status = 'not_paying'
     AND status IN ('funded','disbursed','approved','repaying');

  -- Move funded plans with money still owing to Repaying. Never blocks the payout.
  BEGIN
    UPDATE public.rent_requests
       SET status = 'repaying'
     WHERE id = NEW.rent_request_id
       AND status IN ('funded','disbursed')
       AND COALESCE(amount_repaid,0) < COALESCE(total_repayment,0);
  EXCEPTION WHEN others THEN
    RAISE WARNING 'auto_repaying_on_landlord_payment: status not changed for %: %', NEW.rent_request_id, SQLERRM;
  END;

  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION public.auto_repaying_on_landlord_payment() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_auto_repaying_on_landlord_payment ON public.agent_landlord_float_allocations;
CREATE TRIGGER trg_auto_repaying_on_landlord_payment
AFTER INSERT OR UPDATE OF paid_out_amount ON public.agent_landlord_float_allocations
FOR EACH ROW EXECUTE FUNCTION public.auto_repaying_on_landlord_payment();