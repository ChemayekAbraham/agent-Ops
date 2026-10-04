SET LOCAL lock_timeout = '15s';

DROP POLICY IF EXISTS "Users can view own profile" ON public.profiles;
CREATE POLICY "Users can view own profile" ON public.profiles FOR SELECT
USING (id = (select auth.uid()));

DROP POLICY IF EXISTS "Managers can view all profiles" ON public.profiles;
CREATE POLICY "Managers can view all profiles" ON public.profiles FOR SELECT
USING ((select public.has_role((select auth.uid()), 'manager'::app_role)));

DROP POLICY IF EXISTS "CFO can view all profiles" ON public.profiles;
CREATE POLICY "CFO can view all profiles" ON public.profiles FOR SELECT TO authenticated
USING ((select public.has_role((select auth.uid()), 'cfo'::app_role)));

DROP POLICY IF EXISTS "HR can view all profiles" ON public.profiles;
CREATE POLICY "HR can view all profiles" ON public.profiles FOR SELECT TO authenticated
USING ((select public.has_role((select auth.uid()), 'hr'::app_role)));

DROP POLICY IF EXISTS "Tenant ops can view all profiles" ON public.profiles;
CREATE POLICY "Tenant ops can view all profiles" ON public.profiles FOR SELECT TO authenticated
USING ((select public.has_role((select auth.uid()), 'tenant_ops'::app_role)));

DROP POLICY IF EXISTS "Ops and executives can view all profiles" ON public.profiles;
CREATE POLICY "Ops and executives can view all profiles" ON public.profiles FOR SELECT TO authenticated
USING ((select (
  public.has_role((select auth.uid()), 'operations'::app_role)
  OR public.has_role((select auth.uid()), 'coo'::app_role)
  OR public.has_role((select auth.uid()), 'ceo'::app_role)
  OR public.has_role((select auth.uid()), 'cto'::app_role)
  OR public.has_role((select auth.uid()), 'cmo'::app_role)
  OR public.has_role((select auth.uid()), 'crm'::app_role)
  OR public.has_role((select auth.uid()), 'employee'::app_role)
  OR public.has_role((select auth.uid()), 'super_admin'::app_role)
)));

DROP POLICY IF EXISTS "Agents can view managed profiles" ON public.profiles;
CREATE POLICY "Agents can view managed profiles" ON public.profiles FOR SELECT TO authenticated
USING (
  (select public.has_role((select auth.uid()), 'agent'::app_role))
  AND (
    referrer_id = (select auth.uid())
    OR ((managed_by_agent = true) AND managing_agent_id = (select auth.uid()))
    OR EXISTS (
      SELECT 1 FROM public.rent_requests rr
      WHERE rr.tenant_id = profiles.id
        AND (rr.agent_id = (select auth.uid()) OR rr.assigned_agent_id = (select auth.uid()))
    )
  )
);

DROP POLICY IF EXISTS "Managing agent can view managed user profile" ON public.profiles;
CREATE POLICY "Managing agent can view managed user profile" ON public.profiles FOR SELECT
USING (
  (managed_by_agent = true)
  AND managing_agent_id = (select auth.uid())
  AND (select public.has_role((select auth.uid()), 'agent'::app_role))
);

DROP POLICY IF EXISTS "Cashout agents can view profiles for withdrawals" ON public.profiles;
CREATE POLICY "Cashout agents can view profiles for withdrawals" ON public.profiles FOR SELECT TO authenticated
USING (
  (select public.is_active_cashout_agent((select auth.uid())))
  AND id IN (
    SELECT wr.user_id FROM public.withdrawal_requests wr
    WHERE wr.status = ANY (ARRAY['pending','requested','manager_approved','cfo_approved','approved','fin_ops_approved'])
  )
);

DROP POLICY IF EXISTS "Supporters can view funded tenant profiles" ON public.profiles;
CREATE POLICY "Supporters can view funded tenant profiles" ON public.profiles FOR SELECT
USING (
  (select public.is_supporter())
  AND id IN (SELECT rr.tenant_id FROM public.rent_requests rr WHERE rr.supporter_id = (select auth.uid()))
);

DROP POLICY IF EXISTS "Proxy agents can view partner profiles" ON public.profiles;
CREATE POLICY "Proxy agents can view partner profiles" ON public.profiles FOR SELECT TO authenticated
USING ((select public.is_proxy_agent_for_partner((select auth.uid()), profiles.id)));