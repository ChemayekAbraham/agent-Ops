-- 1) Per-user wallet projection refresh: stop scanning the whole ledger.
CREATE OR REPLACE FUNCTION public.refresh_wallet_projection_for(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_prior_float_raw numeric := 0;
  v_prior_float_balance numeric := 0;
  v_s record;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN;
  END IF;

  SELECT float_balance_raw, float_balance
    INTO v_prior_float_raw, v_prior_float_balance
  FROM public.wallet_balances_projection
  WHERE user_id = p_user_id;

  -- Same strict pivot maths, evaluated for ONE user. v_user_wallet_strict
  -- materialises its CTEs over the entire ledger (~8s per call), which is what
  -- made desk-float corrections and the FinOps float board time out.
  SELECT s.withdrawable, s.float_balance, s.advance_balance,
         s.pending_holds, s.restricted_held, s.total_visible,
         s.float_balance_signed
    INTO v_s
  FROM public.wallet_strict_for_user(p_user_id) s;

  IF v_s IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO public.wallet_balances_projection AS w (
    user_id, withdrawable, float_balance, float_balance_raw,
    advance_balance, pending_holds, restricted_held, total_visible,
    ledger_version, updated_at
  ) VALUES (
    p_user_id,
    COALESCE(v_s.withdrawable, 0),
    COALESCE(v_s.float_balance, 0),
    COALESCE(v_s.float_balance_signed, 0),
    COALESCE(v_s.advance_balance, 0),
    COALESCE(v_s.pending_holds, 0),
    COALESCE(v_s.restricted_held, 0),
    COALESCE(v_s.total_visible, 0),
    1,
    now()
  )
  ON CONFLICT (user_id) DO UPDATE
    SET withdrawable = EXCLUDED.withdrawable,
        float_balance = EXCLUDED.float_balance,
        float_balance_raw = EXCLUDED.float_balance_raw,
        advance_balance = EXCLUDED.advance_balance,
        pending_holds = EXCLUDED.pending_holds,
        restricted_held = EXCLUDED.restricted_held,
        total_visible = EXCLUDED.total_visible,
        ledger_version = w.ledger_version + 1,
        updated_at = now();

  IF COALESCE(v_s.float_balance_signed, 0) < 0
     AND COALESCE(v_s.float_balance_signed, 0) IS DISTINCT FROM v_prior_float_raw THEN
    INSERT INTO public.wallet_overdraw_events
      (user_id, attempted_balance, clamped_to, float_before, float_after, trigger_op)
    VALUES (p_user_id, v_s.float_balance_signed, 0,
            COALESCE(v_prior_float_balance, 0), COALESCE(v_s.float_balance, 0),
            'refresh_wallet_projection_for:float');
  END IF;
END;
$function$;

-- 2) Supporting index for the "newest wallet leg" staleness probes.
CREATE INDEX IF NOT EXISTS idx_gl_wallet_user_created_scope
  ON public.general_ledger (user_id, created_at DESC)
  WHERE ledger_scope = 'wallet';

-- 3) Merchant float board: replace the N per-agent correlated staleness checks
--    with one set-based scan, repairing only the desks that are actually stale.
DO $do$
DECLARE
  v_def text;
  v_old text;
  v_new text;
BEGIN
  v_def := pg_get_functiondef('public.get_merchant_float_positions'::regproc);

  v_old := '  FOR v_agent_id IN
    SELECT DISTINCT ca.agent_id FROM public.cashout_agents ca WHERE ca.agent_id IS NOT NULL
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM public.wallet_balances_projection w
      WHERE w.user_id = v_agent_id
        AND w.updated_at >= COALESCE((
          SELECT MAX(g.created_at) FROM public.general_ledger g
          WHERE g.user_id = v_agent_id AND g.ledger_scope = ''wallet''
        ), w.updated_at)
    ) THEN
      PERFORM public.refresh_wallet_projection_for(v_agent_id);
    END IF;
  END LOOP;';

  v_new := '  FOR v_agent_id IN
    SELECT ag.agent_id
    FROM (SELECT DISTINCT ca.agent_id FROM public.cashout_agents ca WHERE ca.agent_id IS NOT NULL) ag
    LEFT JOIN public.wallet_balances_projection w ON w.user_id = ag.agent_id
    WHERE w.user_id IS NULL
       OR w.updated_at < COALESCE((
            SELECT MAX(g.created_at) FROM public.general_ledger g
            WHERE g.user_id = ag.agent_id AND g.ledger_scope = ''wallet''
          ), w.updated_at)
  LOOP
    PERFORM public.refresh_wallet_projection_for(v_agent_id);
  END LOOP;';

  IF position(v_old in v_def) = 0 THEN
    RAISE EXCEPTION 'get_merchant_float_positions read-repair loop not found; aborting rewrite';
  END IF;

  EXECUTE replace(v_def, v_old, v_new);
END
$do$;