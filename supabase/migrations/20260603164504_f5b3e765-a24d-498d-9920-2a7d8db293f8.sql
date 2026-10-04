CREATE OR REPLACE FUNCTION public.reconcile_wallet_from_pivot(p_user_id uuid, p_threshold numeric DEFAULT 1000)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  d record;
  v_repaired boolean := false;
  v_logged   boolean := false;
BEGIN
  SELECT * INTO d FROM public.v_pivot_drift WHERE user_id = p_user_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','no_wallet'); END IF;

  IF abs(coalesce(d.withdrawable_delta,0)) < p_threshold
     AND abs(coalesce(d.float_delta,0)) < p_threshold
     AND abs(coalesce(d.advance_delta,0)) < p_threshold THEN
    -- auto-repair
    PERFORM set_config('wallet.sync_authorized','true', true);
    UPDATE public.wallets
       SET withdrawable_balance = GREATEST(0, d.pivot_withdrawable),
           float_balance        = GREATEST(0, d.pivot_float),
           advance_balance      = GREATEST(0, d.pivot_advance),
           balance              = GREATEST(0, d.pivot_withdrawable) + GREATEST(0, d.pivot_float),
           updated_at           = now()
     WHERE user_id = p_user_id;
    v_repaired := true;
  ELSE
    BEGIN
      INSERT INTO public.phantom_wallet_drift (user_id, drift_amount, status, resolution_notes)
      VALUES (
        p_user_id,
        abs(coalesce(d.withdrawable_delta,0)) + abs(coalesce(d.float_delta,0)) + abs(coalesce(d.advance_delta,0)),
        'open',
        format('pivot drift w=%s f=%s a=%s', d.withdrawable_delta, d.float_delta, d.advance_delta)
      );
      v_logged := true;
    EXCEPTION WHEN OTHERS THEN NULL; END;
  END IF;

  RETURN jsonb_build_object(
    'status', CASE WHEN v_repaired THEN 'repaired' WHEN v_logged THEN 'logged' ELSE 'noop' END,
    'withdrawable_drift', d.withdrawable_delta,
    'float_drift', d.float_delta,
    'advance_drift', d.advance_delta
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.reconcile_wallets_batch(p_threshold numeric DEFAULT 1000, p_limit integer DEFAULT 5000)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  r record;
  v_repaired int := 0;
  v_logged int := 0;
  v_res jsonb;
BEGIN
  FOR r IN
    SELECT user_id FROM public.v_pivot_drift
    WHERE abs(coalesce(withdrawable_delta,0)) > 0
       OR abs(coalesce(float_delta,0)) > 0
       OR abs(coalesce(advance_delta,0)) > 0
    LIMIT p_limit
  LOOP
    v_res := public.reconcile_wallet_from_pivot(r.user_id, p_threshold);
    IF v_res->>'status' = 'repaired' THEN v_repaired := v_repaired + 1;
    ELSIF v_res->>'status' = 'logged' THEN v_logged := v_logged + 1;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('repaired', v_repaired, 'logged', v_logged);
END;
$function$;