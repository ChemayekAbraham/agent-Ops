CREATE OR REPLACE VIEW public.v_user_wallet_strict AS
WITH anchors AS (
  SELECT user_id, anchor_at FROM public.wallet_fresh_start_anchors
), ledger AS (
  SELECT gl.user_id, gl.category, gl.direction, gl.amount
  FROM public.general_ledger gl
  LEFT JOIN anchors a ON a.user_id = gl.user_id
  WHERE gl.ledger_scope = 'wallet'
    AND (gl.classification IS NULL OR gl.classification = 'production')
    AND COALESCE(gl.category, '') <> 'system_balance_correction'
    AND (a.anchor_at IS NULL OR gl.created_at >= a.anchor_at)
), buckets AS (
  SELECT
    user_id,
    SUM(
      CASE
        WHEN COALESCE(category, '') NOT IN (
          'agent_float_deposit',
          'agent_float_used_for_rent',
          'agent_float_settlement',
          'agent_float_assignment',
          'rent_float_funding',
          'partner_funding'
        )
        AND COALESCE(category, '') NOT LIKE 'advance_%'
        THEN CASE
          WHEN direction = 'cash_in' THEN amount
          WHEN direction = 'cash_out' THEN -amount
          ELSE 0
        END
        ELSE 0
      END
    )::numeric AS withdrawable_raw,
    SUM(
      CASE
        WHEN COALESCE(category, '') IN (
          'agent_float_deposit',
          'agent_float_used_for_rent',
          'agent_float_settlement',
          'agent_float_assignment',
          'rent_float_funding',
          'partner_funding'
        )
        THEN CASE
          WHEN direction = 'cash_in' THEN amount
          WHEN direction = 'cash_out' THEN -amount
          ELSE 0
        END
        ELSE 0
      END
    )::numeric AS float_raw,
    SUM(
      CASE
        WHEN COALESCE(category, '') LIKE 'advance_%'
        THEN CASE
          WHEN direction = 'cash_in' THEN amount
          WHEN direction = 'cash_out' THEN -amount
          ELSE 0
        END
        ELSE 0
      END
    )::numeric AS advance_raw
  FROM ledger
  GROUP BY user_id
), holds AS (
  SELECT user_id, COALESCE(SUM(amount), 0)::numeric AS pending_holds
  FROM public.withdrawal_requests
  WHERE status IN ('pending', 'requested', 'manager_approved', 'processing')
  GROUP BY user_id
), universe AS (
  SELECT user_id FROM public.wallets
  UNION
  SELECT user_id FROM buckets
  UNION
  SELECT user_id FROM holds
)
SELECT
  u.user_id,
  GREATEST(0, COALESCE(b.withdrawable_raw, 0) - COALESCE(h.pending_holds, 0))::numeric AS withdrawable,
  GREATEST(0, COALESCE(b.float_raw, 0))::numeric AS float_balance,
  GREATEST(0, COALESCE(b.advance_raw, 0))::numeric AS advance_balance,
  COALESCE(h.pending_holds, 0)::numeric AS pending_holds,
  (
    GREATEST(0, COALESCE(b.withdrawable_raw, 0) - COALESCE(h.pending_holds, 0))
    + GREATEST(0, COALESCE(b.float_raw, 0))
  )::numeric AS total_visible
FROM universe u
LEFT JOIN buckets b ON b.user_id = u.user_id
LEFT JOIN holds h ON h.user_id = u.user_id;

CREATE OR REPLACE FUNCTION public.get_user_available_balance(p_user_id uuid)
RETURNS numeric
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _ledger_net_now numeric := 0;
  _pending_holds numeric := 0;
  _anchor_at timestamptz;
