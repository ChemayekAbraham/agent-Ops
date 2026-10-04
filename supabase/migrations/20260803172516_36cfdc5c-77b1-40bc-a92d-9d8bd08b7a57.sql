-- 1. Tighten agent UPDATE policies on rent_requests
DROP POLICY IF EXISTS "Agents can verify their requests" ON public.rent_requests;
CREATE POLICY "Agents can verify their requests"
ON public.rent_requests FOR UPDATE TO authenticated
USING (
  has_role(auth.uid(), 'agent'::app_role)
  AND agent_id = auth.uid()
)
WITH CHECK (
  has_role(auth.uid(), 'agent'::app_role)
  AND agent_id = auth.uid()
  AND (
    status = ANY (ARRAY['pending'::text, 'rejected'::text, 'deleted_by_agent'::text])
    OR has_role(auth.uid(), 'manager'::app_role)
  )
);

DROP POLICY IF EXISTS "Agents can edit own rejected requests" ON public.rent_requests;
CREATE POLICY "Agents can edit own rejected requests"
ON public.rent_requests FOR UPDATE TO authenticated
USING (
  has_role(auth.uid(), 'agent'::app_role)
  AND agent_id = auth.uid()
  AND status = ANY (ARRAY['rejected'::text, 'deleted_by_agent'::text])
)
WITH CHECK (
  has_role(auth.uid(), 'agent'::app_role)
  AND agent_id = auth.uid()
  AND (
    status = ANY (ARRAY['pending'::text, 'rejected'::text, 'deleted_by_agent'::text])
    OR has_role(auth.uid(), 'manager'::app_role)
  )
);

-- 2. Column-level guard: agents may not rewrite financial terms after review
CREATE OR REPLACE FUNCTION public.guard_rent_request_agent_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_is_ops boolean;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  v_is_ops := has_role(auth.uid(), 'manager'::app_role)
    OR has_role(auth.uid(), 'super_admin'::app_role)
    OR has_role(auth.uid(), 'cfo'::app_role)
    OR has_role(auth.uid(), 'coo'::app_role)
    OR has_role(auth.uid(), 'financial_ops'::app_role);

  IF v_is_ops THEN
    RETURN NEW;
  END IF;

  IF NEW.agent_id = auth.uid()
     AND OLD.status NOT IN ('pending', 'rejected', 'deleted_by_agent')
     AND (
       COALESCE(NEW.rent_amount, 0) <> COALESCE(OLD.rent_amount, 0)
       OR COALESCE(NEW.total_repayment, 0) <> COALESCE(OLD.total_repayment, 0)
       OR COALESCE(NEW.daily_repayment, 0) <> COALESCE(OLD.daily_repayment, 0)
     ) THEN
    RAISE EXCEPTION 'Agents cannot change financial terms on a request that has left review';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_rent_request_agent_columns ON public.rent_requests;
CREATE TRIGGER trg_guard_rent_request_agent_columns
BEFORE UPDATE ON public.rent_requests
FOR EACH ROW EXECUTE FUNCTION public.guard_rent_request_agent_columns();

-- 3. Column-level guard on landlord_payment_edits agent responses
CREATE OR REPLACE FUNCTION public.guard_landlord_payment_edit_agent_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_is_ops boolean;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  v_is_ops := has_role(auth.uid(), 'manager'::app_role)
    OR has_role(auth.uid(), 'super_admin'::app_role)
    OR has_role(auth.uid(), 'cfo'::app_role)
    OR has_role(auth.uid(), 'coo'::app_role)
    OR has_role(auth.uid(), 'financial_ops'::app_role);

  IF v_is_ops THEN
    RETURN NEW;
  END IF;

  IF NEW.agent_id = auth.uid() THEN
    NEW.old_amount := OLD.old_amount;
    NEW.new_amount := OLD.new_amount;
    NEW.status := OLD.status;
    NEW.landlord_id := OLD.landlord_id;
    NEW.agent_id := OLD.agent_id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_landlord_payment_edit_agent_columns ON public.landlord_payment_edits;
CREATE TRIGGER trg_guard_landlord_payment_edit_agent_columns
BEFORE UPDATE ON public.landlord_payment_edits
FOR EACH ROW EXECUTE FUNCTION public.guard_landlord_payment_edit_agent_columns();