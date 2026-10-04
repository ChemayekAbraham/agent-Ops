-- Fix: cash-out agents see "Unknown" for withdrawal requesters because the
-- profile SELECT policy used inline subqueries (cashout_agents + user_roles)
-- that are themselves subject to RLS. A cash-out agent cannot read the
-- assigner's user_roles rows (users only see their own roles), so the check
-- silently failed and profile names came back empty.
-- Replace the inline checks with the SECURITY DEFINER helper is_active_cashout_agent().

DROP POLICY IF EXISTS "Cashout agents can view profiles for withdrawals" ON public.profiles;

CREATE POLICY "Cashout agents can view profiles for withdrawals"
ON public.profiles
FOR SELECT
TO authenticated
USING (
  public.is_active_cashout_agent(auth.uid())
  AND id IN (
    SELECT wr.user_id
    FROM public.withdrawal_requests wr
    WHERE wr.status = ANY (ARRAY[
      'pending','requested','manager_approved','cfo_approved','approved','fin_ops_approved'
    ])
  )
);