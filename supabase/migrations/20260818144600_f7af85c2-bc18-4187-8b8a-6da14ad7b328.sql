DO $do$
DECLARE
  d text;
  blk text;
BEGIN
  d := pg_get_functiondef('public.run_payout_acceptance_checks(integer)'::regprocedure);

  IF position('merchant_board_matches_agent_view' IN d) > 0 THEN
    RAISE NOTICE 'check already present';
    RETURN;
  END IF;

  blk := $blk$
  -- (v) Incident-specific: the float figure the Financial Ops board shows for a
  -- desk MUST equal the figure that desk's own agent sees on their phone.
  -- Board reads wallet_balances_projection.float_balance; the agent's own card
  -- reads wallets.float_balance via get_merchant_float_position(). Once the
  -- synchronous refresh + read-repair + realtime path is in place these are
  -- identical by construction, so any divergence is a regression.
  SELECT count(*), COALESCE(SUM(abs(t.diff)), 0) INTO v_n, v_amt
  FROM (
    SELECT ca.id AS desk_id,
           GREATEST(COALESCE(wp.float_balance, 0), 0)
             - GREATEST(COALESCE(w.float_balance, 0), 0) AS diff
    FROM cashout_agents ca
    LEFT JOIN wallet_balances_projection wp ON wp.user_id = ca.agent_id
    LEFT JOIN wallets w ON w.user_id = ca.agent_id
    WHERE ca.is_active IS TRUE
      AND ca.agent_id IS NOT NULL
  ) t
  WHERE abs(t.diff) > 0.5;
  RETURN QUERY SELECT
    'merchant_board_matches_agent_view',
    'Every active desk shows the same float on the ops board and on the agent phone',
    CASE WHEN v_n = 0 THEN 'pass' ELSE 'fail' END,
    v_n, 0::numeric,
    format('%s active desk(s) disagree between the ops board and the agent view (UGX %s total gap)', v_n, round(v_amt));

$blk$;

  d := regexp_replace(d, 'END;\s*\$function\$\s*$', blk || E'END;\n$function$');
  IF position('merchant_board_matches_agent_view' IN d) = 0 THEN
    RAISE EXCEPTION 'failed to append the new check';
  END IF;
  EXECUTE d;
END
$do$;