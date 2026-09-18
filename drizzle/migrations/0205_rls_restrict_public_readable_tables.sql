-- Restrict overly permissive SELECT policies on public config/review tables

-- 1. wallet_transfer_schedule_config: admin/ops/finance only
DROP POLICY IF EXISTS "Authenticated can read auto payout cap" ON public.wallet_transfer_schedule_config;

CREATE POLICY "Manager and finance roles can read auto payout cap"
ON public.wallet_transfer_schedule_config
FOR SELECT
TO authenticated
USING (
  public.has_role(auth.uid(), 'manager'::public.app_role)
  OR public.has_role(auth.uid(), 'super_admin'::public.app_role)
  OR public.has_role(auth.uid(), 'ceo'::public.app_role)
  OR public.has_role(auth.uid(), 'cfo'::public.app_role)
  OR public.has_role(auth.uid(), 'cto'::public.app_role)
  OR public.has_role(auth.uid(), 'operations'::public.app_role)
  OR public.has_role(auth.uid(), 'financial_ops'::public.app_role)
);

-- 2. user_reviews: own reviews, reviews about self, or staff roles
DROP POLICY IF EXISTS "Signed-in users can view user reviews" ON public.user_reviews;

CREATE POLICY "Users can view own or received reviews"
ON public.user_reviews
FOR SELECT
TO authenticated
USING (
  reviewer_id = auth.uid()
  OR reviewed_user_id = auth.uid()
  OR public.has_role(auth.uid(), 'manager'::public.app_role)
  OR public.has_role(auth.uid(), 'super_admin'::public.app_role)
  OR public.has_role(auth.uid(), 'ceo'::public.app_role)
  OR public.has_role(auth.uid(), 'cfo'::public.app_role)
  OR public.has_role(auth.uid(), 'cto'::public.app_role)
  OR public.has_role(auth.uid(), 'operations'::public.app_role)
  OR public.has_role(auth.uid(), 'tenant_ops'::public.app_role)
  OR public.has_role(auth.uid(), 'landlord_ops'::public.app_role)
  OR public.has_role(auth.uid(), 'agent_ops'::public.app_role)
  OR public.has_role(auth.uid(), 'partner_ops'::public.app_role)
);

-- 3. angel_pool_config: admin/finance/supporter roles
DROP POLICY IF EXISTS "Authenticated read angel_pool_config" ON public.angel_pool_config;

CREATE POLICY "Admin and supporter roles can read angel_pool_config"
ON public.angel_pool_config
FOR SELECT
TO authenticated
USING (
  public.has_role(auth.uid(), 'manager'::public.app_role)
  OR public.has_role(auth.uid(), 'super_admin'::public.app_role)
  OR public.has_role(auth.uid(), 'ceo'::public.app_role)
  OR public.has_role(auth.uid(), 'cfo'::public.app_role)
  OR public.has_role(auth.uid(), 'cto'::public.app_role)
  OR public.has_role(auth.uid(), 'operations'::public.app_role)
  OR public.has_role(auth.uid(), 'financial_ops'::public.app_role)
  OR public.has_role(auth.uid(), 'supporter'::public.app_role)
);