ALTER TABLE public.rent_amount_change_log
  ADD COLUMN IF NOT EXISTS old_duration_days integer,
  ADD COLUMN IF NOT EXISTS new_duration_days integer,
  ADD COLUMN IF NOT EXISTS old_access_fee numeric,
  ADD COLUMN IF NOT EXISTS new_access_fee numeric,
  ADD COLUMN IF NOT EXISTS old_request_fee numeric,
  ADD COLUMN IF NOT EXISTS new_request_fee numeric,
  ADD COLUMN IF NOT EXISTS old_daily_repayment numeric,
  ADD COLUMN IF NOT EXISTS new_daily_repayment numeric,
  ADD COLUMN IF NOT EXISTS changed_fields text[];

CREATE OR REPLACE FUNCTION public.log_rent_amount_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  fields text[] := ARRAY[]::text[];
BEGIN
  IF NEW.rent_amount IS DISTINCT FROM OLD.rent_amount THEN fields := fields || 'rent_amount'; END IF;
  IF NEW.duration_days IS DISTINCT FROM OLD.duration_days THEN fields := fields || 'duration_days'; END IF;
  IF NEW.access_fee IS DISTINCT FROM OLD.access_fee THEN fields := fields || 'access_fee'; END IF;
  IF NEW.request_fee IS DISTINCT FROM OLD.request_fee THEN fields := fields || 'request_fee'; END IF;
  IF NEW.total_repayment IS DISTINCT FROM OLD.total_repayment THEN fields := fields || 'total_repayment'; END IF;
  IF NEW.daily_repayment IS DISTINCT FROM OLD.daily_repayment THEN fields := fields || 'daily_repayment'; END IF;

  IF array_length(fields, 1) IS NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.rent_amount_change_log (
    rent_request_id, tenant_id, agent_id,
    old_rent_amount, new_rent_amount,
    old_total_repayment, new_total_repayment,
    old_amount_repaid, new_amount_repaid,
    old_duration_days, new_duration_days,
    old_access_fee, new_access_fee,
    old_request_fee, new_request_fee,
    old_daily_repayment, new_daily_repayment,
    changed_fields, status, changed_by
  ) VALUES (
    NEW.id, NEW.tenant_id, COALESCE(NEW.assigned_agent_id, NEW.agent_id),
    OLD.rent_amount, NEW.rent_amount,
    OLD.total_repayment, NEW.total_repayment,
    OLD.amount_repaid, NEW.amount_repaid,
    OLD.duration_days, NEW.duration_days,
    OLD.access_fee, NEW.access_fee,
    OLD.request_fee, NEW.request_fee,
    OLD.daily_repayment, NEW.daily_repayment,
    fields, NEW.status, auth.uid()
  );

  INSERT INTO public.system_events (event_type, user_id, metadata)
  VALUES (
    'rent_request_created',
    NEW.tenant_id,
    jsonb_build_object(
      'change', 'rent_fees_changed',
      'changed_fields', to_jsonb(fields),
      'rent_request_id', NEW.id,
      'old_rent_amount', OLD.rent_amount,
      'new_rent_amount', NEW.rent_amount,
      'old_duration_days', OLD.duration_days,
      'new_duration_days', NEW.duration_days,
      'old_total_repayment', OLD.total_repayment,
      'new_total_repayment', NEW.total_repayment,
      'changed_by', auth.uid()
    )
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_log_rent_amount_change ON public.rent_requests;
CREATE TRIGGER trg_log_rent_amount_change
AFTER UPDATE ON public.rent_requests
FOR EACH ROW EXECUTE FUNCTION public.log_rent_amount_change();