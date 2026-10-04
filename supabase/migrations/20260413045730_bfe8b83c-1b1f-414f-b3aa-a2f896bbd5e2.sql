
-- Fix 1: Remove overly permissive anon policy on investor_portfolios
-- The policy "Anon can select by activation_token" checks (activation_token IS NOT NULL)
-- which is always true since activation_token defaults to gen_random_uuid().
-- This exposes all portfolios (including PINs, bank details) to anonymous users.
DROP POLICY IF EXISTS "Anon can select by activation_token" ON public.investor_portfolios;

-- Replace with a secure policy that requires matching a specific token value
CREATE POLICY "Anon can select by specific activation_token"
ON public.investor_portfolios
FOR SELECT
TO anon
USING (
  activation_token IS NOT NULL
  AND activation_token::text = current_setting('request.headers', true)::json->>'x-activation-token'
);

-- Fix 2: Replace overly permissive agent_escalations SELECT policy
-- Currently allows any authenticated user to read all escalation records.
DROP POLICY IF EXISTS "Authenticated users can view agent escalations" ON public.agent_escalations;

-- Agents can only view their own escalations
CREATE POLICY "Agents can view own escalations"
ON public.agent_escalations
FOR SELECT
TO authenticated
USING (
  agent_id = auth.uid()
  OR has_role(auth.uid(), 'manager'::app_role)
  OR has_role(auth.uid(), 'coo'::app_role)
  OR has_role(auth.uid(), 'super_admin'::app_role)
);
