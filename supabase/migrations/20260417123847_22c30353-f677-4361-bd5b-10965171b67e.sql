-- Prevent self-assignment of cashout_agents (must be assigned by CFO/COO/Super Admin/Manager)
CREATE OR REPLACE FUNCTION public.prevent_cashout_self_assignment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.assigned_by IS NULL OR NEW.assigned_by = NEW.agent_id THEN
    RAISE EXCEPTION 'Cashout agents must be assigned by an authorised CFO/COO/Super Admin/Manager (no self-assignment).';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = NEW.assigned_by
      AND role IN ('cfo'::app_role, 'super_admin'::app_role, 'coo'::app_role, 'manager'::app_role)
  ) THEN
    RAISE EXCEPTION 'Only CFO, COO, Super Admin or Manager can assign cashout agents.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_cashout_self_assignment ON public.cashout_agents;
CREATE TRIGGER trg_prevent_cashout_self_assignment
  BEFORE INSERT OR UPDATE OF agent_id, assigned_by ON public.cashout_agents
  FOR EACH ROW EXECUTE FUNCTION public.prevent_cashout_self_assignment();

-- Deactivate existing self-assigned rows
UPDATE public.cashout_agents
SET is_active = false, updated_at = now()
WHERE assigned_by = agent_id AND is_active = true;

-- Tighten the SELECT policy on withdrawal_requests so cashout agents must NOT be self-assigned
DROP POLICY IF EXISTS "Staff and cashout agents can view withdrawal requests" ON public.withdrawal_requests;

CREATE POLICY "Staff and cashout agents can view withdrawal requests"
ON public.withdrawal_requests
FOR SELECT
USING (
  (auth.uid() = user_id)
  OR EXISTS (
    SELECT 1 FROM user_roles
    WHERE user_roles.user_id = auth.uid()
      AND user_roles.role = ANY (ARRAY['manager'::app_role, 'operations'::app_role, 'cfo'::app_role, 'coo'::app_role, 'super_admin'::app_role, 'cto'::app_role])
  )
  OR EXISTS (
    SELECT 1 FROM cashout_agents ca
    WHERE ca.agent_id = auth.uid()
      AND ca.is_active = true
      AND ca.assigned_by IS NOT NULL
      AND ca.assigned_by <> ca.agent_id
  )
);

-- Allow cashout agents to read profiles of withdrawal requesters (so recipient name/phone shows)
CREATE POLICY "Cashout agents can view profiles for withdrawals"
ON public.profiles
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM cashout_agents ca
    WHERE ca.agent_id = auth.uid()
      AND ca.is_active = true
      AND ca.assigned_by IS NOT NULL
      AND ca.assigned_by <> ca.agent_id
  )
  AND id IN (
    SELECT user_id FROM withdrawal_requests
    WHERE status IN ('pending', 'requested', 'manager_approved', 'cfo_approved', 'approved', 'fin_ops_approved')
  )
);