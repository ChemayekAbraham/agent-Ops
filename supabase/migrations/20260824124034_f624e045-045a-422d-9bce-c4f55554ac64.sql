DROP POLICY IF EXISTS "Referrer and invitee can view own merchant referral" ON public.merchant_agent_referrals;
CREATE POLICY "Referrer invitee beneficiary can view merchant referral"
ON public.merchant_agent_referrals
FOR SELECT
TO authenticated
USING (
  (select auth.uid()) = referrer_id
  OR (select auth.uid()) = invitee_id
  OR (select auth.uid()) = beneficiary_id
  OR public.has_role((select auth.uid()), 'manager'::app_role)
  OR public.has_role((select auth.uid()), 'super_admin'::app_role)
);