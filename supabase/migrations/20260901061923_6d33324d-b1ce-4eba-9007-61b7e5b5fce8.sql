-- Derived call outcome, mirroring the client-side deriveOutcome rules.
CREATE OR REPLACE FUNCTION public.crm_derive_outcome(
  p_status text, p_hangup_cause text, p_duration integer
) RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN lower(btrim(coalesce(p_status,''))) IN ('initiating','queued','ringing','ringing_staff','bridged','in_progress','active') THEN 'in_progress'
    WHEN coalesce(p_duration,0) > 0 THEN 'answered'
    WHEN upper(btrim(coalesce(p_hangup_cause,''))) IN ('USER_BUSY','CALL_REJECTED','REJECTED','BUSY','DECLINED') THEN 'rejected'
    WHEN upper(btrim(coalesce(p_hangup_cause,''))) IN ('NO_ANSWER','NO_USER_RESPONSE','UNALLOCATED_NUMBER','INVALID_NUMBER_FORMAT','SUBSCRIBER_ABSENT','NETWORK_OUT_OF_ORDER','RECOVERY_ON_TIMER_EXPIRE','ORIGINATOR_CANCEL','CALLBACK_TIMEOUT') THEN 'not_reachable'
    WHEN lower(btrim(coalesce(p_status,''))) IN ('rejected','busy') THEN 'rejected'
    ELSE 'not_reachable'
  END;
$$;

-- Multi-role membership of every platform person, one row per role held.
CREATE OR REPLACE VIEW public.v_crm_person_roles AS
  SELECT DISTINCT tenant_id AS person_id, 'tenant'::text AS role
    FROM public.rent_requests
   WHERE tenant_id IS NOT NULL
     AND status IN ('funded','repaying','rejected','completed')
  UNION
  SELECT DISTINCT a.person_id, 'agent'::text
    FROM (
      SELECT user_id AS person_id FROM public.user_roles
       WHERE enabled = true AND role IN ('agent','senior_agent','sub_agent')
      UNION SELECT sub_agent_id FROM public.agent_subagents WHERE coalesce(status,'') <> 'rejected'
      UNION SELECT coalesce(assigned_agent_id, agent_id) FROM public.rent_requests
      UNION SELECT agent_id FROM public.agent_collections
    ) a
   WHERE a.person_id IS NOT NULL
  UNION
  SELECT DISTINCT p.person_id, 'partner'::text
    FROM (
      SELECT investor_id AS person_id FROM public.investor_portfolios
      UNION SELECT funder_id FROM public.funder_pending_portfolios
    ) p
   WHERE p.person_id IS NOT NULL
  UNION
  SELECT DISTINCT l.person_id, 'landlord'::text
    FROM (
      SELECT landlord_id AS person_id FROM public.agent_landlord_float_allocations
      UNION SELECT landlord_id FROM public.landlord_float_receivables
      UNION SELECT landlord_id FROM public.agent_landlord_payouts
    ) l
   WHERE l.person_id IS NOT NULL
  UNION
  SELECT DISTINCT user_id, 'employee'::text
    FROM public.user_roles
   WHERE enabled = true AND role = 'employee' AND user_id IS NOT NULL;

GRANT SELECT ON public.v_crm_person_roles TO service_role;

-- Paginated platform-people roster: every profile, with the roles they hold.
CREATE OR REPLACE FUNCTION public.crm_platform_people_page(
  p_search text DEFAULT NULL,
  p_role text DEFAULT NULL,
  p_status text DEFAULT NULL,
  p_sort text DEFAULT 'name',
  p_limit integer DEFAULT 20,
  p_offset integer DEFAULT 0
) RETURNS TABLE (
  person_id uuid,
  name text,
  phone_masked text,
  has_phone boolean,
  location text,
  avatar_url text,
  roles text[],
  total_calls integer,
  summaries integer,
  first_called_at timestamptz,
  last_called_at timestamptz,
  last_outcome text,
  last_call_id uuid,
  total_rows bigint
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100);
  v_offset integer := GREATEST(COALESCE(p_offset, 0), 0);
  v_search text := NULLIF(btrim(COALESCE(p_search, '')), '');
  v_role text := NULLIF(btrim(COALESCE(p_role, '')), '');
  v_status text := NULLIF(btrim(COALESCE(p_status, '')), '');
  v_sort text := COALESCE(NULLIF(btrim(COALESCE(p_sort, '')), ''), 'name');
