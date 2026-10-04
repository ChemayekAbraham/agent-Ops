CREATE TABLE IF NOT EXISTS public.rent_amount_change_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rent_request_id uuid NOT NULL,
  tenant_id uuid,
  agent_id uuid,
  old_rent_amount numeric,
  new_rent_amount numeric,
  old_total_repayment numeric,
  new_total_repayment numeric,
  old_amount_repaid numeric,
  new_amount_repaid numeric,
  status text,
  changed_by uuid,
  changed_at timestamptz NOT NULL DEFAULT now(),
  notified_at timestamptz
);

GRANT SELECT ON public.rent_amount_change_log TO authenticated;
GRANT ALL ON public.rent_amount_change_log TO service_role;

ALTER TABLE public.rent_amount_change_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Ops can view rent amount changes" ON public.rent_amount_change_log;
CREATE POLICY "Ops can view rent amount changes"
ON public.rent_amount_change_log FOR SELECT TO authenticated
USING (
  public.has_role(auth.uid(), 'manager'::public.app_role)
  OR public.has_role(auth.uid(), 'operations'::public.app_role)
  OR public.has_role(auth.uid(), 'coo'::public.app_role)
  OR public.has_role(auth.uid(), 'cfo'::public.app_role)
  OR public.has_role(auth.uid(), 'ceo'::public.app_role)
  OR public.has_role(auth.uid(), 'cto'::public.app_role)
  OR public.has_role(auth.uid(), 'super_admin'::public.app_role)
);

CREATE INDEX IF NOT EXISTS idx_rent_amount_change_log_pending
  ON public.rent_amount_change_log (changed_at) WHERE notified_at IS NULL;

CREATE OR REPLACE FUNCTION public.log_rent_amount_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.rent_amount IS DISTINCT FROM OLD.rent_amount THEN
    INSERT INTO public.rent_amount_change_log (
      rent_request_id, tenant_id, agent_id,
      old_rent_amount, new_rent_amount,
      old_total_repayment, new_total_repayment,
      old_amount_repaid, new_amount_repaid,
      status, changed_by
    ) VALUES (
      NEW.id, NEW.tenant_id, COALESCE(NEW.assigned_agent_id, NEW.agent_id),
      OLD.rent_amount, NEW.rent_amount,
      OLD.total_repayment, NEW.total_repayment,
      OLD.amount_repaid, NEW.amount_repaid,
      NEW.status, auth.uid()
    );

    INSERT INTO public.system_events (event_type, user_id, metadata)
    VALUES (
      'rent_request_created',
      NEW.tenant_id,
      jsonb_build_object(
        'change', 'rent_amount_changed',
        'rent_request_id', NEW.id,
        'old_rent_amount', OLD.rent_amount,
        'new_rent_amount', NEW.rent_amount,
        'changed_by', auth.uid()
      )
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_log_rent_amount_change ON public.rent_requests;
CREATE TRIGGER trg_log_rent_amount_change
AFTER UPDATE OF rent_amount ON public.rent_requests
FOR EACH ROW EXECUTE FUNCTION public.log_rent_amount_change();