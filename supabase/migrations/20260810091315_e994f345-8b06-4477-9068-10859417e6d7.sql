CREATE OR REPLACE FUNCTION public.is_payout_ops_staff(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT has_role(_user_id, 'manager'::app_role)
      OR has_role(_user_id, 'super_admin'::app_role)
      OR has_role(_user_id, 'ceo'::app_role)
      OR has_role(_user_id, 'coo'::app_role)
      OR has_role(_user_id, 'cfo'::app_role)
      OR has_role(_user_id, 'partner_ops'::app_role)
      OR has_role(_user_id, 'financial_ops'::app_role)
      OR has_role(_user_id, 'agent_ops'::app_role)
      OR has_role(_user_id, 'operations'::app_role)
$$;

CREATE POLICY "Ops staff can insert pending operations"
ON public.pending_wallet_operations FOR INSERT TO authenticated
WITH CHECK (public.is_payout_ops_staff(auth.uid()));

CREATE POLICY "Ops staff can view pending operations"
ON public.pending_wallet_operations FOR SELECT TO authenticated
USING (public.is_payout_ops_staff(auth.uid()));

CREATE POLICY "Ops staff can update pending operations"
ON public.pending_wallet_operations FOR UPDATE TO authenticated
USING (public.is_payout_ops_staff(auth.uid()))
WITH CHECK (public.is_payout_ops_staff(auth.uid()));