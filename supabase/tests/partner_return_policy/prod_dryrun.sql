-- Phase 1 production dry run. Run as: BEGIN; <migration>; <this file>   (it always ends in ROLLBACK)
-- Prints DRYRUN_P1 with the results through a raised exception, so nothing is ever kept.

DO $t$
DECLARE
  o text := '';
  v_inv uuid; v_ag uuid; v_cfo uuid; v_other uuid; p_a uuid; p_r1 uuid; p_r2 uuid;
  v_id uuid; v_rate numeric; v_n int; v_j jsonb; v_req uuid; v_req2 uuid; v_req3 uuid; v_lastpay timestamptz;
BEGIN
  SELECT ip.investor_id, ip.agent_id INTO v_inv, v_ag FROM investor_portfolios ip JOIN profiles pr ON pr.id = ip.investor_id
   WHERE ip.status = 'active' AND COALESCE(pr.signup_source, '') <> 'funder-onboarding' LIMIT 1;
  SELECT ur.user_id INTO v_cfo FROM user_roles ur WHERE ur.role = 'cfo' AND public._has_enabled_role(ur.user_id, ARRAY['cfo']) LIMIT 1;
  SELECT ur.user_id INTO v_other FROM user_roles ur WHERE ur.role = 'agent' AND NOT public._has_enabled_role(ur.user_id, ARRAY['cfo']) LIMIT 1;
  -- A 15% payout portfolio whose last approved Returns payout is more than 10 days old,
  -- so a fresh approval must wait for the next cycle.
  SELECT ip.id, lp.at INTO p_a, v_lastpay
    FROM investor_portfolios ip
    JOIN LATERAL (SELECT max(po.reviewed_at) AS at FROM pending_wallet_operations po
                   WHERE po.source_id = ip.id AND po.source_table = 'investor_portfolios'
                     AND po.category IN ('roi_payout', 'supporter_platform_rewards')
                     AND po.status IN ('approved', 'completed')) lp ON lp.at IS NOT NULL
   WHERE ip.status = 'active' AND ip.roi_percentage = 15 AND ip.roi_mode = 'monthly_payout'
     AND lp.at < now() - interval '11 days' AND NOT is_portfolio_on_hold(ip.id)
   ORDER BY lp.at DESC LIMIT 1;
  SELECT id INTO p_r1 FROM investor_portfolios WHERE status = 'active' AND roi_percentage = 15 AND roi_mode = 'monthly_compounding' ORDER BY created_at DESC LIMIT 1;
  SELECT id INTO p_r2 FROM investor_portfolios WHERE status = 'active' AND roi_percentage = 20 AND roi_mode = 'monthly_compounding' ORDER BY created_at DESC LIMIT 1;
  o := o || format(E'\nfixtures inv=%s cfo=%s other=%s a=%s r1=%s r2=%s',
    v_inv IS NOT NULL, v_cfo IS NOT NULL, v_other IS NOT NULL, p_a IS NOT NULL, p_r1 IS NOT NULL, p_r2 IS NOT NULL);

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_cfo, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_cfo::text, true);

  -- ===== SWITCH OFF: behaviour identical to today =====
  o := o || E'\nT1 off rate=' || partner_new_contract_rate() || ' summary=' || (get_countersign_summary(v_inv, 100000) ->> 'roi_percentage');
  INSERT INTO investor_portfolios (investor_id, agent_id, portfolio_code, portfolio_pin, duration_months, investment_amount, status)
  VALUES (v_inv, v_ag, 'DRY-' || left(gen_random_uuid()::text, 8), '0000', 12, 100000, 'pending_ops_approval') RETURNING id, roi_percentage INTO v_id, v_rate;
  o := o || E'\nT2 off default=' || v_rate;
  INSERT INTO investor_portfolios (investor_id, agent_id, portfolio_code, portfolio_pin, duration_months, investment_amount, status, roi_percentage)
  VALUES (v_inv, v_ag, 'DRY-' || left(gen_random_uuid()::text, 8), '0000', 12, 100000, 'pending_ops_approval', 20) RETURNING id, roi_percentage INTO v_id, v_rate;
  SELECT count(*) INTO v_n FROM portfolio_rate_approvals;
  o := o || ' typed20=' || v_rate || ' requests=' || v_n;
  v_j := apply_portfolio_renewal(p_r1, v_cfo, 'DRYRUN', 'manual', false);
  o := o || E'\nT3 off renewal of a 15 -> ' || COALESCE(v_j ->> 'roi_percentage', '?') || ' skipped=' || COALESCE(v_j ->> 'skipped', '?')
          || ' stored=' || (SELECT roi_percentage FROM investor_portfolios WHERE id = p_r1);

  -- ===== SWITCH ON, as the CFO in an MFA session =====
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_cfo, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_cfo::text, true);
  v_j := set_partner_return_policy(true, NULL, 'DRYRUN');
  o := o || E'\nT4 on enabled=' || (v_j ->> 'enabled') || ' rate=' || partner_new_contract_rate()
          || ' summary=' || (get_countersign_summary(v_inv, 100000) ->> 'roi_percentage');
  INSERT INTO investor_portfolios (investor_id, agent_id, portfolio_code, portfolio_pin, duration_months, investment_amount, status)
  VALUES (v_inv, v_ag, 'DRY-' || left(gen_random_uuid()::text, 8), '0000', 12, 100000, 'pending_ops_approval') RETURNING roi_percentage INTO v_rate;
  o := o || ' default_insert=' || v_rate;

  INSERT INTO investor_portfolios (investor_id, agent_id, portfolio_code, portfolio_pin, duration_months, investment_amount, status, roi_percentage)
  VALUES (v_inv, v_ag, 'DRY-' || left(gen_random_uuid()::text, 8), '0000', 12, 100000, 'pending_ops_approval', 15) RETURNING id, roi_percentage INTO v_id, v_rate;
  SELECT id INTO v_req FROM portfolio_rate_approvals WHERE portfolio_id = v_id AND status = 'pending';
  o := o || E'\nT5 new typed 15: stored=' || v_rate || ' request=' || COALESCE((SELECT source || '/' || requested_rate FROM portfolio_rate_approvals WHERE id = v_req), 'none');

  INSERT INTO investor_portfolios (investor_id, agent_id, portfolio_code, portfolio_pin, duration_months, investment_amount, status, roi_percentage, locked_from_portfolio_id)
  VALUES (v_inv, v_ag, 'DRY-' || left(gen_random_uuid()::text, 8), '0000', 12, 1000, 'locked', 15, p_a) RETURNING id, roi_percentage INTO v_id, v_rate;
  o := o || E'\nT6 lock child keeps=' || v_rate || ' requests=' || (SELECT count(*) FROM portfolio_rate_approvals WHERE portfolio_id = v_id);

  UPDATE investor_portfolios SET roi_percentage = 20 WHERE id = p_a;
  o := o || E'\nT7 edit 15->20: stored=' || (SELECT roi_percentage FROM investor_portfolios WHERE id = p_a)
          || ' pending=' || (SELECT requested_rate FROM portfolio_rate_approvals WHERE portfolio_id = p_a AND status = 'pending');
  UPDATE investor_portfolios SET roi_percentage = 18 WHERE id = p_a;
  SELECT id INTO v_req2 FROM portfolio_rate_approvals WHERE portfolio_id = p_a AND status = 'pending';
  o := o || E'\nT8 edit ->18: stored=' || (SELECT roi_percentage FROM investor_portfolios WHERE id = p_a)
          || ' pending=' || (SELECT requested_rate FROM portfolio_rate_approvals WHERE id = v_req2)
          || ' superseded=' || (SELECT count(*) FROM portfolio_rate_approvals WHERE portfolio_id = p_a AND status = 'superseded');

  BEGIN
    UPDATE investor_portfolios SET investment_amount = investment_amount + 1000 WHERE id = p_a;
    o := o || E'\nT9 top-up: rate=' || (SELECT roi_percentage FROM investor_portfolios WHERE id = p_a)
            || ' pending_count=' || (SELECT count(*) FROM portfolio_rate_approvals WHERE portfolio_id = p_a AND status = 'pending');
  EXCEPTION WHEN OTHERS THEN o := o || E'\nT9 top-up blocked by another guard: ' || left(SQLERRM, 80);
  END;

  -- Non-CFO cannot decide or flip the switch
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_other, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_other::text, true);
  BEGIN
    PERFORM cfo_decide_portfolio_rate_requests(ARRAY[v_req2], 'approve', NULL);
    o := o || E'\nT10 NON-CFO DECIDED (BAD)';
  EXCEPTION WHEN OTHERS THEN o := o || E'\nT10 non-cfo decide refused: ' || left(SQLERRM, 50);
  END;
  BEGIN
    PERFORM set_partner_return_policy(false, NULL, 'x');
    o := o || ' | NON-CFO FLIPPED SWITCH (BAD)';
  EXCEPTION WHEN OTHERS THEN o := o || ' | switch refused: ' || left(SQLERRM, 30);
  END;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_cfo, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_cfo::text, true);

  v_j := cfo_decide_portfolio_rate_requests(ARRAY[v_req2, v_req2], 'approve', 'DRYRUN');
  o := o || E'\nT11 approve: rate still=' || (SELECT roi_percentage FROM investor_portfolios WHERE id = p_a)
          || ' decided=' || (v_j ->> 'decided') || ' applies=' || COALESCE(v_j ->> 'applies', '?')
          || ' stage=' || (SELECT stage FROM list_portfolio_rate_requests(NULL, 500) WHERE request_id = v_req2);
  v_j := cfo_decide_portfolio_rate_requests(ARRAY[v_req2], 'approve', 'again');
  o := o || ' | repeat: decided=' || (v_j ->> 'decided') || ' skipped=' || (v_j ->> 'skipped');

  -- Mid-cycle: the last payout was >10 days ago, so the approved rate must wait.
  v_j := apply_due_portfolio_rate_changes();
  o := o || E'\nT11b job mid-cycle: applied=' || (v_j ->> 'applied') || ' rate still=' || (SELECT roi_percentage FROM investor_portfolios WHERE id = p_a);
  -- The cycle's Returns event happens after the approval: simulate by dating the approval before the last payout.
  UPDATE portfolio_rate_approvals SET decided_at = v_lastpay - interval '1 day' WHERE id = v_req2;
  v_j := apply_due_portfolio_rate_changes();
  o := o || E'\nT11c job after the cycle paid: applied=' || (v_j ->> 'applied') || ' rate now=' || (SELECT roi_percentage FROM investor_portfolios WHERE id = p_a)
          || ' stage=' || (SELECT stage FROM list_portfolio_rate_requests(NULL, 500) WHERE request_id = v_req2);
  v_j := apply_due_portfolio_rate_changes();
  o := o || ' | job again: applied=' || (v_j ->> 'applied');

  -- An approved change that has not applied yet is cancelled by a later move to the standard rate.
  UPDATE investor_portfolios SET roi_percentage = 22 WHERE id = p_a;
  SELECT id INTO v_req3 FROM portfolio_rate_approvals WHERE portfolio_id = p_a AND status = 'pending';
  PERFORM cfo_decide_portfolio_rate_requests(ARRAY[v_req3], 'approve', 'DRYRUN');
  UPDATE investor_portfolios SET roi_percentage = 10 WHERE id = p_a;
  UPDATE portfolio_rate_approvals SET decided_at = v_lastpay - interval '1 day' WHERE id = v_req3;
  v_j := apply_due_portfolio_rate_changes();
  o := o || E'\nT11d approved-then-reset: request=' || (SELECT status FROM portfolio_rate_approvals WHERE id = v_req3)
          || ' job applied=' || (v_j ->> 'applied') || ' rate=' || (SELECT roi_percentage FROM investor_portfolios WHERE id = p_a);

  BEGIN
    PERFORM cfo_decide_portfolio_rate_requests(ARRAY[v_req], 'reject', NULL);
    o := o || E'\nT12 REJECT WITHOUT REASON ALLOWED (BAD)';
  EXCEPTION WHEN OTHERS THEN o := o || E'\nT12 reject needs a reason: refused';
  END;
  v_j := cfo_decide_portfolio_rate_requests(ARRAY[v_req], 'reject', 'DRYRUN not justified');
  o := o || ' | rejected=' || (v_j ->> 'decided') || ' rate stays=' ||
       (SELECT ip.roi_percentage FROM investor_portfolios ip JOIN portfolio_rate_approvals a ON a.portfolio_id = ip.id WHERE a.id = v_req);

  -- Re-saving the rate a portfolio already has is not a change: an open request stays for the CFO
  -- (so a form that re-sends unchanged fields can never cancel requests).
  UPDATE investor_portfolios SET roi_percentage = 25 WHERE id = p_a;
  UPDATE investor_portfolios SET roi_percentage = 10 WHERE id = p_a;
  o := o || E'\nT13a re-save current rate: rate=' || (SELECT roi_percentage FROM investor_portfolios WHERE id = p_a)
          || ' pending_left=' || (SELECT count(*) FROM portfolio_rate_approvals WHERE portfolio_id = p_a AND status = 'pending');
  -- A real move to the standard rate applies at once and closes the open request.
  UPDATE investor_portfolios SET roi_percentage = 30 WHERE id = p_r1;
  UPDATE investor_portfolios SET roi_percentage = 10 WHERE id = p_r1;
  o := o || E'\nT13b 15 -> standard: rate=' || (SELECT roi_percentage FROM investor_portfolios WHERE id = p_r1)
          || ' pending_left=' || (SELECT count(*) FROM portfolio_rate_approvals WHERE portfolio_id = p_r1 AND status = 'pending')
          || ' superseded=' || (SELECT count(*) FROM portfolio_rate_approvals WHERE portfolio_id = p_r1 AND status = 'superseded');

  v_j := apply_portfolio_renewal(p_r2, v_cfo, 'DRYRUN', 'manual', false);
  o := o || E'\nT14 on renewal of a 20 -> ' || COALESCE(v_j ->> 'roi_percentage', '?') || ' prev=' || COALESCE(v_j ->> 'previous_roi_percentage', '?')
          || ' skipped=' || COALESCE(v_j ->> 'skipped', '?') || ' stored=' || (SELECT roi_percentage FROM investor_portfolios WHERE id = p_r2)
          || ' log=' || COALESCE((SELECT old_roi_percentage || '->' || new_roi_percentage FROM portfolio_renewals WHERE portfolio_id = p_r2 ORDER BY created_at DESC LIMIT 1), 'none');

  o := o || E'\nT15 queue: pending=' || (SELECT count(*) FROM list_portfolio_rate_requests('pending', 50))
          || ' all=' || (SELECT count(*) FROM list_portfolio_rate_requests(NULL, 50));
  o := o || E'\nT16 drift check: ' || (SELECT string_agg(check_name || '=' || ok, ' ') FROM assert_partner_return_policy_intact());

  v_j := set_partner_return_policy(false, NULL, 'DRYRUN off');
  o := o || E'\nT17 off again: rate=' || partner_new_contract_rate() || ' enabled=' || (v_j ->> 'enabled');
  RAISE EXCEPTION 'DRYRUN_P1 %', o;
END $t$;
ROLLBACK;
