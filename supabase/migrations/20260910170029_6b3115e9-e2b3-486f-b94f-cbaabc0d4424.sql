-- Harden agent UPDATE access on deposit_requests.
-- Agents may only transition their own pending request to 'processing',
-- and may never change amount, auto_approved, or approved_at.

DROP POLICY IF EXISTS "Agents can update assigned deposit requests" ON public.deposit_requests;

CREATE POLICY "Agents can update assigned deposit requests"
ON public.deposit_requests
FOR UPDATE
TO public
USING (
  auth.uid() = agent_id
  AND status = 'pending'
)
WITH CHECK (
  auth.uid() = agent_id
  AND status = 'processing'
);

-- BEFORE UPDATE trigger to enforce immutability of amount/auto_approved/approved_at
-- for agent-initiated updates. Staff roles bypass this check.
CREATE OR REPLACE FUNCTION public.enforce_deposit_requests_agent_immutable_fields()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Staff and financial roles retain full update authority; this trigger only
  -- restricts an agent acting on their own assigned row.
  IF public.has_role(auth.uid(), 'manager'::public.app_role)
     OR public.has_role(auth.uid(), 'super_admin'::public.app_role)
     OR public.has_role(auth.uid(), 'coo'::public.app_role)
     OR public.has_role(auth.uid(), 'cfo'::public.app_role)
     OR public.has_role(auth.uid(), 'operations'::public.app_role)
     OR public.has_role(auth.uid(), 'financial_ops'::public.app_role)
  THEN
    RETURN NEW;
  END IF;

  -- If the updater is not the assigned agent, RLS will block the row anyway;
  -- no need to enforce here.
  IF auth.uid() IS NULL OR auth.uid() <> OLD.agent_id THEN
    RETURN NEW;
  END IF;

  -- Agent updating their own pending row: freeze protected fields.
  IF NEW.amount IS DISTINCT FROM OLD.amount THEN
    RAISE EXCEPTION 'Agents cannot change the deposit amount after the request is created';
  END IF;

  IF NEW.auto_approved IS DISTINCT FROM OLD.auto_approved THEN
    RAISE EXCEPTION 'Agents cannot change the auto_approved flag';
  END IF;

  IF NEW.approved_at IS DISTINCT FROM OLD.approved_at THEN
    RAISE EXCEPTION 'Agents cannot change the approval timestamp';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_deposit_requests_agent_immutable_fields ON public.deposit_requests;
CREATE TRIGGER trg_deposit_requests_agent_immutable_fields
BEFORE UPDATE ON public.deposit_requests
FOR EACH ROW
EXECUTE FUNCTION public.enforce_deposit_requests_agent_immutable_fields();
