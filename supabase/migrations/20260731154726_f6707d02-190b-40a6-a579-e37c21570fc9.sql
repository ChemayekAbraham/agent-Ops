-- 1. email_match_audit_log: writes restricted to finance/ops staff, actor must be self
DROP POLICY IF EXISTS "Authenticated can write email match audit" ON public.email_match_audit_log;

CREATE POLICY "Ops can write own email match audit"
ON public.email_match_audit_log
FOR INSERT
TO authenticated
WITH CHECK (
  actor_id = auth.uid()
  AND (
    public.has_role(auth.uid(), 'manager'::app_role)
    OR public.has_role(auth.uid(), 'cfo'::app_role)
    OR public.has_role(auth.uid(), 'coo'::app_role)
    OR public.has_role(auth.uid(), 'operations'::app_role)
    OR public.has_role(auth.uid(), 'financial_ops'::app_role)
    OR public.has_role(auth.uid(), 'super_admin'::app_role)
  )
);

-- 2. payout_claim_sms_audit_log: server-side (service_role) writes only
DROP POLICY IF EXISTS "Authenticated can write payout claim sms audit log" ON public.payout_claim_sms_audit_log;
GRANT INSERT ON public.payout_claim_sms_audit_log TO service_role;

-- 3. map_config: no longer world-readable through the Data API
DROP POLICY IF EXISTS "Anyone can read map config" ON public.map_config;

CREATE POLICY "Managers can read map config"
ON public.map_config
FOR SELECT
TO authenticated
USING (
  public.has_role(auth.uid(), 'manager'::app_role)
  OR public.has_role(auth.uid(), 'super_admin'::app_role)
  OR public.has_role(auth.uid(), 'cto'::app_role)
);

REVOKE SELECT ON public.map_config FROM anon;

-- Scoped accessor: signed-in users get only the browser key, nothing else.
CREATE OR REPLACE FUNCTION public.get_maps_browser_key()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT NULLIF(btrim(browser_api_key), '')
  FROM public.map_config
  WHERE auth.uid() IS NOT NULL
  LIMIT 1
$$;

REVOKE ALL ON FUNCTION public.get_maps_browser_key() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_maps_browser_key() TO authenticated, service_role;