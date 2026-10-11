-- Same visibility rules; auth/role checks evaluated once per query instead of per row.
DROP POLICY IF EXISTS "Anyone can view available listings" ON public.house_listings;
CREATE POLICY "Anyone can view available listings" ON public.house_listings
  FOR SELECT TO public
  USING ((status = 'available'::text) OR (((SELECT auth.uid()) IS NOT NULL) AND (((SELECT auth.uid()) = agent_id) OR ((SELECT auth.uid()) = tenant_id))));

DROP POLICY IF EXISTS "Operations and executives can view all house listings" ON public.house_listings;
CREATE POLICY "Operations and executives can view all house listings" ON public.house_listings
  FOR SELECT TO authenticated
  USING ((SELECT (public.has_role(auth.uid(), 'operations'::app_role) OR public.has_role(auth.uid(), 'manager'::app_role) OR public.has_role(auth.uid(), 'coo'::app_role) OR public.has_role(auth.uid(), 'ceo'::app_role) OR public.has_role(auth.uid(), 'cfo'::app_role) OR public.has_role(auth.uid(), 'super_admin'::app_role) OR public.has_role(auth.uid(), 'cto'::app_role))));

CREATE INDEX IF NOT EXISTS idx_profiles_is_frozen_true ON public.profiles (id) WHERE is_frozen = true;