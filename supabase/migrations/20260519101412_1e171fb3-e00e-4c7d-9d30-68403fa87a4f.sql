CREATE OR REPLACE FUNCTION public.get_phantom_correction_drift_detail(
  p_user_id uuid,
  p_window_days integer DEFAULT 30
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_since timestamptz;
  v_summary jsonb;
  v_profile jsonb;
  v_entries jsonb;
  v_strict numeric;
BEGIN
  IF NOT (has_role(auth.uid(), 'cfo'::app_role) OR has_role(auth.uid(), 'manager'::app_role)) THEN
    RAISE EXCEPTION 'Access denied: CFO or Manager role required';
  END IF;

  v_since := now() - make_interval(days => GREATEST(p_window_days, 1));

  SELECT to_jsonb(p) - 'created_at' - 'updated_at'
    INTO v_profile
  FROM (
    SELECT pr.id, pr.full_name, pr.phone,
           w.withdrawable_balance AS cached_withdrawable,
           w.float_balance        AS cached_float,
           w.advance_balance      AS cached_advance,
           w.balance              AS cached_total
    FROM profiles pr
    LEFT JOIN wallets w ON w.user_id = pr.id
    WHERE pr.id = p_user_id
  ) p;

  SELECT COALESCE((get_user_wallet_view(p_user_id)->>'withdrawable')::numeric, 0)
    INTO v_strict;

  SELECT jsonb_build_object(
    'window_days', GREATEST(p_window_days, 1),
    'since', v_since,
    'admin_net', COALESCE(SUM(CASE WHEN gl.classification = 'admin_correction'
                                   THEN (CASE WHEN gl.direction = 'cash_in' THEN gl.amount ELSE -gl.amount END)
                                   ELSE 0 END), 0),
    'admin_abs', COALESCE(SUM(CASE WHEN gl.classification = 'admin_correction'
                                   THEN gl.amount ELSE 0 END), 0),
    'admin_count', COUNT(*) FILTER (WHERE gl.classification = 'admin_correction'),
    'production_net', COALESCE(SUM(CASE WHEN gl.classification <> 'admin_correction'
                                        THEN (CASE WHEN gl.direction = 'cash_in' THEN gl.amount ELSE -gl.amount END)
                                        ELSE 0 END), 0),
    'production_abs', COALESCE(SUM(CASE WHEN gl.classification <> 'admin_correction'
                                        THEN gl.amount ELSE 0 END), 0),
    'production_count', COUNT(*) FILTER (WHERE gl.classification <> 'admin_correction'),
    'strict_withdrawable', v_strict
  ) INTO v_summary
  FROM general_ledger gl
  WHERE gl.user_id = p_user_id
    AND gl.ledger_scope = 'wallet'
    AND gl.created_at >= v_since;

  SELECT COALESCE(jsonb_agg(row_to_json(t) ORDER BY (t.created_at) DESC), '[]'::jsonb)
    INTO v_entries
  FROM (
    SELECT gl.id,
           gl.created_at,
           gl.classification,
           gl.category,
           gl.direction,
           gl.amount,
           gl.description,
           gl.transaction_group_id,
           gl.linked_party
    FROM general_ledger gl
    WHERE gl.user_id = p_user_id
      AND gl.ledger_scope = 'wallet'
      AND gl.created_at >= v_since
    ORDER BY gl.created_at DESC
    LIMIT 2000
  ) t;

  RETURN jsonb_build_object(
    'profile', v_profile,
    'summary', v_summary,
    'entries', v_entries
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_phantom_correction_drift_detail(uuid, integer) FROM public;
GRANT EXECUTE ON FUNCTION public.get_phantom_correction_drift_detail(uuid, integer) TO authenticated;