BEGIN
  SELECT anchor_at INTO _anchor_at
  FROM public.wallet_fresh_start_anchors
  WHERE user_id = p_user_id;

  SELECT COALESCE(SUM(CASE WHEN direction = 'cash_in' THEN amount
                           WHEN direction = 'cash_out' THEN -amount
                           ELSE 0 END), 0)
    INTO _ledger_net_now
  FROM public.general_ledger
  WHERE user_id = p_user_id
    AND ledger_scope = 'wallet'
    AND (classification IS NULL OR classification = 'production')
    AND COALESCE(category, '') <> 'system_balance_correction'
    AND (_anchor_at IS NULL OR created_at >= _anchor_at)
    AND COALESCE(category, '') NOT IN (
      'agent_float_deposit',
      'agent_float_used_for_rent',
      'agent_float_settlement',
      'agent_float_assignment',
      'rent_float_funding',
      'partner_funding'
    )
    AND COALESCE(category, '') NOT LIKE 'advance_%';

  SELECT COALESCE(SUM(amount), 0)
    INTO _pending_holds
  FROM public.withdrawal_requests
  WHERE user_id = p_user_id
    AND status IN ('pending','requested','manager_approved','processing');

  RETURN GREATEST(0, GREATEST(0, _ledger_net_now) - COALESCE(_pending_holds, 0));
END;
$function$;

