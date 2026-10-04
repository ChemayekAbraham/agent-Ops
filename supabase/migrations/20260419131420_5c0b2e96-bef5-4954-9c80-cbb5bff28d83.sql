-- Server-side RPCs for Agent Directory at 1M+ scale
-- Pattern mirrors get_agent_ops_balances for proven scalability

-- 1. Totals RPC: single aggregate over user_roles, never transfers rows
CREATE OR REPLACE FUNCTION public.get_agent_directory_totals()
RETURNS TABLE (
  total_count BIGINT,
  verified_count BIGINT,
  with_territory BIGINT,
  active_30d BIGINT,
  new_30d BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    COUNT(*)::BIGINT AS total_count,
    COUNT(*) FILTER (WHERE p.verified IS TRUE)::BIGINT AS verified_count,
    COUNT(*) FILTER (WHERE p.territory IS NOT NULL AND p.territory <> '')::BIGINT AS with_territory,
    COUNT(*) FILTER (WHERE p.last_active_at >= now() - interval '30 days')::BIGINT AS active_30d,
    COUNT(*) FILTER (WHERE p.created_at >= now() - interval '30 days')::BIGINT AS new_30d
  FROM public.user_roles ur
  LEFT JOIN public.profiles p ON p.id = ur.user_id
  WHERE ur.role = 'agent';
$$;

-- 2. Paginated/sortable/searchable rows RPC
CREATE OR REPLACE FUNCTION public.get_agent_directory_rows(
  _search TEXT DEFAULT NULL,
  _sort TEXT DEFAULT 'name',
  _verified_only BOOLEAN DEFAULT FALSE,
  _limit INT DEFAULT 50,
  _offset INT DEFAULT 0
)
RETURNS TABLE (
  user_id UUID,
  full_name TEXT,
  phone TEXT,
  email TEXT,
  avatar_url TEXT,
  verified BOOLEAN,
  created_at TIMESTAMPTZ,
  territory TEXT,
  last_active_at TIMESTAMPTZ,
  total_matched BIGINT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_limit INT := LEAST(GREATEST(COALESCE(_limit, 50), 1), 200);
  v_offset INT := GREATEST(COALESCE(_offset, 0), 0);
  v_search TEXT := NULLIF(TRIM(COALESCE(_search, '')), '');
  v_search_pattern TEXT;
  v_search_digits TEXT;
BEGIN
  IF v_search IS NOT NULL THEN
    v_search_pattern := '%' || lower(v_search) || '%';
    v_search_digits := regexp_replace(v_search, '\D', '', 'g');
    IF v_search_digits = '' THEN v_search_digits := NULL; END IF;
  END IF;

  RETURN QUERY
  WITH base AS (
    SELECT
      ur.user_id,
      p.full_name,
      p.phone,
      p.email,
      p.avatar_url,
      p.verified,
      p.created_at,
      p.territory,
      p.last_active_at
    FROM public.user_roles ur
    LEFT JOIN public.profiles p ON p.id = ur.user_id
    WHERE ur.role = 'agent'
      AND (NOT _verified_only OR p.verified IS TRUE)
      AND (
        v_search IS NULL
        OR lower(COALESCE(p.full_name, '')) LIKE v_search_pattern
        OR lower(COALESCE(p.email, '')) LIKE v_search_pattern
        OR lower(COALESCE(p.territory, '')) LIKE v_search_pattern
        OR (v_search_digits IS NOT NULL AND regexp_replace(COALESCE(p.phone, ''), '\D', '', 'g') LIKE '%' || v_search_digits || '%')
        OR ur.user_id::text ILIKE v_search_pattern
      )
  ),
  counted AS (
    SELECT *, COUNT(*) OVER ()::BIGINT AS total_matched FROM base
  )
  SELECT
    c.user_id, c.full_name, c.phone, c.email, c.avatar_url,
    c.verified, c.created_at, c.territory, c.last_active_at,
    c.total_matched
  FROM counted c
  ORDER BY
    CASE WHEN _sort = 'name' THEN lower(c.full_name) END ASC NULLS LAST,
    CASE WHEN _sort = 'recent' THEN c.created_at END DESC NULLS LAST,
    CASE WHEN _sort = 'active' THEN c.last_active_at END DESC NULLS LAST,
    CASE WHEN _sort = 'territory' THEN lower(c.territory) END ASC NULLS LAST,
    c.user_id  -- stable tiebreaker
  LIMIT v_limit
  OFFSET v_offset;
END;
$$;

-- Permissions: only callable via edge function with service role; revoke from public
REVOKE ALL ON FUNCTION public.get_agent_directory_totals() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_agent_directory_rows(TEXT, TEXT, BOOLEAN, INT, INT) FROM PUBLIC, anon, authenticated;

-- Helpful indexes (idempotent via IF NOT EXISTS)
CREATE INDEX IF NOT EXISTS idx_profiles_full_name_lower ON public.profiles (lower(full_name));
CREATE INDEX IF NOT EXISTS idx_profiles_email_lower ON public.profiles (lower(email));
CREATE INDEX IF NOT EXISTS idx_profiles_territory_lower ON public.profiles (lower(territory));
CREATE INDEX IF NOT EXISTS idx_profiles_last_active_at ON public.profiles (last_active_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_profiles_created_at ON public.profiles (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_roles_role_user ON public.user_roles (role, user_id);