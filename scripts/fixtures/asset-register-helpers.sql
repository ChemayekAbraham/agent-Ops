-- Verbatim production copies (2026-10-26, read-only export) of the helpers the asset register depends on.
-- Loaded by scripts/test-asset-register.mjs. Fingerprints are checked by the migration preflight.

CREATE OR REPLACE FUNCTION public._has_enabled_role(p_user uuid, p_roles text[])
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (SELECT 1 FROM public.user_roles
                 WHERE user_id = p_user AND enabled AND role::text = ANY (p_roles))
$function$;

CREATE OR REPLACE FUNCTION public.staff_mfa_ok()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select case (select c.mode from public.staff_mfa_config c where c.id)
    when 'all' then coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2' or not exists (select 1 from public.user_roles ur where ur.user_id = auth.uid() and ur.enabled and ur.role::text in ('manager','super_admin','coo','ceo','cto','cfo','cmo','crm','hr','rd','operations','employee','tenant_ops','agent_ops','landlord_ops','partner_ops','financial_ops','access_admin','admin'))
    when 'admin' then coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2' or not exists (select 1 from public.user_roles ur where ur.user_id = auth.uid() and ur.enabled and ur.role::text in ('super_admin','ceo','cto','cfo','coo','access_admin','admin'))
    else true end $function$;
