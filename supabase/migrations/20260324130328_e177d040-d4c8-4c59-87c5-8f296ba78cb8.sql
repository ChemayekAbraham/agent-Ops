CREATE OR REPLACE FUNCTION public.trg_auto_log_fee_revenue()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'funded' AND (OLD.status IS NULL OR OLD.status != 'funded') THEN
    IF COALESCE(NEW.access_fee, 0) > 0 THEN
      INSERT INTO public.fee_revenue_ledger (rent_request_id, tenant_id, fee_type, total_amount, deferred_amount, status)
      VALUES (NEW.id, NEW.tenant_id, 'access_fee', NEW.access_fee, NEW.access_fee, 'deferred');
    END IF;
    IF COALESCE(NEW.platform_fee, 0) > 0 THEN
      INSERT INTO public.fee_revenue_ledger (rent_request_id, tenant_id, fee_type, total_amount, deferred_amount, status)
      VALUES (NEW.id, NEW.tenant_id, 'platform_fee', NEW.platform_fee, NEW.platform_fee, 'deferred');
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.trg_auto_log_default()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'defaulted' AND (OLD.status IS NULL OR OLD.status != 'defaulted') THEN
    INSERT INTO public.default_recovery_ledger (
      tenant_id, agent_id, rent_request_id, default_amount, status, default_date
    ) VALUES (
      NEW.tenant_id,
      COALESCE(NEW.assigned_agent_id, NEW.agent_id),
      NEW.id,
      COALESCE(NEW.rent_amount, 0),
      'defaulted',
      now()
    )
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;