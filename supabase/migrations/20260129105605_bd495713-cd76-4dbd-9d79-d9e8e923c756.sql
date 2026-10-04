-- Allow managers to view agent/user wallet balances (for payout processing & audits)
-- Wallets table contains no sensitive auth data; balance visibility is required for manager workflows.

CREATE POLICY "Managers can view all wallets"
ON public.wallets
FOR SELECT
USING (
  EXISTS (
    SELECT 1
    FROM public.user_roles
    WHERE user_roles.user_id = auth.uid()
      AND user_roles.role = 'manager'::app_role
  )
);
