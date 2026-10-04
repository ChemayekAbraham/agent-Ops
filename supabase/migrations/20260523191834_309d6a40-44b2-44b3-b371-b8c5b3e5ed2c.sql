
-- 1. Drop obsolete test artifact (publicly readable financial test data)
DROP TABLE IF EXISTS public.e2e_landlord_payout_results;

-- 2. agent_tasks: replace blanket SELECT
DROP POLICY IF EXISTS "Authenticated users can view agent tasks" ON public.agent_tasks;
CREATE POLICY "Agents tenants and ops can view agent tasks"
  ON public.agent_tasks FOR SELECT
  TO authenticated
  USING (
    agent_id = auth.uid()
    OR tenant_id = auth.uid()
    OR assigned_by = auth.uid()
    OR has_role(auth.uid(), 'manager'::app_role)
    OR has_role(auth.uid(), 'coo'::app_role)
    OR has_role(auth.uid(), 'super_admin'::app_role)
  );

-- 3. cashout_agents: replace blanket SELECT
DROP POLICY IF EXISTS "Authenticated can read cashout_agents" ON public.cashout_agents;
CREATE POLICY "Cashout agents and finance staff can read cashout_agents"
  ON public.cashout_agents FOR SELECT
  TO authenticated
  USING (
    agent_id = auth.uid()
    OR has_role(auth.uid(), 'cfo'::app_role)
    OR has_role(auth.uid(), 'coo'::app_role)
    OR has_role(auth.uid(), 'manager'::app_role)
    OR has_role(auth.uid(), 'super_admin'::app_role)
  );

-- 4. infrastructure_settings: restrict to executive infra roles
DROP POLICY IF EXISTS "infrastructure_settings_read" ON public.infrastructure_settings;
CREATE POLICY "infrastructure_settings_read_privileged"
  ON public.infrastructure_settings FOR SELECT
  TO authenticated
  USING (
    has_role(auth.uid(), 'super_admin'::app_role)
    OR has_role(auth.uid(), 'ceo'::app_role)
    OR has_role(auth.uid(), 'cto'::app_role)
  );

-- 5. lc1_chairpersons: restrict to agents and managers
DROP POLICY IF EXISTS "Authenticated users can view lc1" ON public.lc1_chairpersons;
CREATE POLICY "Agents and managers can view lc1"
  ON public.lc1_chairpersons FOR SELECT
  TO authenticated
  USING (
    has_role(auth.uid(), 'agent'::app_role)
    OR has_role(auth.uid(), 'manager'::app_role)
    OR has_role(auth.uid(), 'coo'::app_role)
    OR has_role(auth.uid(), 'super_admin'::app_role)
  );

-- 6. payout_codes: restrict reads
DROP POLICY IF EXISTS "Authenticated can read payout_codes" ON public.payout_codes;
CREATE POLICY "Owners agents and managers can read payout_codes"
  ON public.payout_codes FOR SELECT
  TO authenticated
  USING (
    user_id = auth.uid()
    OR claimed_by = auth.uid()
    OR paid_by = auth.uid()
    OR has_role(auth.uid(), 'agent'::app_role)
    OR has_role(auth.uid(), 'manager'::app_role)
    OR has_role(auth.uid(), 'cfo'::app_role)
    OR has_role(auth.uid(), 'super_admin'::app_role)
  );

-- 7. public_error_logs: restrict to manager / super_admin
DROP POLICY IF EXISTS "Authenticated users can view public error logs" ON public.public_error_logs;
CREATE POLICY "Managers can view public error logs"
  ON public.public_error_logs FOR SELECT
  TO authenticated
  USING (
    has_role(auth.uid(), 'manager'::app_role)
    OR has_role(auth.uid(), 'super_admin'::app_role)
    OR has_role(auth.uid(), 'cto'::app_role)
  );

-- 8. short_links: drop blanket anon read; provide RPC for safe single-code resolution
DROP POLICY IF EXISTS "Anyone can resolve short links" ON public.short_links;

-- Allow managers (e.g. funder onboarding analytics) to read aggregate rows
CREATE POLICY "Managers can read all short_links"
  ON public.short_links FOR SELECT
  TO authenticated
  USING (
    has_role(auth.uid(), 'manager'::app_role)
    OR has_role(auth.uid(), 'super_admin'::app_role)
  );

CREATE OR REPLACE FUNCTION public.resolve_short_link(p_code text)
RETURNS TABLE (target_path text, target_params jsonb)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT sl.target_path, sl.target_params
  FROM public.short_links sl
  WHERE sl.code = p_code
  LIMIT 1;
$$;
REVOKE ALL ON FUNCTION public.resolve_short_link(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_short_link(text) TO anon, authenticated;

-- 9. treasury_controls: limit anon reads to maintenance keys only
DROP POLICY IF EXISTS "Public can read maintenance status" ON public.treasury_controls;
CREATE POLICY "Public can read maintenance keys only"
  ON public.treasury_controls FOR SELECT
  TO anon, authenticated
  USING (control_key IN ('maintenance_mode', 'maintenance_message', 'maintenance_until'));

-- 10. vendors: hide pin / pin_hash columns from anon and authenticated
REVOKE SELECT (pin, pin_hash) ON public.vendors FROM anon;
REVOKE SELECT (pin, pin_hash) ON public.vendors FROM authenticated;

-- 11. welile_trust_score_cache: restrict to own row + privileged staff
DROP POLICY IF EXISTS "Authenticated can read trust cache" ON public.welile_trust_score_cache;
CREATE POLICY "Users and staff can read trust cache"
  ON public.welile_trust_score_cache FOR SELECT
  TO authenticated
  USING (
    user_id = auth.uid()
    OR has_role(auth.uid(), 'manager'::app_role)
    OR has_role(auth.uid(), 'super_admin'::app_role)
    OR has_role(auth.uid(), 'ceo'::app_role)
    OR has_role(auth.uid(), 'coo'::app_role)
    OR has_role(auth.uid(), 'cfo'::app_role)
    OR has_role(auth.uid(), 'employee'::app_role)
    OR has_role(auth.uid(), 'operations'::app_role)
    OR has_role(auth.uid(), 'agent'::app_role)
  );
