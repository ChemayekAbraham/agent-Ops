-- Close two data-access gaps flagged by the security check.
-- Neither table is written from the app: every change goes through
-- SECURITY DEFINER functions and triggers, which are unaffected by these rules.

-- 1. agent_tid_backed_float had no access rules at all.
ALTER TABLE public.agent_tid_backed_float ENABLE ROW LEVEL SECURITY;

REVOKE INSERT, UPDATE, DELETE ON public.agent_tid_backed_float FROM authenticated;
GRANT SELECT ON public.agent_tid_backed_float TO authenticated;
GRANT ALL ON public.agent_tid_backed_float TO service_role;

DROP POLICY IF EXISTS agent_tid_backed_float_own_read ON public.agent_tid_backed_float;
CREATE POLICY agent_tid_backed_float_own_read
  ON public.agent_tid_backed_float FOR SELECT TO authenticated
  USING (agent_id = auth.uid());

DROP POLICY IF EXISTS agent_tid_backed_float_ops_read ON public.agent_tid_backed_float;
CREATE POLICY agent_tid_backed_float_ops_read
  ON public.agent_tid_backed_float FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'manager')
    OR public.has_role(auth.uid(), 'coo')
    OR public.has_role(auth.uid(), 'cfo')
    OR public.has_role(auth.uid(), 'operations')
    OR public.has_role(auth.uid(), 'agent_ops')
    OR public.has_role(auth.uid(), 'financial_ops')
  );

-- No INSERT / UPDATE / DELETE policy: balances move only through
-- credit_agent_tid_backed_float and its triggers.

-- 2. staff_loan_policy could be read by every signed-in person.
DROP POLICY IF EXISTS staff_loan_policy_read ON public.staff_loan_policy;
CREATE POLICY staff_loan_policy_read
  ON public.staff_loan_policy FOR SELECT TO authenticated
  USING (
    public.is_welile_staff(auth.uid())
    OR public.has_role(auth.uid(), 'super_admin')
  );