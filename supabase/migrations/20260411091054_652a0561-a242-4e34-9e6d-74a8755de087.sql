
-- ============================================================
-- 1. agent_collection_streaks: Remove public policy, add scoped ones
-- ============================================================

-- Drop the overly permissive public policy
DROP POLICY IF EXISTS "System can manage streaks" ON public.agent_collection_streaks;
DROP POLICY IF EXISTS "Anyone can read streaks" ON public.agent_collection_streaks;
DROP POLICY IF EXISTS "Agents can view own streaks" ON public.agent_collection_streaks;
DROP POLICY IF EXISTS "Agents can read own streak" ON public.agent_collection_streaks;

-- Agents can read their own streak
CREATE POLICY "Agents can read own streak"
  ON public.agent_collection_streaks
  FOR SELECT
  TO authenticated
  USING (agent_id = auth.uid());

-- No direct INSERT/UPDATE/DELETE for clients - only service_role / triggers

-- ============================================================
-- 2. investor_portfolios: Remove anon SELECT policy
-- ============================================================

DROP POLICY IF EXISTS "Anon can read portfolios by token" ON public.investor_portfolios;
DROP POLICY IF EXISTS "Anyone can view active portfolios" ON public.investor_portfolios;
DROP POLICY IF EXISTS "Public can view portfolios with token" ON public.investor_portfolios;

-- ============================================================
-- 3. location_requests: Replace always-true public read with token-scoped
-- ============================================================

DROP POLICY IF EXISTS "Public can read by token" ON public.location_requests;

-- Token-scoped read: only rows matching a specific token filter are visible
CREATE POLICY "Authenticated users can read own location requests"
  ON public.location_requests
  FOR SELECT
  TO authenticated
  USING (
    target_user_id = auth.uid()
    OR requested_by = auth.uid()
  );
