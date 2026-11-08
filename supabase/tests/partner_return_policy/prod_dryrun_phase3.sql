-- Phase 3 production dry run. Run as: BEGIN; <phase 1>; <phase 2>; <phase 3 migration>; <this file>   (always ends in ROLLBACK)

-- Phase 3 production dry run (after BEGIN; <phase 1>; <phase 2>; <phase 3>; always ends in ROLLBACK).
DO $t$
DECLARE
  o text := '';
  v_cfo uuid; v_other uuid; a uuid; b uuid; c uuid; d uuid; j jsonb;
BEGIN
  SELECT ur.user_id INTO v_cfo FROM user_roles ur WHERE ur.role = 'cfo' AND public._has_enabled_role(ur.user_id, ARRAY['cfo']) LIMIT 1;
  SELECT ur.user_id INTO v_other FROM user_roles ur WHERE ur.role = 'agent'
     AND NOT public._has_enabled_role(ur.user_id, ARRAY['manager','coo','cfo','ceo','super_admin','financial_ops','partner_ops']) LIMIT 1;
  SELECT id INTO a FROM investor_portfolios WHERE status = 'active' AND roi_percentage = 15 AND NOT is_portfolio_on_hold(id) ORDER BY created_at DESC LIMIT 1;
  SELECT id INTO b FROM investor_portfolios WHERE status = 'active' AND roi_percentage = 15 AND NOT is_portfolio_on_hold(id) AND id <> a ORDER BY created_at DESC LIMIT 1;
  SELECT id INTO c FROM investor_portfolios WHERE status = 'active' AND roi_percentage = 15 AND NOT is_portfolio_on_hold(id) AND id NOT IN (a, b) ORDER BY created_at DESC LIMIT 1;
  SELECT id INTO d FROM investor_portfolios WHERE status = 'active' AND roi_percentage = 20 AND NOT is_portfolio_on_hold(id) ORDER BY created_at DESC LIMIT 1;

  o := o || E'\nG1 anon can read the policy: ' || has_function_privilege('anon', 'public.get_partner_return_policy()', 'EXECUTE')
          || ' | anon cannot renew: ' || NOT has_function_privilege('anon', 'public.set_portfolio_renewal_rate(uuid,numeric)', 'EXECUTE');

  -- A non-staff caller is refused.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_other, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_other::text, true);
  BEGIN
    PERFORM public.set_portfolio_renewal_rate(a, 15);
    o := o || E'\nG2 NON-STAFF RENEWED (BAD)';
  EXCEPTION WHEN OTHERS THEN o := o || E'\nG2 non-staff refused: ' || left(SQLERRM, 30);
  END;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_cfo, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_cfo::text, true);

  -- Switch OFF: exactly the old dialog behaviour.
  j := public.set_portfolio_renewal_rate(a, 15);
  o := o || E'\nR1 off, renew a 15 at 15: in force=' || (j ->> 'rate_in_force') || ' awaits_cfo=' || (j ->> 'awaits_cfo');
  j := public.set_portfolio_renewal_rate(a, 18);
  o := o || E'\nR2 off, renew a 15 at 18: in force=' || (j ->> 'rate_in_force') || ' requests=' || (SELECT count(*) FROM portfolio_rate_approvals);

  PERFORM public.set_partner_return_policy(true, NULL, 'DRYRUN phase 3');

  -- Switch ON.
  j := public.set_portfolio_renewal_rate(b, 10);
  o := o || E'\nR3 on, renew a 15 at 10: in force=' || (j ->> 'rate_in_force') || ' awaits_cfo=' || (j ->> 'awaits_cfo');
  j := public.set_portfolio_renewal_rate(c, 15);
  o := o || E'\nR4 on, renew a 15 at 15 (the old gap): in force=' || (j ->> 'rate_in_force') || ' awaits_cfo=' || (j ->> 'awaits_cfo')
          || ' request=' || COALESCE((SELECT source || ' ' || requested_rate || '@' || rate_in_force FROM portfolio_rate_approvals WHERE portfolio_id = c AND status = 'pending'), 'none');
  j := public.set_portfolio_renewal_rate(d, 25);
  o := o || E'\nR5 on, renew a 20 at 25: in force=' || (j ->> 'rate_in_force') || ' awaits_cfo=' || (j ->> 'awaits_cfo')
          || ' request=' || COALESCE((SELECT requested_rate || '@' || rate_in_force FROM portfolio_rate_approvals WHERE portfolio_id = d AND status = 'pending'), 'none');
  BEGIN
    PERFORM public.set_portfolio_renewal_rate(d, 0);
    o := o || E'\nR6 RATE 0 ACCEPTED (BAD)';
  EXCEPTION WHEN OTHERS THEN o := o || E'\nR6 rate 0 refused';
  END;

  -- Supported houses show their stored rate; pledged houses use the commitment or new-contract rate.
  o := o || E'\nH1 placement status rates: ' || COALESCE((SELECT string_agg(DISTINCT x.monthly_rate::text, ',')
            FROM public.partner_house_placement_status((SELECT partner_id FROM public.partner_supported_houses WHERE status <> 'cancelled' LIMIT 1)) x), 'no rows')
          || ' | grants auth=' || has_function_privilege('authenticated', 'public.partner_house_placement_status(uuid)', 'EXECUTE')
          || ' anon=' || has_function_privilege('anon', 'public.partner_house_placement_status(uuid)', 'EXECUTE');
  o := o || E'\nH2 pledged-house returns runs: ' || COALESCE((public.partner_supported_house_returns() ->> 'house_count'), '?') || ' houses for the CFO account';
  o := o || E'\nS1 drift check still green: ' || (SELECT bool_and(ok)::text FROM public.assert_partner_return_policy_intact());
  RAISE EXCEPTION 'DRYRUN_P3 %', o;
END $t$;
ROLLBACK;
