ALTER TABLE public.merchandise_sales ADD COLUMN IF NOT EXISTS settlement_completed_at timestamptz;
ALTER TABLE public.merchandise_sales ADD COLUMN IF NOT EXISTS settlement_certificate_issued_at timestamptz;

CREATE OR REPLACE FUNCTION public.merchandise_sync_completion()
 RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public'
AS $function$
DECLARE v_is_bike boolean := lower(COALESCE(NEW.item_name,'')) LIKE '%spiro%';
BEGIN
  IF lower(COALESCE(NEW.order_status,'')) = 'issued'
     AND COALESCE(NEW.amount_outstanding, 0) <= 0 THEN
    NEW.order_status := 'completed';
  ELSIF v_is_bike
     AND lower(COALESCE(NEW.order_status,'')) IN ('approved','processing')
     AND NEW.cfo_disbursed_at IS NOT NULL
     AND COALESCE(NEW.amount_paid, 0) > 0
     AND COALESCE(NEW.amount_outstanding, 0) <= 0 THEN
    -- Electric bike lease fully repaid: close it and issue the settlement certificate.
    NEW.order_status := 'completed';
    NEW.amount_outstanding := 0;
    NEW.payment_status := 'paid';
  ELSIF lower(COALESCE(NEW.order_status,'')) = 'completed'
     AND COALESCE(NEW.amount_outstanding, 0) > 0 THEN
    NEW.order_status := CASE WHEN v_is_bike THEN 'approved' ELSE 'issued' END;
    IF v_is_bike THEN NEW.settlement_completed_at := NULL; NEW.settlement_certificate_issued_at := NULL; END IF;
  END IF;
  IF v_is_bike AND NEW.order_status = 'completed' AND NEW.settlement_completed_at IS NULL THEN
    NEW.settlement_completed_at := now();
    NEW.settlement_certificate_issued_at := now();
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_bike_plan_complete_at_zero()
 RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public'
AS $function$
BEGIN
  IF COALESCE(NEW.is_bike_lease,false) AND NEW.status = 'active'
     AND COALESCE(NEW.outstanding_balance,0) <= 0 AND COALESCE(NEW.amount_recovered,0) > 0 THEN
    NEW.status := 'completed';
    NEW.outstanding_balance := 0;
    NEW.completed_at := COALESCE(NEW.completed_at, now());
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_bike_plan_complete_at_zero ON public.merchandise_recovery_plans;
CREATE TRIGGER trg_bike_plan_complete_at_zero BEFORE UPDATE ON public.merchandise_recovery_plans
FOR EACH ROW EXECUTE FUNCTION public.trg_bike_plan_complete_at_zero();

CREATE OR REPLACE FUNCTION public.trg_bike_plan_completed_notify()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  IF COALESCE(NEW.is_bike_lease,false) AND NEW.status = 'completed' AND OLD.status IS DISTINCT FROM 'completed' THEN
    IF NEW.sale_id IS NOT NULL THEN
      UPDATE public.merchandise_sales SET amount_outstanding = 0, payment_status = 'paid', updated_at = now()
       WHERE id = NEW.sale_id AND (COALESCE(amount_outstanding,0) <> 0 OR order_status <> 'completed');
    END IF;
    INSERT INTO public.system_events (event_type, user_id, metadata)
    VALUES ('payment_made', NEW.customer_id, jsonb_build_object('kind','bike_lease_settled','plan_id',NEW.id,'sale_id',NEW.sale_id));
    INSERT INTO public.notifications (user_id, title, message, type, link_path)
    VALUES (NEW.customer_id, 'Bike lease fully settled',
      'Your ' || COALESCE(NEW.item_name,'bike') || ' lease is fully paid. Your settlement certificate is ready and you can now take new products.',
      'success', '/agent');
  END IF;
  RETURN NEW;
EXCEPTION WHEN others THEN
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_bike_plan_completed_notify ON public.merchandise_recovery_plans;
CREATE TRIGGER trg_bike_plan_completed_notify AFTER UPDATE OF status ON public.merchandise_recovery_plans
FOR EACH ROW EXECUTE FUNCTION public.trg_bike_plan_completed_notify();