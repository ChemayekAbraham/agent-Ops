
-- Allow managers to update wallets (needed for balance adjustments)
CREATE POLICY "Managers can update wallets"
  ON public.wallets FOR UPDATE
  TO authenticated
  USING (EXISTS (
    SELECT 1 FROM user_roles
    WHERE user_roles.user_id = auth.uid() AND user_roles.role = 'manager'::app_role
  ));

-- Allow managers to insert wallet transactions (needed for audit trail)
CREATE POLICY "Managers can insert wallet transactions"
  ON public.wallet_transactions FOR INSERT
  TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM user_roles
    WHERE user_roles.user_id = auth.uid() AND user_roles.role = 'manager'::app_role
  ));

-- Allow managers to view all wallet transactions
CREATE POLICY "Managers can view all wallet transactions"
  ON public.wallet_transactions FOR SELECT
  TO authenticated
  USING (EXISTS (
    SELECT 1 FROM user_roles
    WHERE user_roles.user_id = auth.uid() AND user_roles.role = 'manager'::app_role
  ));
