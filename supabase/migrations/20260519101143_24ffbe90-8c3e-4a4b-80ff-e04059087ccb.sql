CREATE OR REPLACE FUNCTION public.get_phantom_correction_drift(
  p_window_days integer DEFAULT 30,
  p_min_admin_abs numeric DEFAULT 100000,
  p_ratio_threshold numeric DEFAULT 2.0
)
RETURNS TABLE (
  user_id uuid,
  full_name text,
  phone text,
  window_days integer,
  admin_net numeric,
  admin_abs numeric,
  production_net numeric,
  production_abs numeric,
  abs_ratio numeric,
  cached_withdrawable numeric,
  cached_float numeric,
  strict_withdrawable numeric,
  last_admin_at timestamptz,
  admin_entry_count integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT (has_role(auth.uid(), 'cfo'::app_role) OR has_role(auth.uid(), 'manager'::app_role)) THEN
    RAISE EXCEPTION 'Access denied: CFO or Manager role required';
  END IF;

  RETURN QUERY
  WITH win AS (
    SELECT (now() - make_interval(days => GREATEST(p_window_days, 1)))::timestamptz AS since
  ),
  agg AS (
    SELECT
      gl.user_id,
      SUM(CASE WHEN gl.classification = 'admin_correction'
               THEN (CASE WHEN gl.direction = 'cash_in' THEN gl.amount ELSE -gl.amount END)
               ELSE 0 END) AS admin_net,
      SUM(CASE WHEN gl.classification = 'admin_correction' THEN gl.amount ELSE 0 END) AS admin_abs,
      SUM(CASE WHEN gl.classification <> 'admin_correction'
               THEN (CASE WHEN gl.direction = 'cash_in' THEN gl.amount ELSE -gl.amount END)
               ELSE 0 END) AS production_net,
      SUM(CASE WHEN gl.classification <> 'admin_correction' THEN gl.amount ELSE 0 END) AS production_abs,
      MAX(CASE WHEN gl.classification = 'admin_correction' THEN gl.created_at END) AS last_admin_at,
      COUNT(*) FILTER (WHERE gl.classification = 'admin_correction')::int AS admin_entry_count
    FROM general_ledger gl, win
    WHERE gl.ledger_scope = 'wallet'
      AND gl.user_id IS NOT NULL
      AND gl.created_at >= win.since
    GROUP BY gl.user_id
  ),
  flagged AS (
    SELECT
      a.*,
      CASE
        WHEN a.production_abs = 0 AND a.admin_abs > 0 THEN 1e9
        WHEN a.production_abs = 0 THEN 0
        ELSE a.admin_abs / a.production_abs
      END AS abs_ratio
    FROM agg a
    WHERE a.admin_abs >= p_min_admin_abs
      AND (
        a.production_abs = 0
        OR (a.admin_abs / NULLIF(a.production_abs, 0)) >= p_ratio_threshold
        OR (a.admin_net > 0 AND a.production_net <= 0)
      )
  )
  SELECT
    f.user_id,
    COALESCE(p.full_name, '—') AS full_name,
    COALESCE(p.phone, '') AS phone,
    GREATEST(p_window_days, 1) AS window_days,
    f.admin_net,
    f.admin_abs,
    f.production_net,
    f.production_abs,
    ROUND(f.abs_ratio::numeric, 2) AS abs_ratio,
    COALESCE(w.withdrawable_balance, 0) AS cached_withdrawable,
    COALESCE(w.float_balance, 0) AS cached_float,
    COALESCE((get_user_wallet_view(f.user_id)->>'withdrawable')::numeric, 0) AS strict_withdrawable,
    f.last_admin_at,
    f.admin_entry_count
  FROM flagged f
  LEFT JOIN profiles p ON p.id = f.user_id
  LEFT JOIN wallets w ON w.user_id = f.user_id
  ORDER BY f.admin_abs DESC
  LIMIT 500;
END;
$$;

REVOKE ALL ON FUNCTION public.get_phantom_correction_drift(integer, numeric, numeric) FROM public;
GRANT EXECUTE ON FUNCTION public.get_phantom_correction_drift(integer, numeric, numeric) TO authenticated;