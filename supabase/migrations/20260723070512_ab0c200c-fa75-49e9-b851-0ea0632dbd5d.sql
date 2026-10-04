
-- 1. Authoritative wallet RPC: ledger balance is the truth; cache/drift shown for diagnostics only
CREATE OR REPLACE FUNCTION public.get_authoritative_wallet(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_strict record;
  v_cache  record;
BEGIN
  SELECT withdrawable, float_balance, advance_balance, pending_holds
    INTO v_strict
    FROM public.v_user_wallet_strict
   WHERE user_id = p_user_id;

  SELECT COALESCE(withdrawable_balance,0) AS c_with,
         COALESCE(float_balance,0)         AS c_float,
         COALESCE(advance_balance,0)       AS c_adv
    INTO v_cache
    FROM public.wallets
   WHERE user_id = p_user_id;

  RETURN jsonb_build_object(
    'user_id', p_user_id,
    'withdrawable', COALESCE(v_strict.withdrawable, 0),
    'float',        COALESCE(v_strict.float_balance, 0),
    'advance',      COALESCE(v_strict.advance_balance, 0),
    'pending_holds',COALESCE(v_strict.pending_holds, 0),
    'cache', jsonb_build_object(
      'withdrawable', COALESCE(v_cache.c_with, 0),
      'float',        COALESCE(v_cache.c_float, 0),
      'advance',      COALESCE(v_cache.c_adv, 0)
    ),
    'drift', jsonb_build_object(
      'withdrawable', COALESCE(v_cache.c_with, 0)  - COALESCE(v_strict.withdrawable, 0),
      'float',        COALESCE(v_cache.c_float, 0) - COALESCE(v_strict.float_balance, 0),
      'advance',      COALESCE(v_cache.c_adv, 0)   - COALESCE(v_strict.advance_balance, 0)
    )
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_authoritative_wallet(uuid) TO authenticated, service_role;

-- 2. Repair function: snap wallets.* cache columns to ledger figures for a single user
CREATE OR REPLACE FUNCTION public.repair_wallet_cache_for_user(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_strict record;
  v_before record;
BEGIN
  SELECT withdrawable, float_balance, advance_balance
    INTO v_strict
    FROM public.v_user_wallet_strict
   WHERE user_id = p_user_id;

  IF v_strict IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_strict_row');
  END IF;

  SELECT COALESCE(withdrawable_balance,0) AS w,
         COALESCE(float_balance,0)         AS f,
         COALESCE(advance_balance,0)       AS a
    INTO v_before
    FROM public.wallets
   WHERE user_id = p_user_id
   FOR UPDATE;

  IF v_before IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_wallet_row'); END IF;

  IF v_before.w = COALESCE(v_strict.withdrawable,0)
 AND v_before.f = COALESCE(v_strict.float_balance,0)
 AND v_before.a = COALESCE(v_strict.advance_balance,0) THEN
    RETURN jsonb_build_object('ok', true, 'no_op', true);
  END IF;

  PERFORM set_config('wallet.sync_authorized', 'true', true);
  UPDATE public.wallets
     SET withdrawable_balance = COALESCE(v_strict.withdrawable, 0),
         float_balance        = COALESCE(v_strict.float_balance, 0),
         advance_balance      = COALESCE(v_strict.advance_balance, 0),
         balance              = COALESCE(v_strict.withdrawable, 0) + COALESCE(v_strict.float_balance, 0),
         updated_at           = now()
   WHERE user_id = p_user_id;
  PERFORM set_config('wallet.sync_authorized', 'false', true);

  RETURN jsonb_build_object(
    'ok', true,
    'before', to_jsonb(v_before),
    'after', jsonb_build_object(
      'w', v_strict.withdrawable, 'f', v_strict.float_balance, 'a', v_strict.advance_balance
    )
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.repair_wallet_cache_for_user(uuid) TO service_role;

-- 3. Batch repair function: scan drifted wallets and snap them to ledger
CREATE OR REPLACE FUNCTION public.repair_wallet_cache_drift(p_limit int DEFAULT 500)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row record;
  v_repaired int := 0;
  v_scanned  int := 0;
BEGIN
  FOR v_row IN
    SELECT w.user_id
      FROM public.wallets w
      JOIN public.v_user_wallet_strict s ON s.user_id = w.user_id
     WHERE ABS(COALESCE(w.withdrawable_balance,0) - COALESCE(s.withdrawable,0))   >= 1
        OR ABS(COALESCE(w.float_balance,0)        - COALESCE(s.float_balance,0))  >= 1
        OR ABS(COALESCE(w.advance_balance,0)      - COALESCE(s.advance_balance,0)) >= 1
     LIMIT p_limit
  LOOP
    v_scanned := v_scanned + 1;
    BEGIN
      PERFORM public.repair_wallet_cache_for_user(v_row.user_id);
      v_repaired := v_repaired + 1;
    EXCEPTION WHEN OTHERS THEN
      NULL; -- skip individual failures; monitor via phantom_wallet_drift
    END;
  END LOOP;

  RETURN jsonb_build_object('scanned', v_scanned, 'repaired', v_repaired, 'ran_at', now());
END;
$$;

GRANT EXECUTE ON FUNCTION public.repair_wallet_cache_drift(int) TO service_role;
