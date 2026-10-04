
CREATE OR REPLACE FUNCTION public.get_my_subagent_profiles()
RETURNS TABLE(
  id uuid,
  full_name text,
  phone text,
  avatar_url text,
  email text,
  national_id text,
  district text,
  region text,
  occupation text,
  created_at timestamptz
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
    SELECT p.id, p.full_name, p.phone, p.avatar_url, p.email,
           p.national_id, p.district, p.region, p.occupation, p.created_at
    FROM public.profiles p
    WHERE p.id IN (
      SELECT sa.sub_agent_id
      FROM public.agent_subagents sa
      WHERE sa.parent_agent_id = auth.uid()
    );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_my_subagent_profiles() TO authenticated;

CREATE OR REPLACE FUNCTION public.get_my_subagent_tenant_profiles()
RETURNS TABLE(
  id uuid,
  full_name text,
  phone text
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
    SELECT DISTINCT p.id, p.full_name, p.phone
    FROM public.profiles p
    WHERE p.id IN (
      SELECT rr.tenant_id
      FROM public.rent_requests rr
      WHERE rr.tenant_id IS NOT NULL
        AND rr.agent_id IN (
          SELECT sa.sub_agent_id
          FROM public.agent_subagents sa
          WHERE sa.parent_agent_id = auth.uid()
        )
    );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_my_subagent_tenant_profiles() TO authenticated;
