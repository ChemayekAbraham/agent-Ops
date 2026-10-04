CREATE OR REPLACE FUNCTION public.get_agent_tenant_profile(p_tenant_id uuid)
 RETURNS TABLE(id uuid, full_name text, phone text, email text, created_at timestamp with time zone, monthly_rent numeric, verified boolean, national_id text, avatar_url text, tenant_status text, previous_full_name text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT
    p.id,
    p.full_name,
    p.phone,
    p.email,
    p.created_at,
    p.monthly_rent,
    p.verified,
    p.national_id,
    p.avatar_url,
    p.tenant_status,
    p.previous_full_name
  FROM public.profiles p
  WHERE p.id = p_tenant_id
    AND auth.uid() IS NOT NULL
    AND (
      p.id = auth.uid()
      OR p.referrer_id = auth.uid()
      OR (p.managed_by_agent = true AND p.managing_agent_id = auth.uid())
      OR EXISTS (
        SELECT 1 FROM public.referrals r
        WHERE r.referrer_id = auth.uid() AND r.referred_id = p.id
      )
      OR EXISTS (
        SELECT 1 FROM public.rent_requests rr
        WHERE rr.tenant_id = p.id
          AND (rr.agent_id = auth.uid() OR rr.assigned_agent_id = auth.uid())
      )
      OR public.has_role(auth.uid(), 'manager'::public.app_role)
      OR public.has_role(auth.uid(), 'super_admin'::public.app_role)
      OR public.has_role(auth.uid(), 'operations'::public.app_role)
      OR public.has_role(auth.uid(), 'coo'::public.app_role)
      OR public.has_role(auth.uid(), 'ceo'::public.app_role)
      OR public.has_role(auth.uid(), 'cto'::public.app_role)
      OR public.has_role(auth.uid(), 'cfo'::public.app_role)
      OR public.has_role(auth.uid(), 'crm'::public.app_role)
    )
  LIMIT 1;
$function$;