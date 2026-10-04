CREATE OR REPLACE FUNCTION public.guard_rent_request_agent_updates()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RETURN NEW;
  END IF;

  IF public.is_sensitive_field_editor(v_uid)
     OR public.has_role(v_uid, 'manager'::app_role) THEN
    RETURN NEW;
  END IF;

  IF NOT (public.has_role(v_uid, 'agent'::app_role)
          OR public.has_role(v_uid, 'senior_agent'::app_role)
          OR public.has_role(v_uid, 'sub_agent'::app_role)) THEN
    RETURN NEW;
  END IF;

  NEW.approved_by := OLD.approved_by;
  NEW.approved_at := OLD.approved_at;
  NEW.funded_at := OLD.funded_at;
  NEW.disbursed_at := OLD.disbursed_at;
  NEW.fund_routed_at := OLD.fund_routed_at;
  NEW.fund_recipient_id := OLD.fund_recipient_id;
  NEW.fund_recipient_type := OLD.fund_recipient_type;
  NEW.fund_recipient_name := OLD.fund_recipient_name;
  NEW.manager_verified := OLD.manager_verified;
  NEW.manager_verified_at := OLD.manager_verified_at;
  NEW.manager_verified_by := OLD.manager_verified_by;
  NEW.amount_repaid := OLD.amount_repaid;
  NEW.last_payment_amount := OLD.last_payment_amount;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
      NEW.status IN ('pending', 'rejected', 'deleted_by_agent')
      OR (OLD.status = 'rejected' AND NEW.status = 'repaying')
    ) THEN
      RAISE EXCEPTION 'Agents cannot move a rent request from % to %', OLD.status, NEW.status
        USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_rent_request_agent_updates ON public.rent_requests;
CREATE TRIGGER trg_guard_rent_request_agent_updates
BEFORE UPDATE ON public.rent_requests
FOR EACH ROW EXECUTE FUNCTION public.guard_rent_request_agent_updates();

DROP POLICY IF EXISTS "Agents and managers can verify unverified requests" ON public.rent_requests;
CREATE POLICY "Agents and managers can verify unverified requests"
ON public.rent_requests FOR UPDATE TO authenticated
USING (
  agent_verified = false
  AND status = ANY (ARRAY['pending'::text, 'approved'::text])
  AND (
    has_role(auth.uid(), 'manager'::app_role)
    OR (
      (has_role(auth.uid(), 'agent'::app_role) OR has_role(auth.uid(), 'senior_agent'::app_role))
      AND (agent_id IS NULL OR agent_id = auth.uid() OR agent_verified_by = auth.uid())
    )
  )
)
WITH CHECK (
  has_role(auth.uid(), 'manager'::app_role)
  OR has_role(auth.uid(), 'agent'::app_role)
  OR has_role(auth.uid(), 'senior_agent'::app_role)
);

DROP POLICY IF EXISTS "Agents can verify their requests" ON public.rent_requests;
CREATE POLICY "Agents can verify their requests"
ON public.rent_requests FOR UPDATE TO authenticated
USING (has_role(auth.uid(), 'agent'::app_role) AND agent_id = auth.uid())
WITH CHECK (has_role(auth.uid(), 'agent'::app_role) AND agent_id = auth.uid());

DROP POLICY IF EXISTS "Agents can edit own rejected requests" ON public.rent_requests;
CREATE POLICY "Agents can edit own rejected requests"
ON public.rent_requests FOR UPDATE TO authenticated
USING (
  has_role(auth.uid(), 'agent'::app_role)
  AND agent_id = auth.uid()
  AND status = ANY (ARRAY['rejected'::text, 'deleted_by_agent'::text])
)
WITH CHECK (has_role(auth.uid(), 'agent'::app_role) AND agent_id = auth.uid());