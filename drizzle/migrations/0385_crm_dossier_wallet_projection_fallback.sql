DO $migration$
DECLARE
  v_definition text;
  v_old text := $old$'wallet', (SELECT jsonb_build_object(
        'withdrawable', coalesce(w.withdrawable_balance,0), 'operational_float', coalesce(w.float_balance,0),
        'advance', coalesce(w.advance_balance,0),
        'landlord_float', coalesce((SELECT sum(balance) FROM agent_landlord_float f WHERE f.agent_id=p_user_id),0))
      FROM (SELECT 1) x LEFT JOIN wallets w ON w.user_id=p_user_id),$old$;
  v_new text := $new$'wallet', (SELECT jsonb_build_object(
        'withdrawable', coalesce(bp.withdrawable, ws.withdrawable, 0),
        'operational_float', coalesce(bp.float_balance, ws.float_balance, 0),
        'advance', coalesce(bp.advance_balance, ws.advance_balance, 0),
        'landlord_float', coalesce((SELECT sum(balance) FROM agent_landlord_float f WHERE f.agent_id=p_user_id),0))
      FROM (SELECT 1) x
      LEFT JOIN wallet_balances_projection bp ON bp.user_id=p_user_id
      LEFT JOIN v_user_wallet_strict ws ON ws.user_id=p_user_id),$new$;
BEGIN
  SELECT pg_get_functiondef('public.crm_callee_dossier(uuid)'::regprocedure) INTO v_definition;
  IF position(v_old IN v_definition) = 0 THEN
    RAISE EXCEPTION 'crm_callee_dossier wallet block does not match verified live definition';
  END IF;
  EXECUTE replace(v_definition, v_old, v_new);
END
$migration$;

REVOKE ALL ON FUNCTION public.crm_callee_dossier(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.crm_callee_dossier(uuid) TO authenticated;