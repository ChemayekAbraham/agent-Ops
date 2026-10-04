-- Fix: Allow ANY user (including unauthenticated tenants worldwide) to browse available houses
DROP POLICY IF EXISTS "Anyone can view available listings" ON public.house_listings;
CREATE POLICY "Anyone can view available listings"
  ON public.house_listings
  FOR SELECT
  TO public
  USING (
    status = 'available'
    OR (auth.uid() IS NOT NULL AND (auth.uid() = agent_id OR auth.uid() = tenant_id))
  );

-- Fix: Allow any authenticated user to insert LC1 chairpersons (not just role-checked agents)
DROP POLICY IF EXISTS "Agents and managers can insert lc1" ON public.lc1_chairpersons;
CREATE POLICY "Authenticated users can insert lc1"
  ON public.lc1_chairpersons
  FOR INSERT
  TO authenticated
  WITH CHECK (true);

-- Fix: Allow any authenticated user to view LC1 chairpersons for lookup
DROP POLICY IF EXISTS "Agents and managers can view lc1" ON public.lc1_chairpersons;
CREATE POLICY "Authenticated users can view lc1"
  ON public.lc1_chairpersons
  FOR SELECT
  TO authenticated
  USING (true);