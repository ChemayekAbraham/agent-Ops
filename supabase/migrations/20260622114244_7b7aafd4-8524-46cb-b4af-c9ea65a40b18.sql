-- Recreate CRM directory functions with tenant lifecycle stage classification.
DROP FUNCTION IF EXISTS public.get_crm_directory(app_role, text, int, int);
DROP FUNCTION IF EXISTS public.get_crm_directory_totals(app_role);

CREATE OR REPLACE FUNCTION public.get_crm_directory(
  _role app_role,
  _search text DEFAULT NULL,
  _stage text DEFAULT NULL,
  _limit int DEFAULT 50,
  _offset int DEFAULT 0
)
RETURNS TABLE (
  id uuid,
  full_name text,
  phone text,
  email text,
  avatar_url text,
  verified boolean,
  created_at timestamptz,
  last_active_at timestamptz,
  city text,
  district text,
  region text,
  territory text,
  national_id text,
  tenant_status text,
  agent_type text,
  monthly_rent numeric,
  stage text,
  total_matched bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'crm') OR
    public.has_role(auth.uid(), 'manager') OR
    public.has_role(auth.uid(), 'coo') OR
    public.has_role(auth.uid(), 'ceo') OR
    public.has_role(auth.uid(), 'super_admin') OR
    public.has_role(auth.uid(), 'cto')
  ) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;

  _limit := least(greatest(coalesce(_limit, 50), 1), 200);
  _offset := greatest(coalesce(_offset, 0), 0);

  RETURN QUERY
  WITH matched AS (
    SELECT
      p.*,
      CASE
        WHEN rr.has_paid THEN 'paid'
        WHEN rr.has_funded OR p.verified THEN 'verified'
        WHEN rr.has_processing THEN 'processing'
        ELSE 'rent_request'
      END AS stage_val,
      CASE
        WHEN rr.has_paid THEN 4
        WHEN rr.has_funded OR p.verified THEN 3
        WHEN rr.has_processing THEN 2
        ELSE 1
      END AS stage_rank
    FROM public.profiles p
    JOIN public.user_roles ur ON ur.user_id = p.id AND ur.role = _role
    LEFT JOIN LATERAL (
      SELECT
        bool_or(rrq.status IN ('disbursed','repaying','completed','fully_repaid')
                OR coalesce(rrq.amount_repaid, 0) > 0) AS has_paid,
        bool_or(rrq.status = 'funded') AS has_funded,
        bool_or(rrq.status IN ('agent_ops_approved','tenant_ops_approved',
                'landlord_ops_approved','coo_approved','approved','agent_verified')) AS has_processing,
        bool_or(rrq.status = 'pending') AS has_request
      FROM public.rent_requests rrq
      WHERE rrq.tenant_id = p.id
        AND rrq.status NOT IN ('rejected','deleted_by_agent')
    ) rr ON _role = 'tenant'
    WHERE (
      _search IS NULL OR _search = '' OR (
        p.full_name ILIKE '%' || _search || '%' OR
        p.phone ILIKE '%' || _search || '%' OR
        p.email ILIKE '%' || _search || '%' OR
        p.national_id ILIKE '%' || _search || '%' OR
        p.city ILIKE '%' || _search || '%' OR
        p.district ILIKE '%' || _search || '%' OR
        p.territory ILIKE '%' || _search || '%'
      )
    )
  )
  SELECT
    m.id, m.full_name, m.phone, m.email, m.avatar_url, m.verified,
    m.created_at, m.last_active_at, m.city, m.district, m.region,
    m.territory, m.national_id, m.tenant_status, m.agent_type, m.monthly_rent,
    m.stage_val AS stage,
    count(*) OVER() AS total_matched
  FROM matched m
  WHERE _stage IS NULL OR _stage = '' OR m.stage_val = _stage
  ORDER BY m.stage_rank ASC, m.created_at DESC NULLS LAST
  LIMIT _limit OFFSET _offset;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_crm_directory_totals(_role app_role)
RETURNS TABLE (
  total bigint,
  verified bigint,
  active30d bigint,
  new30d bigint,
  rent_request bigint,
  processing bigint,
  stage_verified bigint,
  paid bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'crm') OR
    public.has_role(auth.uid(), 'manager') OR
    public.has_role(auth.uid(), 'coo') OR
    public.has_role(auth.uid(), 'ceo') OR
    public.has_role(auth.uid(), 'super_admin') OR
    public.has_role(auth.uid(), 'cto')
  ) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;

  RETURN QUERY
  WITH base AS (
    SELECT
      p.verified,
      p.last_active_at,
      p.created_at,
      CASE
        WHEN rr.has_paid THEN 'paid'
        WHEN rr.has_funded OR p.verified THEN 'verified'
        WHEN rr.has_processing THEN 'processing'
        ELSE 'rent_request'
      END AS stage_val
    FROM public.profiles p
    JOIN public.user_roles ur ON ur.user_id = p.id AND ur.role = _role
    LEFT JOIN LATERAL (
      SELECT
        bool_or(rrq.status IN ('disbursed','repaying','completed','fully_repaid')
                OR coalesce(rrq.amount_repaid, 0) > 0) AS has_paid,
        bool_or(rrq.status = 'funded') AS has_funded,
        bool_or(rrq.status IN ('agent_ops_approved','tenant_ops_approved',
                'landlord_ops_approved','coo_approved','approved','agent_verified')) AS has_processing,
        bool_or(rrq.status = 'pending') AS has_request
      FROM public.rent_requests rrq
      WHERE rrq.tenant_id = p.id
        AND rrq.status NOT IN ('rejected','deleted_by_agent')
    ) rr ON _role = 'tenant'
  )
  SELECT
    count(*)::bigint AS total,
    count(*) FILTER (WHERE verified)::bigint AS verified,
    count(*) FILTER (WHERE last_active_at >= now() - interval '30 days')::bigint AS active30d,
    count(*) FILTER (WHERE created_at >= now() - interval '30 days')::bigint AS new30d,
    count(*) FILTER (WHERE stage_val = 'rent_request')::bigint AS rent_request,
    count(*) FILTER (WHERE stage_val = 'processing')::bigint AS processing,
    count(*) FILTER (WHERE stage_val = 'verified')::bigint AS stage_verified,
    count(*) FILTER (WHERE stage_val = 'paid')::bigint AS paid
  FROM base;
END;
$$;

REVOKE ALL ON FUNCTION public.get_crm_directory(app_role, text, text, int, int) FROM public, anon;
REVOKE ALL ON FUNCTION public.get_crm_directory_totals(app_role) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.get_crm_directory(app_role, text, text, int, int) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_crm_directory_totals(app_role) TO authenticated;