-- 1) Focused partial index for the supporter listing
CREATE INDEX IF NOT EXISTS idx_user_roles_supporter_active_created
  ON public.user_roles (created_at DESC, user_id)
  WHERE role = 'supporter' AND enabled = true;

-- 2) Per-investor lookup index for portfolio counts
CREATE INDEX IF NOT EXISTS idx_investor_portfolios_investor_id
  ON public.investor_portfolios (investor_id);

-- 3) Single-roundtrip page loader used by the Joined Partners panel
CREATE OR REPLACE FUNCTION public.list_joined_partners(
  p_limit  int DEFAULT 100,
  p_offset int DEFAULT 0
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_allowed boolean;
  v_total bigint;
  v_rows jsonb;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  -- Staff-only: managers, executives, operations, employees, HR, super admin.
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = v_caller
      AND ur.enabled = true
      AND ur.role IN (
        'manager','ceo','coo','cfo','cto','cmo','crm',
        'operations','super_admin','hr','employee'
      )
  ) INTO v_allowed;

  IF NOT v_allowed THEN
    RAISE EXCEPTION 'Insufficient privileges';
  END IF;

  -- Clamp paging.
  p_limit  := GREATEST(1, LEAST(COALESCE(p_limit, 100), 500));
  p_offset := GREATEST(0, COALESCE(p_offset, 0));

  -- Total uses the new partial index → fast index-only count.
  SELECT count(*) INTO v_total
  FROM public.user_roles
  WHERE role = 'supporter' AND enabled = true;

  -- One page, fully enriched in a single query.
  WITH page AS (
    SELECT ur.user_id, ur.created_at
    FROM public.user_roles ur
    WHERE ur.role = 'supporter' AND ur.enabled = true
    ORDER BY ur.created_at DESC
    LIMIT p_limit OFFSET p_offset
  ),
  enriched AS (
    SELECT
      pg.user_id,
      pg.created_at,
      COALESCE(pr.full_name, 'Unknown') AS full_name,
      COALESCE(pr.phone, '—')           AS phone,
      COALESCE(pc.portfolio_count, 0)   AS portfolio_count
    FROM page pg
    LEFT JOIN public.profiles pr ON pr.id = pg.user_id
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS portfolio_count
      FROM public.investor_portfolios ip
      WHERE ip.investor_id = pg.user_id
    ) pc ON true
  )
  SELECT COALESCE(
           jsonb_agg(
             jsonb_build_object(
               'user_id',         e.user_id,
               'created_at',      e.created_at,
               'full_name',       e.full_name,
               'phone',           e.phone,
               'portfolio_count', e.portfolio_count
             )
             ORDER BY e.created_at DESC
           ),
           '[]'::jsonb
         )
  INTO v_rows
  FROM enriched e;

  RETURN jsonb_build_object('rows', v_rows, 'total', v_total);
END;
$$;

REVOKE ALL ON FUNCTION public.list_joined_partners(int, int) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.list_joined_partners(int, int) TO authenticated;