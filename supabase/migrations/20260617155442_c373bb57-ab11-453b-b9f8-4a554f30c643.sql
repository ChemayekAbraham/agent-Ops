DROP FUNCTION IF EXISTS public.get_cfo_ledger_trail(integer, integer, text, text, text, timestamptz, timestamptz);

CREATE OR REPLACE FUNCTION public.get_cfo_ledger_trail(
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0,
  p_categories text[] DEFAULT NULL,
  p_classification text DEFAULT NULL,
  p_search text DEFAULT NULL,
  p_from timestamptz DEFAULT NULL,
  p_to timestamptz DEFAULT NULL
)
RETURNS TABLE (
  group_id uuid,
  transaction_date timestamptz,
  amount numeric,
  direction text,
  category text,
  classification text,
  ledger_scope text,
  description text,
  user_id uuid,
  actor_name text,
  wallet_bucket text,
  linked_party text,
  reference_id text,
  source_table text,
  source_id uuid,
  leg_count integer,
  total_count bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Restrict to CFO / manager only
  IF NOT (public.has_role(auth.uid(), 'cfo') OR public.has_role(auth.uid(), 'manager')) THEN
    RAISE EXCEPTION 'Not authorized: CFO or manager role required';
  END IF;

  RETURN QUERY
  WITH legs AS (
    SELECT
      COALESCE(gl.transaction_group_id, gl.id) AS grp,
      gl.id,
      gl.transaction_date,
      gl.created_at,
      gl.amount,
      gl.direction,
      gl.category,
      gl.description,
      gl.classification,
      gl.ledger_scope,
      gl.user_id,
      gl.wallet_bucket,
      gl.linked_party,
      gl.reference_id,
      gl.source_table,
      gl.source_id,
      ROW_NUMBER() OVER (
        PARTITION BY COALESCE(gl.transaction_group_id, gl.id)
        ORDER BY (gl.ledger_scope = 'wallet') DESC, (gl.user_id IS NOT NULL) DESC, gl.created_at
      ) AS rn
    FROM public.general_ledger gl
    WHERE (p_from IS NULL OR gl.transaction_date >= p_from)
      AND (p_to IS NULL OR gl.transaction_date <= p_to)
  ),
  grouped AS (
    SELECT
      l.grp,
      MAX(l.transaction_date) AS transaction_date,
      MAX(l.amount) AS amount,
      COUNT(*)::integer AS leg_count
    FROM legs l
    GROUP BY l.grp
  ),
  matched AS (
    SELECT
      g.grp AS group_id,
      g.transaction_date,
      g.amount,
      rep.direction,
      rep.category,
      rep.classification,
      rep.ledger_scope,
      rep.description,
      rep.user_id,
      COALESCE(p.full_name, NULLIF(rep.linked_party, ''), 'System') AS actor_name,
      rep.wallet_bucket,
      rep.linked_party,
      rep.reference_id,
      rep.source_table,
      rep.source_id,
      g.leg_count
    FROM grouped g
    JOIN legs rep ON rep.grp = g.grp AND rep.rn = 1
    LEFT JOIN public.profiles p ON p.id = rep.user_id
    WHERE (p_categories IS NULL OR rep.category = ANY(p_categories))
      AND (p_classification IS NULL OR rep.classification = p_classification)
      AND (
        p_search IS NULL OR p_search = '' OR
        rep.description ILIKE '%' || p_search || '%' OR
        rep.category ILIKE '%' || p_search || '%' OR
        rep.linked_party ILIKE '%' || p_search || '%' OR
        rep.reference_id ILIKE '%' || p_search || '%' OR
        p.full_name ILIKE '%' || p_search || '%'
      )
  )
  SELECT
    m.*,
    COUNT(*) OVER () AS total_count
  FROM matched m
  ORDER BY m.transaction_date DESC
  LIMIT GREATEST(1, LEAST(p_limit, 200))
  OFFSET GREATEST(0, p_offset);
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_cfo_ledger_trail(integer, integer, text[], text, text, timestamptz, timestamptz) TO authenticated;