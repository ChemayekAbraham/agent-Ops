CREATE OR REPLACE FUNCTION public.get_signup_attempt_log(p_days integer DEFAULT 7, p_limit integer DEFAULT 200, p_status text DEFAULT NULL::text)
 RETURNS TABLE(id uuid, ip inet, device_fp text, path text, utm_source text, utm_medium text, utm_campaign text, email text, phone text, user_id uuid, status text, reason text, actor_role text, user_agent text, created_at timestamp with time zone)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH allowed AS (
    SELECT public.has_role(auth.uid(), 'super_admin')
        OR public.has_role(auth.uid(), 'admin')
        OR public.has_role(auth.uid(), 'cto')
        OR public.has_role(auth.uid(), 'ceo')
        OR public.has_role(auth.uid(), 'coo')
        OR public.has_role(auth.uid(), 'cmo')
        OR public.has_role(auth.uid(), 'manager') AS ok
  ),
  attempts AS (
    SELECT sa.id, sa.ip, sa.device_fp, sa.path, sa.utm_source, sa.utm_medium, sa.utm_campaign,
           sa.email, sa.phone, sa.user_id, sa.status, sa.reason, sa.actor_role, sa.user_agent, sa.created_at
      FROM public.signup_attempts sa, allowed
     WHERE allowed.ok
       AND sa.created_at > now() - make_interval(days => greatest(p_days, 1))
       AND (p_status IS NULL OR sa.status = p_status)
  ),
  agent_created AS (
    -- Profiles created server-side by agents (sub-agents, tenants, funders) that
    -- never went through /auth signup guard, so have no signup_attempts row.
    SELECT
      p.id AS id,
      NULL::inet AS ip,
      NULL::text AS device_fp,
      CASE
        WHEN p.email LIKE '%@welile.agent'    THEN '/agent/sub-agent-registration'
        WHEN p.email LIKE '%@welile.user'     THEN '/agent/tenant-registration'
        WHEN p.email LIKE '%@welile.funder'   THEN '/agent/funder-registration'
        WHEN p.email LIKE '%@welile.landlord' THEN '/agent/landlord-registration'
        ELSE '/agent-registration'
      END AS path,
      'agent_registration'::text AS utm_source,
      'server'::text AS utm_medium,
      NULL::text AS utm_campaign,
      p.email,
      p.phone,
      p.id AS user_id,
      'allowed'::text AS status,
      CASE
        WHEN ref.full_name IS NOT NULL THEN 'Registered by ' || ref.full_name ||
             coalesce(' (' || ref.phone || ')', '')
        WHEN p.referrer_id IS NOT NULL THEN 'Registered by referrer ' || p.referrer_id::text
        ELSE 'Server-side registration (no /auth attempt logged)'
      END AS reason,
      coalesce(
        (SELECT ur.role::text FROM public.user_roles ur WHERE ur.user_id = p.referrer_id LIMIT 1),
        'system'
      ) AS actor_role,
      NULL::text AS user_agent,
      p.created_at
    FROM public.profiles p
    LEFT JOIN public.profiles ref ON ref.id = p.referrer_id,
         allowed
    WHERE allowed.ok
      AND p.created_at > now() - make_interval(days => greatest(p_days, 1))
      AND NOT EXISTS (SELECT 1 FROM public.signup_attempts sa2 WHERE sa2.user_id = p.id)
      AND (p_status IS NULL OR p_status = 'allowed')
  )
  SELECT * FROM (
    SELECT * FROM attempts
    UNION ALL
    SELECT * FROM agent_created
  ) x
  ORDER BY created_at DESC
  LIMIT least(greatest(p_limit, 1), 2000);
$function$;