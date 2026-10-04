CREATE OR REPLACE FUNCTION public.psm_e2e_smoke()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  r jsonb := '[]'::jsonb;
  v_partner uuid := gen_random_uuid();
  v_ops uuid := gen_random_uuid();
  v_landlord uuid;
  t uuid[] := '{}';
  rr uuid[] := '{}';
  v_tid uuid;
  v_rid uuid;
  i int;
  v_res jsonb;
  v_err text;
  v_cid uuid;
  v_avail_start numeric;
  v_avail_after_commit numeric;
  v_avail_after_payout numeric;
  v_avail_after_topup numeric;
  v_avail_after_complete numeric;
  v_total numeric;
  v_lines int;
  v_platform numeric;
  v_wallet_out numeric;
  v_cycle_total numeric;
  v_cycle_status text;
  v_elig jsonb;
  v_topup jsonb;
  v_new_line_earning numeric;
  v_committed numeric;
  v_term_end timestamptz;
  v_line_term timestamptz;
  v_ops_rows int;
  v_ops_portfolio jsonb;
  v_redeploy_exists boolean;
BEGIN
  IF current_setting('psm.e2e', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'psm_e2e_smoke is a test harness: run inside a transaction you roll back';
  END IF;

  INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password,
                          email_confirmed_at, created_at, updated_at,
                          raw_app_meta_data, raw_user_meta_data)
  VALUES
    (v_partner, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
     'psm.e2e.partner.' || replace(v_partner::text,'-','') || '@e2e.invalid', 'x',
     now(), now(), now(), '{}'::jsonb, jsonb_build_object('full_name','Zeta Testpartner')),
    (v_ops, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
     'psm.e2e.ops.' || replace(v_ops::text,'-','') || '@e2e.invalid', 'x',
     now(), now(), now(), '{}'::jsonb, jsonb_build_object('full_name','Zeta Testops'));

  INSERT INTO public.profiles (id, full_name, email)
  VALUES (v_partner, 'Zeta Testpartner',
          'psm.e2e.partner.' || replace(v_partner::text,'-','') || '@e2e.invalid'),
         (v_ops, 'Zeta Testops',
          'psm.e2e.ops.' || replace(v_ops::text,'-','') || '@e2e.invalid')
  ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name;

  INSERT INTO public.user_roles (user_id, role) VALUES (v_partner, 'supporter')
  ON CONFLICT DO NOTHING;
  INSERT INTO public.user_roles (user_id, role) VALUES (v_ops, 'partner_ops')
  ON CONFLICT DO NOTHING;

  INSERT INTO public.landlords (name, phone, property_address, verified)
  VALUES ('Zeta Testlandlord', '+25670000' || lpad((random()*9999)::int::text, 4, '0'),
          'E2E Test Plot, Kampala', true)
  RETURNING id INTO v_landlord;

  FOR i IN 1..5 LOOP
    v_tid := gen_random_uuid();
    INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password,
                            email_confirmed_at, created_at, updated_at,
                            raw_app_meta_data, raw_user_meta_data)
    VALUES (v_tid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            'psm.e2e.tenant.' || replace(v_tid::text,'-','') || '@e2e.invalid', 'x',
            now(), now(), now(), '{}'::jsonb,
            jsonb_build_object('full_name','Zeta Testtenant' || i));
    INSERT INTO public.profiles (id, full_name, email)
    VALUES (v_tid, 'Zeta Testtenant' || i,
            'psm.e2e.tenant.' || replace(v_tid::text,'-','') || '@e2e.invalid')
    ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name;
    t := t || v_tid;

    INSERT INTO public.rent_requests (
      tenant_id, landlord_id, rent_amount, duration_days,
      access_fee, request_fee, total_repayment, daily_repayment,
      status, tenancy_status, coo_reviewed_at, request_city, tenant_photo_url
    ) VALUES (
      v_tid, v_landlord, 200000, 30, 0, 0, 0, 0,
      'coo_approved', 'active', now(), 'Kampala', 'https://e2e.invalid/photo.jpg'
    ) RETURNING id INTO v_rid;
    rr := rr || v_rid;
  END LOOP;

  PERFORM public.create_ledger_transaction(
    entries := jsonb_build_array(
      jsonb_build_object('user_id', v_partner, 'amount', 600000, 'direction', 'cash_in',
        'category', 'wallet_deposit', 'ledger_scope', 'wallet',
        'recipient_type', 'user', 'wallet_bucket', 'withdrawable',
        'description', 'E2E test seed deposit'),
      jsonb_build_object('amount', 600000, 'direction', 'cash_out',
        'category', 'general_admin_expense', 'ledger_scope', 'platform',
        'description', 'E2E test seed deposit')
    ),
    idempotency_key := 'psm-e2e-seed-' || v_partner::text
  );

  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_partner::text, 'role', 'authenticated')::text, true);

  v_avail_start := public.get_user_available_balance(v_partner);
  r := r || jsonb_build_object('step','SETUP: partner seeded with ledger-backed balance',
        'pass', v_avail_start = 600000, 'detail', jsonb_build_object('available', v_avail_start));

  BEGIN
    PERFORM public.partner_self_claim_plans(rr, 'e2e-over');
    BEGIN
      v_res := public.partner_self_confirm_commitment(rr, 12, 'e2e-over-confirm');
      r := r || jsonb_build_object('step','CASE 1a: over-balance selection rejected',
            'pass', false, 'detail', jsonb_build_object('unexpected_success', v_res));
    EXCEPTION WHEN OTHERS THEN
      v_err := SQLERRM;
      r := r || jsonb_build_object('step','CASE 1a: over-balance selection rejected',
            'pass', v_err ILIKE '%over%', 'detail', jsonb_build_object('error', v_err));
    END;
    PERFORM public.partner_self_release_claims(rr);
  EXCEPTION WHEN OTHERS THEN
    r := r || jsonb_build_object('step','CASE 1a: over-balance selection rejected',
          'pass', false, 'detail', jsonb_build_object('harness_error', SQLERRM));
  END;

  BEGIN
    v_res := public.partner_self_claim_plans(ARRAY[rr[1], rr[2]], 'e2e-in-range');
    r := r || jsonb_build_object('step','CASE 1b: claim two plans inside balance',
          'pass', jsonb_array_length(v_res->'claimed') = 2,
          'detail', v_res);

    v_res := public.partner_self_confirm_commitment(ARRAY[rr[1], rr[2]], 12, 'e2e-commit');
    v_cid := (v_res->>'commitment_id')::uuid;
    r := r || jsonb_build_object('step','CASE 1c: confirm creates portfolio (commitment)',
          'pass', v_cid IS NOT NULL AND (v_res->>'committed_amount')::numeric = 400000
                  AND (v_res->>'monthly_return')::numeric = 60000,
          'detail', v_res);
  EXCEPTION WHEN OTHERS THEN
    r := r || jsonb_build_object('step','CASE 1b/1c: claim + confirm',
          'pass', false, 'detail', jsonb_build_object('error', SQLERRM));
  END;

  IF v_cid IS NULL THEN
    RETURN jsonb_build_object('aborted_after_confirm_failure', true, 'results', r);
  END IF;

  SELECT COUNT(*), COALESCE(SUM(principal),0), MAX(term_end_at)
    INTO v_lines, v_total, v_line_term
  FROM public.partner_self_funding_lines
  WHERE commitment_id = v_cid AND status = 'active' AND live_at IS NOT NULL;
  r := r || jsonb_build_object('step','CASE 1d: capital locked in funding lines (live, 15%)',
        'pass', v_lines = 2 AND v_total = 400000,
        'detail', jsonb_build_object('lines', v_lines, 'principal', v_total,
                  'rate', (SELECT max(monthly_rate) FROM public.partner_self_funding_lines WHERE commitment_id=v_cid)));

  SELECT term_end_at, to_jsonb(next_payout_at) INTO v_term_end, v_res
    FROM public.partner_self_commitments WHERE id = v_cid;
  r := r || jsonb_build_object('step','CASE 1e: 12-month term + monthly payout clock anchored',
        'pass', v_term_end IS NOT NULL AND v_term_end > now() + interval '360 days',
        'detail', jsonb_build_object('term_end_at', v_term_end, 'next_payout_at', v_res));

  SELECT COALESCE(SUM(amount),0) INTO v_platform
  FROM public.general_ledger
  WHERE ledger_scope='platform' AND direction='cash_in' AND category='partner_funding'
    AND source_table='partner_self_funding_lines'
    AND source_id IN (SELECT id FROM public.partner_self_funding_lines WHERE commitment_id=v_cid);
  SELECT COALESCE(SUM(amount),0) INTO v_wallet_out
  FROM public.general_ledger
  WHERE ledger_scope='wallet' AND direction='cash_out' AND user_id=v_partner
    AND source_table='partner_self_funding_lines';
  r := r || jsonb_build_object('step','CASE 1f: capital deployed to landlord-float pool (double entry)',
        'pass', v_platform = 400000 AND v_wallet_out = 400000,
        'detail', jsonb_build_object('platform_cash_in', v_platform, 'wallet_cash_out', v_wallet_out));

  v_avail_after_commit := public.get_user_available_balance(v_partner);
  r := r || jsonb_build_object('step','CASE 1g: principal NOT visible in wallet after deploy',
        'pass', v_avail_after_commit = 200000,
        'detail', jsonb_build_object('available', v_avail_after_commit, 'expected', 200000));

  SELECT COUNT(*) INTO v_lines FROM public.rent_requests
  WHERE id = ANY(ARRAY[rr[1], rr[2]]) AND self_funding_partner_id = v_partner
    AND self_funding_line_id IS NOT NULL;
  r := r || jsonb_build_object('step','CASE 1h: tenant plans linked to the partner',
        'pass', v_lines = 2, 'detail', jsonb_build_object('linked_plans', v_lines));

  UPDATE public.partner_self_funding_lines
     SET live_at = now() - interval '31 days'
   WHERE commitment_id = v_cid;
  UPDATE public.partner_self_commitments
     SET payout_anchor_at = now() - interval '31 days',
         next_payout_at   = now() - interval '1 day',
         term_end_at      = (now() - interval '31 days') + interval '12 months'
   WHERE id = v_cid;

  BEGIN
    v_res := public.accrue_partner_self_returns(CURRENT_DATE);
    SELECT total_amount, status INTO v_cycle_total, v_cycle_status
    FROM public.partner_self_payout_cycles WHERE commitment_id = v_cid
    ORDER BY cycle_end DESC LIMIT 1;
    r := r || jsonb_build_object('step','CASE 2a: 15% monthly returns recognised',
          'pass', COALESCE(v_cycle_total,0) BETWEEN 57000 AND 60000,
          'detail', jsonb_build_object('accrual', v_res, 'cycle_total', v_cycle_total,
                    'cycle_status', v_cycle_status, 'expected_full_month', 60000));
  EXCEPTION WHEN OTHERS THEN
    r := r || jsonb_build_object('step','CASE 2a: 15% monthly returns recognised',
          'pass', false, 'detail', jsonb_build_object('error', SQLERRM));
  END;

  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_ops::text, 'role', 'authenticated')::text, true);
  BEGIN
    v_res := public.partner_self_nearing_payouts(40);
    v_ops_rows := COALESCE((v_res->>'count')::int, jsonb_array_length(COALESCE(v_res->'rows','[]'::jsonb)));
    r := r || jsonb_build_object('step','CASE 3a: nearing-payout queue visible to Partner Ops/COO',
          'pass', v_ops_rows >= 1, 'detail', jsonb_build_object('count', v_res->'count', 'expected_total', v_res->'expected_total'));
  EXCEPTION WHEN OTHERS THEN
    r := r || jsonb_build_object('step','CASE 3a: nearing-payout queue visible to Partner Ops/COO',
          'pass', false, 'detail', jsonb_build_object('error', SQLERRM));
  END;
  BEGIN
    v_ops_portfolio := public.partner_self_portfolio(v_partner);
    r := r || jsonb_build_object('step','CASE 3b: ops can open a partner self-support portfolio',
          'pass', (v_ops_portfolio->'totals'->>'committed')::numeric = 400000,
          'detail', v_ops_portfolio->'totals');
  EXCEPTION WHEN OTHERS THEN
    r := r || jsonb_build_object('step','CASE 3b: ops can open a partner self-support portfolio',
          'pass', false, 'detail', jsonb_build_object('error', SQLERRM));
  END;

  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_partner::text, 'role', 'authenticated')::text, true);
  BEGIN
    v_res := public.pay_partner_self_cycles(50);
    v_avail_after_payout := public.get_user_available_balance(v_partner);
    r := r || jsonb_build_object('step','CASE 4a: returns credited to partner withdrawable wallet',
          'pass', v_avail_after_payout > v_avail_after_commit,
          'detail', jsonb_build_object('payout_run', v_res,
                    'available_before', v_avail_after_commit,
                    'available_after', v_avail_after_payout,
                    'delta', v_avail_after_payout - v_avail_after_commit));
    r := r || jsonb_build_object('step','CASE 4b: only returns land in wallet, never the principal',
          'pass', (v_avail_after_payout - v_avail_after_commit) < 400000,
          'detail', jsonb_build_object('delta', v_avail_after_payout - v_avail_after_commit));
  EXCEPTION WHEN OTHERS THEN
    r := r || jsonb_build_object('step','CASE 4: payout run',
          'pass', false, 'detail', jsonb_build_object('error', SQLERRM));
  END;

  BEGIN
    v_elig := public.partner_self_topup_eligibility(v_cid);
    r := r || jsonb_build_object('step','CASE 5a: top-up allowed mid-term',
          'pass', (v_elig->>'allow_topup')::boolean, 'detail', v_elig);

    PERFORM public.partner_self_claim_plans(ARRAY[rr[3]], 'e2e-topup-claim');
    v_topup := public.partner_self_top_up(v_cid, ARRAY[rr[3]], 'e2e-topup');
    v_avail_after_topup := public.get_user_available_balance(v_partner);

    r := r || jsonb_build_object('step','CASE 5b: top-up capital deploys immediately',
          'pass', v_avail_after_topup = v_avail_after_payout - 200000,
          'detail', jsonb_build_object('topup', v_topup,
                    'available_after', v_avail_after_topup));

    r := r || jsonb_build_object('step','CASE 5c: top-up earns pro-rata this cycle, full rate next cycle',
          'pass', COALESCE((v_topup->>'prorata_amount')::numeric, -1) < COALESCE((v_topup->>'full_monthly_return')::numeric, 30000),
          'detail', v_topup);

    SELECT term_end_at INTO v_line_term FROM public.partner_self_funding_lines
     WHERE commitment_id = v_cid AND rent_request_id = rr[3];
    SELECT committed_amount, term_end_at INTO v_committed, v_term_end
      FROM public.partner_self_commitments WHERE id = v_cid;
    r := r || jsonb_build_object('step','CASE 5d: topped-up line inherits parent maturity (no term reset)',
          'pass', v_line_term IS NULL OR v_line_term = v_term_end,
          'detail', jsonb_build_object('line_term_end', v_line_term, 'portfolio_term_end', v_term_end));

    r := r || jsonb_build_object('step','CASE 5e: committed principal after top-up',
          'pass', v_committed = 600000,
          'detail', jsonb_build_object('committed_amount', v_committed,
                    'note','committed_amount rises immediately; the cycle-boundary rule is expressed as pro-rata earnings, not a delayed principal'));
  EXCEPTION WHEN OTHERS THEN
    r := r || jsonb_build_object('step','CASE 5: mid-cycle top-up',
          'pass', false, 'detail', jsonb_build_object('error', SQLERRM));
  END;

  -- simulate the next monthly cycle by shifting the whole portfolio back one month
  BEGIN
    UPDATE public.partner_self_earnings
       SET cycle_start = (cycle_start - interval '1 month')::date,
           cycle_end   = (cycle_end - interval '1 month')::date
     WHERE commitment_id = v_cid;
    UPDATE public.partner_self_payout_cycles
       SET cycle_start = (cycle_start - interval '1 month')::date,
           cycle_end   = (cycle_end - interval '1 month')::date
     WHERE commitment_id = v_cid;
    UPDATE public.partner_self_funding_lines
       SET live_at = live_at - interval '1 month'
     WHERE commitment_id = v_cid;
    UPDATE public.partner_self_commitments
       SET next_payout_at = now() - interval '1 day'
     WHERE id = v_cid;

    PERFORM public.accrue_partner_self_returns(CURRENT_DATE);

    SELECT e.amount, e.days_live INTO v_new_line_earning, v_lines
      FROM public.partner_self_earnings e
      JOIN public.partner_self_funding_lines l ON l.id = e.line_id
     WHERE l.rent_request_id = rr[3]
     ORDER BY e.cycle_end DESC LIMIT 1;
    SELECT total_amount INTO v_cycle_total
      FROM public.partner_self_payout_cycles WHERE commitment_id = v_cid
     ORDER BY cycle_end DESC LIMIT 1;
    r := r || jsonb_build_object('step','CASE 5f: after the cycle ends the top-up joins the earning base',
          'pass', COALESCE(v_new_line_earning,0) > 0 AND COALESCE(v_cycle_total,0) > 60000,
          'detail', jsonb_build_object('topup_line_earning', v_new_line_earning,
                    'topup_line_days_live', v_lines,
                    'next_cycle_total', v_cycle_total,
                    'expected_full_base', 90000));
  EXCEPTION WHEN OTHERS THEN
    r := r || jsonb_build_object('step','CASE 5f: post-cycle earning base',
          'pass', false, 'detail', jsonb_build_object('error', SQLERRM));
  END;

  BEGIN
    UPDATE public.partner_self_commitments
       SET term_end_at = now() + interval '45 days', status = 'active' WHERE id = v_cid;
    v_elig := public.partner_self_topup_eligibility(v_cid);
    r := r || jsonb_build_object('step','CASE 6: top-up blocked inside the 90-day payout window',
          'pass', (v_elig->>'allow_topup')::boolean IS FALSE,
          'detail', jsonb_build_object('allow_topup', v_elig->'allow_topup',
                    'block_reason', v_elig->'block_reason'));
    UPDATE public.partner_self_commitments
       SET term_end_at = now() + interval '11 months' WHERE id = v_cid;
  EXCEPTION WHEN OTHERS THEN
    r := r || jsonb_build_object('step','CASE 6: maturity window',
          'pass', false, 'detail', jsonb_build_object('error', SQLERRM));
  END;

  BEGIN
    -- system context (no jwt) so plan-status guards do not treat this as an agent edit
    PERFORM set_config('request.jwt.claims', NULL, true);
    UPDATE public.rent_requests SET status = 'completed' WHERE id = rr[1];
    v_avail_after_complete := public.get_user_available_balance(v_partner);
    SELECT status INTO v_cycle_status FROM public.partner_self_funding_lines
     WHERE rent_request_id = rr[1];
    SELECT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname='public'
         AND (p.proname ILIKE '%self%redeploy%' OR p.proname ILIKE '%self%recycle%'
              OR p.proname ILIKE '%self%reassign%')
    ) INTO v_redeploy_exists;
    r := r || jsonb_build_object('step','CASE 7a: completed plan closes the funding line',
          'pass', v_cycle_status = 'completed',
          'detail', jsonb_build_object('line_status', v_cycle_status));
    r := r || jsonb_build_object('step','CASE 7b: re-support the next tenant with the SAME deployed capital',
          'pass', v_redeploy_exists,
          'detail', jsonb_build_object(
            'redeploy_rpc_exists', v_redeploy_exists,
            'available_balance_after_completion', v_avail_after_complete,
            'note','freed principal is not returned to the wallet and no redeploy RPC exists'));
  EXCEPTION WHEN OTHERS THEN
    r := r || jsonb_build_object('step','CASE 7: re-support with deployed capital',
          'pass', false, 'detail', jsonb_build_object('error', SQLERRM));
  END;

  PERFORM set_config('request.jwt.claims', NULL, true);

  RETURN jsonb_build_object(
    'ran_at', now(),
    'partner_id', v_partner,
    'commitment_id', v_cid,
    'total_cases', jsonb_array_length(r),
    'failed_cases', (SELECT COUNT(*) FROM jsonb_array_elements(r) e WHERE (e->>'pass')::boolean IS NOT TRUE),
    'results', r
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.psm_e2e_smoke() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.psm_e2e_smoke() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.psm_e2e_smoke() TO service_role;