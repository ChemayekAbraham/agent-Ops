-- Strict backend role gate for agent advance request total repayment.
-- total_payable must never be returned to agents (or any non-privileged
-- Data-API caller). Writes (INSERT/UPDATE) and service_role reads used by
-- ledger posting are unaffected — only direct SELECT of the column is revoked.
REVOKE SELECT (total_payable) ON public.agent_advance_requests FROM authenticated;
REVOKE SELECT (total_payable) ON public.agent_advance_requests FROM anon;

-- Role-guarded privileged view that re-exposes the full request row
-- (including total_payable) ONLY to executives and ops staff. Uses a
-- SECURITY DEFINER (security_invoker = off) view so it can read the
-- column-revoked field, while the WHERE clause performs the strict role
-- check — agents and other users receive zero rows.
CREATE OR REPLACE VIEW public.agent_advance_requests_privileged
WITH (security_invoker = off) AS
SELECT
  aar.*,
  p.full_name AS agent_full_name,
  p.phone     AS agent_phone
FROM public.agent_advance_requests aar
LEFT JOIN public.profiles p ON p.id = aar.agent_id
WHERE public.has_role(auth.uid(), 'super_admin')
   OR public.has_role(auth.uid(), 'manager')
   OR public.has_role(auth.uid(), 'cfo')
   OR public.has_role(auth.uid(), 'coo')
   OR EXISTS (
        SELECT 1 FROM public.staff_permissions sp
        WHERE sp.user_id = auth.uid()
          AND sp.permitted_dashboard = ANY (ARRAY['agent-ops','tenant-ops','landlord-ops','financial-ops','company-ops'])
   );

GRANT SELECT ON public.agent_advance_requests_privileged TO authenticated;
GRANT ALL  ON public.agent_advance_requests_privileged TO service_role;