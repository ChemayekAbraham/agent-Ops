-- Cursor-based loader for the Joined Partners panel.
-- Uses keyset pagination on (created_at DESC, user_id DESC) to avoid the
-- growing OFFSET cost and to defer all per-page work until the user actually
-- scrolls. Total count is only computed on the first page (no cursor) so
-- subsequent pages do zero count work.
CREATE OR REPLACE FUNCTION public.list_joined_partners_cursor(
  p_limit             int         DEFAULT 60,
  p_after_created_at  timestamptz DEFAULT NULL,
  p_after_user_id     uuid        DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller  uuid := auth.uid();
  v_allowed boolean;
  v_total   bigint;
  v_rows    jsonb;
  v_last    record;
  v_next    jsonb := NULL;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

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

  p_limit := GREATEST(1, LEAST(COALESCE(p_limit, 60), 200));

  -- Only the first page (no cursor) pays for the total count.
  IF p_after_created_at IS NULL THEN
    SELECT count(*) INTO v_total
    FROM public.user_roles
    WHERE role = 'supporter' AND enabled = true;
  ELSE
    v_total := NULL;
  END IF;

  WITH page AS (
    SELECT ur.user_id, ur.created_at
    FROM public.user_roles ur
    WHERE ur.role = 'supporter' AND ur.enabled = true
      AND (
        p_after_created_at IS NULL
        OR ur.created_at < p_after_created_at
        OR (ur.created_at = p_after_created_at AND ur.user_id < p_after_user_id)
      )
    ORDER BY ur.created_at DESC, ur.user_id DESC
    LIMIT p_limit
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
             ORDER BY e.created_at DESC, e.user_id DESC
           ),
           '[]'::jsonb
         )
  INTO v_rows
  FROM enriched e;

  -- Build the next cursor from the last row only if the page was full.
  IF jsonb_array_length(v_rows) = p_limit THEN
    SELECT (v_rows -> (jsonb_array_length(v_rows) - 1) ->> 'created_at') AS created_at,
           (v_rows -> (jsonb_array_length(v_rows) - 1) ->> 'user_id')    AS user_id
      INTO v_last;
    v_next := jsonb_build_object(
      'created_at', v_last.created_at,
      'user_id',    v_last.user_id
    );
  END IF;

  RETURN jsonb_build_object(
    'rows',        v_rows,
    'total',       v_total,
    'next_cursor', v_next
  );
END;
$$;

REVOKE ALL ON FUNCTION public.list_joined_partners_cursor(int, timestamptz, uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.list_joined_partners_cursor(int, timestamptz, uuid) TO authenticated;