CREATE OR REPLACE FUNCTION public.search_wallets_by_balance(
  p_min_balance numeric DEFAULT 0,
  p_max_balance numeric DEFAULT 999999999999,
  p_limit integer DEFAULT 50
)
RETURNS TABLE(
  user_id uuid,
  full_name text,
  phone text,
  balance numeric,
  withdrawable_balance numeric,
  float_balance numeric
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT
    s.user_id,
    p.full_name,
    p.phone,
    COALESCE(s.total_visible, 0)::numeric AS balance,
    COALESCE(s.withdrawable, 0)::numeric AS withdrawable_balance,
    COALESCE(s.float_balance, 0)::numeric AS float_balance
  FROM public.v_user_wallet_strict s
  JOIN public.profiles p ON p.id = s.user_id
  WHERE COALESCE(s.total_visible, 0) >= p_min_balance
    AND COALESCE(s.total_visible, 0) <= p_max_balance
  ORDER BY s.withdrawable DESC NULLS LAST, s.total_visible DESC
  LIMIT p_limit;
$function$;

CREATE OR REPLACE FUNCTION public.get_wallet_totals()
RETURNS json
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $function$
  WITH wallet_count AS (
    SELECT COUNT(*) AS total_wallets
    FROM public.wallets
    WHERE user_id <> '06b14430-7cdc-41c9-96a4-a8dedf8995b1'::uuid
  ), strict_totals AS (
    SELECT
      COUNT(*) FILTER (WHERE COALESCE(total_visible, 0) > 0) AS active_wallets,
      COALESCE(SUM(COALESCE(total_visible, 0)), 0) AS total_balance
    FROM public.v_user_wallet_strict
    WHERE user_id <> '06b14430-7cdc-41c9-96a4-a8dedf8995b1'::uuid
  )
  SELECT json_build_object(
    'total_wallets', wallet_count.total_wallets,
    'active_wallets', strict_totals.active_wallets,
    'total_balance', strict_totals.total_balance
  )
  FROM wallet_count, strict_totals;
$function$;

CREATE OR REPLACE FUNCTION public.get_wallet_totals_strict()
RETURNS json
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH targets AS (
    SELECT
      w.user_id,
      COALESCE(w.balance, 0)::numeric AS cached_balance,
      (COALESCE(t.target_withdrawable, 0) + COALESCE(t.target_float, 0))::numeric AS ledger_cache_target,
      COALESCE(s.total_visible, 0)::numeric AS strict_total_visible
    FROM public.wallets w
    LEFT JOIN LATERAL (
      WITH anchor AS (
        SELECT anchor_at FROM public.wallet_fresh_start_anchors WHERE user_id = w.user_id
      ), ledger AS (
        SELECT gl.category, gl.direction, gl.amount
        FROM public.general_ledger gl
        LEFT JOIN anchor a ON true
        WHERE gl.user_id = w.user_id
          AND gl.ledger_scope = 'wallet'
          AND (gl.classification IS NULL OR gl.classification = 'production')
          AND COALESCE(gl.category, '') <> 'system_balance_correction'
          AND (a.anchor_at IS NULL OR gl.created_at >= a.anchor_at)
      )
      SELECT
        GREATEST(0, COALESCE(SUM(CASE
          WHEN COALESCE(category, '') NOT IN ('agent_float_deposit','agent_float_used_for_rent','agent_float_settlement','agent_float_assignment','rent_float_funding','partner_funding')
           AND COALESCE(category, '') NOT LIKE 'advance_%'
          THEN CASE WHEN direction = 'cash_in' THEN amount WHEN direction = 'cash_out' THEN -amount ELSE 0 END
          ELSE 0 END), 0))::numeric AS target_withdrawable,
        GREATEST(0, COALESCE(SUM(CASE
          WHEN COALESCE(category, '') IN ('agent_float_deposit','agent_float_used_for_rent','agent_float_settlement','agent_float_assignment','rent_float_funding','partner_funding')
          THEN CASE WHEN direction = 'cash_in' THEN amount WHEN direction = 'cash_out' THEN -amount ELSE 0 END
          ELSE 0 END), 0))::numeric AS target_float
      FROM ledger
    ) t ON true
    LEFT JOIN public.v_user_wallet_strict s ON s.user_id = w.user_id
    WHERE w.user_id <> '06b14430-7cdc-41c9-96a4-a8dedf8995b1'::uuid
  )
  SELECT json_build_object(
    'strict_total', COALESCE(SUM(strict_total_visible), 0),
    'drifted_wallets', COUNT(*) FILTER (WHERE ABS(cached_balance - ledger_cache_target) > 100),
    'total_drift', COALESCE(SUM(GREATEST(cached_balance - ledger_cache_target, 0)), 0)
  )
  FROM targets;
$function$;

CREATE OR REPLACE FUNCTION public.reconcile_wallet_cache_to_ledger(
  p_reason text DEFAULT 'Production ledger-only wallet cache reconciliation'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_authorized boolean := false;
  v_result jsonb;
BEGIN
  IF p_reason IS NULL OR length(trim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'reconcile_wallet_cache_to_ledger: reason must be at least 10 characters';
  END IF;

  IF v_caller IS NULL THEN
    v_authorized := true;
  ELSE
    SELECT EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = v_caller
        AND role::text IN ('cfo','super_admin','manager')
        AND COALESCE(enabled, true) = true
    ) INTO v_authorized;
  END IF;

  IF NOT v_authorized THEN
    RAISE EXCEPTION 'reconcile_wallet_cache_to_ledger: caller is not authorized';
  END IF;

  PERFORM set_config('wallet.sync_authorized', 'true', true);

  WITH wallet_base AS (
    SELECT
      w.user_id,
      COALESCE(w.balance, 0)::numeric AS cached_balance,
      COALESCE(w.withdrawable_balance, 0)::numeric AS cached_withdrawable,
      COALESCE(w.float_balance, 0)::numeric AS cached_float,
      COALESCE(w.advance_balance, 0)::numeric AS cached_advance,
      a.anchor_at
    FROM public.wallets w
    LEFT JOIN public.wallet_fresh_start_anchors a ON a.user_id = w.user_id
  ), ledger_rollup AS (
    SELECT
      wb.user_id,
      COALESCE(SUM(CASE
        WHEN COALESCE(gl.category, '') NOT IN ('agent_float_deposit','agent_float_used_for_rent','agent_float_settlement','agent_float_assignment','rent_float_funding','partner_funding')
         AND COALESCE(gl.category, '') NOT LIKE 'advance_%'
        THEN CASE WHEN gl.direction = 'cash_in' THEN gl.amount WHEN gl.direction = 'cash_out' THEN -gl.amount ELSE 0 END
        ELSE 0 END), 0)::numeric AS withdrawable_raw,
      COALESCE(SUM(CASE
        WHEN COALESCE(gl.category, '') IN ('agent_float_deposit','agent_float_used_for_rent','agent_float_settlement','agent_float_assignment','rent_float_funding','partner_funding')
        THEN CASE WHEN gl.direction = 'cash_in' THEN gl.amount WHEN gl.direction = 'cash_out' THEN -gl.amount ELSE 0 END
        ELSE 0 END), 0)::numeric AS float_raw,
      COALESCE(SUM(CASE
        WHEN COALESCE(gl.category, '') LIKE 'advance_%'
        THEN CASE WHEN gl.direction = 'cash_in' THEN gl.amount WHEN gl.direction = 'cash_out' THEN -gl.amount ELSE 0 END
        ELSE 0 END), 0)::numeric AS advance_raw
    FROM wallet_base wb
    LEFT JOIN public.general_ledger gl ON gl.user_id = wb.user_id
      AND gl.ledger_scope = 'wallet'
      AND (gl.classification IS NULL OR gl.classification = 'production')
      AND COALESCE(gl.category, '') <> 'system_balance_correction'
      AND (wb.anchor_at IS NULL OR gl.created_at >= wb.anchor_at)
    GROUP BY wb.user_id
  ), targets AS (
    SELECT
      wb.user_id,
      wb.cached_balance,
      wb.cached_withdrawable,
      wb.cached_float,
      wb.cached_advance,
      GREATEST(0, lr.withdrawable_raw)::numeric AS target_withdrawable,
      GREATEST(0, lr.float_raw)::numeric AS target_float,
      GREATEST(0, lr.advance_raw)::numeric AS target_advance,
      (GREATEST(0, lr.withdrawable_raw) + GREATEST(0, lr.float_raw))::numeric AS target_balance
    FROM wallet_base wb
    JOIN ledger_rollup lr ON lr.user_id = wb.user_id
  ), updated AS (
    UPDATE public.wallets w
       SET withdrawable_balance = t.target_withdrawable,
           float_balance = t.target_float,
           advance_balance = t.target_advance,
           balance = t.target_balance,
           updated_at = now()
      FROM targets t
     WHERE w.user_id = t.user_id
       AND (
         ABS(COALESCE(w.withdrawable_balance, 0) - t.target_withdrawable) > 1
         OR ABS(COALESCE(w.float_balance, 0) - t.target_float) > 1
         OR ABS(COALESCE(w.advance_balance, 0) - t.target_advance) > 1
         OR ABS(COALESCE(w.balance, 0) - t.target_balance) > 1
       )
     RETURNING
       t.user_id,
       t.cached_balance,
       t.cached_withdrawable,
       t.cached_float,
       t.cached_advance,
       t.target_balance,
       t.target_withdrawable,
       t.target_float,
       t.target_advance
  )
  SELECT jsonb_build_object(
    'status', 'reconciled',
    'reason', p_reason,
    'wallets_updated', COUNT(*),
    'balance_delta', COALESCE(SUM(target_balance - cached_balance), 0),
    'withdrawable_delta', COALESCE(SUM(target_withdrawable - cached_withdrawable), 0),
    'float_delta', COALESCE(SUM(target_float - cached_float), 0),
    'advance_delta', COALESCE(SUM(target_advance - cached_advance), 0),
    'sample_user_ids', COALESCE(jsonb_agg(user_id ORDER BY ABS(target_balance - cached_balance) DESC) FILTER (WHERE user_id IS NOT NULL), '[]'::jsonb)
  ) INTO v_result
  FROM updated;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, action, metadata)
  VALUES (
    v_caller,
    'wallet_cache_auto_reconciliation',
    'wallets',
    'bulk',
    'reconcile_cache_to_production_ledger',
    v_result || jsonb_build_object('reason', p_reason)
  );

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.reconcile_wallet_cache_to_ledger(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reconcile_wallet_cache_to_ledger(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_user_available_balance(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.search_wallets_by_balance(numeric, numeric, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_wallet_totals() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_wallet_totals_strict() TO authenticated, service_role;
GRANT SELECT ON public.v_user_wallet_strict TO authenticated, service_role;

SELECT public.reconcile_wallet_cache_to_ledger('Production ledger-only cache sweep');