SET LOCAL lock_timeout = '15s';

-- general_ledger: hoist role checks so they run once per query, not once per row.
DROP POLICY IF EXISTS "Executives can view all ledger entries" ON public.general_ledger;
CREATE POLICY "Executives can view all ledger entries" ON public.general_ledger FOR SELECT
USING ((select (
  public.has_role((select auth.uid()), 'cfo'::app_role)
  OR public.has_role((select auth.uid()), 'coo'::app_role)
  OR public.has_role((select auth.uid()), 'ceo'::app_role)
)));

DROP POLICY IF EXISTS "Managers can view all ledger entries" ON public.general_ledger;
CREATE POLICY "Managers can view all ledger entries" ON public.general_ledger FOR SELECT
USING ((select exists (
  select 1 from public.user_roles
  where user_roles.user_id = (select auth.uid())
    and user_roles.role = 'manager'::app_role
)));

DROP POLICY IF EXISTS "Users can view own ledger entries" ON public.general_ledger;
CREATE POLICY "Users can view own ledger entries" ON public.general_ledger FOR SELECT
USING (
  user_id = (select auth.uid())
  AND public.is_customer_wallet_history_visible(user_id, classification, category, source_table, description, reference_id, source_id)
);

-- withdrawal_requests: same treatment.
DROP POLICY IF EXISTS "Owners staff and active merchant agents can view withdrawals" ON public.withdrawal_requests;
CREATE POLICY "Owners staff and active merchant agents can view withdrawals" ON public.withdrawal_requests FOR SELECT
USING (
  user_id = (select auth.uid())
  OR (select public.is_withdrawal_staff((select auth.uid())))
  OR (
    status = ANY (ARRAY['pending','requested','approved','manager_approved','cfo_approved','fin_ops_approved'])
    AND (select public.is_active_cashout_agent((select auth.uid())))
  )
  OR (
    status = 'completed'
    AND (select public.is_active_cashout_agent((select auth.uid())))
    AND (
      assigned_cashout_agent_id = (select ca.id from public.cashout_agents ca where ca.agent_id = (select auth.uid()) limit 1)
      OR processed_by = (select auth.uid())
    )
  )
);

DROP POLICY IF EXISTS "Proxy initiators can view their proxy withdrawals" ON public.withdrawal_requests;
CREATE POLICY "Proxy initiators can view their proxy withdrawals" ON public.withdrawal_requests FOR SELECT
USING (
  proxy_partner_id IS NOT NULL
  AND (agent_id = (select auth.uid()) OR initiated_by = (select auth.uid()))
);