BEGIN
  IF NOT public.crm_call_centre_authorized(auth.uid()) THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  RETURN QUERY
  WITH agg AS (
    SELECT s.target_user_id AS pid,
           COUNT(*)::int AS calls,
           COUNT(*) FILTER (WHERE btrim(COALESCE(s.summary,'')) <> '')::int AS notes,
           MIN(s.created_at) AS first_at,
           MAX(s.created_at) AS last_at
      FROM public.crm_call_sessions s
     WHERE s.target_user_id IS NOT NULL
     GROUP BY s.target_user_id
  ),
  last_call AS (
    SELECT DISTINCT ON (s.target_user_id)
           s.target_user_id AS pid, s.id,
           public.crm_derive_outcome(s.status, s.hangup_cause, s.duration_seconds) AS outcome
      FROM public.crm_call_sessions s
     WHERE s.target_user_id IS NOT NULL
     ORDER BY s.target_user_id, s.created_at DESC
  ),
  base AS (
    SELECT pr.id, pr.full_name, pr.phone, pr.avatar_url,
           COALESCE(NULLIF(pr.district,''), NULLIF(pr.city,''), NULLIF(pr.region,'')) AS loc,
           pr.created_at,
           g.calls, g.notes, g.first_at, g.last_at,
           lc.id AS call_id, lc.outcome
      FROM public.profiles pr
      LEFT JOIN agg g ON g.pid = pr.id
      LEFT JOIN last_call lc ON lc.pid = pr.id
     WHERE (v_search IS NULL
            OR pr.full_name ILIKE '%' || v_search || '%'
            OR regexp_replace(COALESCE(pr.phone,''), '\D', '', 'g')
               LIKE '%' || regexp_replace(v_search, '\D', '', 'g') || '%')
       AND (v_role IS NULL OR EXISTS (
             SELECT 1 FROM public.v_crm_person_roles r
              WHERE r.person_id = pr.id AND r.role = v_role))
       AND (v_status IS NULL OR v_status = 'all'
            OR (v_status = 'never' AND lc.id IS NULL)
            OR (v_status <> 'never' AND lc.outcome = v_status))
  ),
  page AS (
    SELECT b.*, COUNT(*) OVER () AS total
      FROM base b
     ORDER BY
       CASE WHEN v_sort = 'recent_call' THEN b.last_at END DESC NULLS LAST,
       CASE WHEN v_sort = 'newest' THEN b.created_at END DESC NULLS LAST,
       b.full_name ASC NULLS LAST
     LIMIT v_limit OFFSET v_offset
  )
  SELECT p.id,
         COALESCE(NULLIF(btrim(p.full_name), ''), 'Unnamed user'),
         public.crm_mask_phone(p.phone),
         public.normalize_ug_phone(p.phone) IS NOT NULL,
         p.loc,
         p.avatar_url,
         COALESCE((SELECT array_agg(r.role ORDER BY r.role)
                     FROM public.v_crm_person_roles r WHERE r.person_id = p.id), '{}'::text[]),
         COALESCE(p.calls, 0),
         COALESCE(p.notes, 0),
         p.first_at,
         CASE WHEN p.last_at IS DISTINCT FROM p.first_at THEN p.last_at END,
         p.outcome,
         p.call_id,
         p.total
    FROM page p
   ORDER BY
     CASE WHEN v_sort = 'recent_call' THEN p.last_at END DESC NULLS LAST,
     CASE WHEN v_sort = 'newest' THEN p.created_at END DESC NULLS LAST,
     p.full_name ASC NULLS LAST;
END;
$$;

REVOKE ALL ON FUNCTION public.crm_platform_people_page(text,text,text,text,integer,integer) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.crm_platform_people_page(text,text,text,text,integer,integer) TO authenticated, service_role;

-- Audience mix across the whole platform (for the filter chips / overview).
CREATE OR REPLACE FUNCTION public.crm_platform_people_counts()
RETURNS TABLE (all_users bigint, tenants bigint, agents bigint, partners bigint, landlords bigint, employees bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.crm_call_centre_authorized(auth.uid()) THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;
  RETURN QUERY
  SELECT (SELECT COUNT(*) FROM public.profiles),
         COUNT(*) FILTER (WHERE r.role = 'tenant'),
         COUNT(*) FILTER (WHERE r.role = 'agent'),
         COUNT(*) FILTER (WHERE r.role = 'partner'),
         COUNT(*) FILTER (WHERE r.role = 'landlord'),
         COUNT(*) FILTER (WHERE r.role = 'employee')
    FROM public.v_crm_person_roles r;
END;
$$;

REVOKE ALL ON FUNCTION public.crm_platform_people_counts() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.crm_platform_people_counts() TO authenticated, service_role;