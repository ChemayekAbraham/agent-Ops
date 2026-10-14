-- Rolled-back verification for 20261014200000_rent_renewal_any_rent_days.sql
--
-- Run against the live database, one block at a time. Each block ends in RAISE EXCEPTION, so nothing is kept and the error text IS the
-- report (steps with "pass"). Every step must pass. Renewals are made inside sub-blocks that are rolled back, so one fixture tenant serves
-- every case. The fixture is a real tenant picked at run time: the latest plan completed, no other open or recent plan, collections on
-- the plan, and a baseline same-rent renewal that the live triggers accept.
--
-- Block 1  the rules that need no renewal
--   A  allowed days equal the live CHECK (and the CHECK text is pinned); preview prices rent and days with compute_rent_repayment and
--      refuses a disallowed day count; advice shape, chosen days, never below the current rent; the max-rent search is exact; bands and
--      config; the plan statistics equal an independent recompute for 30 plans; permissions
-- Block 2  renewals: same rent and days, longer and shorter days, refusals
--   B  same rent, same days: byte-identical to the old behaviour (a legacy code still works, no renewal_* column, no log row, no event);
--   C  longer / shorter days with an explanation: days and daily payment recalculated, previous plan untouched, advice recomputed for the
--      chosen days, log row and event written; disallowed days refused; days or rent changed without an explanation refused
-- Block 3  amounts and the OTP
--   D  lower rent ok; higher within the suggestion ok; FAR above the suggestion ok and flagged; the existing capacity guard is untouched;
--      the minimum explanation length follows the config; a trust signal only with fresh GPS
--   E  the OTP is bound to the rent AND the days
-- Block 4  notes, reviewer reads, immutability
--   F  review notes: reviewer roles write, the request's agent and reviewers read, others do not, append-only
--   G  every reviewer role reads the renewal columns; the Service Center RPC carries them; they cannot be rewritten

-- ===== Block 1: A =====
DO $test$
DECLARE
  r jsonb := '[]'::jsonb;
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  c record; a record; v_ok boolean; v_n int; v_bad int; v_msg text; ex jsonb := '[]'::jsonb;
  v_adv jsonb; v_adv90 jsonb; v_pv jsonb; v_cmp record; v_stats jsonb;
  v_prev uuid; v_tenant uuid; v_agent uuid; v_other uuid; v_cur_rent numeric; v_cur_days int;
  d int; v_days_ok boolean; v_expect boolean; v_k int; v_cs date; v_step int; v_period numeric; v_total numeric; v_dd date; v_cumdue numeric; v_cumpaid numeric; v_inp numeric;
  v_due int; v_ok_n int; v_streak int; v_run int; v_paidtot numeric; v_first date; v_last date; v_end date; v_dayscount int; v_fully boolean; v_avg numeric;
  v_checked int := 0; v_same int := 0; v_cap numeric;
BEGIN
  -- the fixture
  SELECT rr.id, rr.tenant_id, COALESCE(rr.assigned_agent_id, rr.agent_id), rr.rent_amount, rr.duration_days
    INTO v_prev, v_tenant, v_agent, v_cur_rent, v_cur_days
    FROM public.rent_requests rr
   WHERE rr.status = 'completed' AND rr.landlord_id IS NOT NULL AND COALESCE(rr.assigned_agent_id, rr.agent_id) IS NOT NULL
     AND rr.rent_amount BETWEEN 100000 AND 1500000
     AND rr.created_at = (SELECT max(x.created_at) FROM public.rent_requests x WHERE x.tenant_id = rr.tenant_id)
     AND EXISTS (SELECT 1 FROM public.agent_collections ac WHERE ac.rent_request_id = rr.id AND ac.reversed_at IS NULL AND ac.amount > 0)
   ORDER BY md5(rr.id::text) LIMIT 1;
  r := r || jsonb_build_object('step', 'A found a fixture plan', 'pass', v_prev IS NOT NULL, 'detail', jsonb_build_object('rent', v_cur_rent, 'days', v_cur_days));

  -- A: allowed days
  v_bad := 0;
  FOR d IN -5..400 LOOP
    v_expect := d IN (30, 60, 90, 120) OR (d >= 7 AND d <= 364 AND d % 7 = 0);
    IF public._rent_days_allowed(d) IS DISTINCT FROM v_expect THEN v_bad := v_bad + 1; END IF;
  END LOOP;
  r := r || jsonb_build_object('step', 'A _rent_days_allowed equals the rule for every number of days from -5 to 400', 'pass', v_bad = 0 AND NOT public._rent_days_allowed(NULL), 'detail', v_bad);
  SELECT count(*) INTO v_n FROM generate_series(1, 400) g WHERE public._rent_days_allowed(g);
  r := r || jsonb_build_object('step', 'A there are 56 allowed day counts, 30 / 60 / 90 / 120 among them', 'pass', v_n = 56 AND cardinality(public.rent_allowed_days()) = 56
      AND public.rent_allowed_days() @> ARRAY[7, 30, 60, 90, 120, 364] AND NOT public.rent_allowed_days() && ARRAY[29, 31, 365, 0, 45, 211], 'detail', v_n);
  r := r || jsonb_build_object('step', 'A the live CHECK on rent_requests.duration_days is still the rule this mirrors (pinned text)',
    'pass', (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.rent_requests'::regclass AND conname = 'rent_requests_duration_days_check')
            = 'CHECK (((duration_days IS NULL) OR (duration_days = ANY (ARRAY[30, 60, 90, 120])) OR ((duration_days >= 7) AND (duration_days <= 364) AND ((duration_days % 7) = 0))))');

  -- as the plan's agent
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_agent, 'role', 'authenticated')::text, true);

  -- A: preview
  v_bad := 0;
  FOREACH d IN ARRAY ARRAY[7, 21, 30, 60, 90, 120, 210, 364] LOOP
    v_pv := public.preview_renewal_amount(v_prev, v_cur_rent + 50000, d);
    SELECT * INTO v_cmp FROM public.compute_rent_repayment(v_cur_rent + 50000, d);
    IF (v_pv->>'access_fee')::numeric <> v_cmp.access_fee OR (v_pv->>'request_fee')::numeric <> v_cmp.request_fee
       OR (v_pv->>'total_repayment')::numeric <> v_cmp.total_repayment OR (v_pv->>'daily_repayment')::numeric <> v_cmp.daily_repayment
       OR (v_pv->>'new_days')::int <> d THEN v_bad := v_bad + 1; END IF;
  END LOOP;
  r := r || jsonb_build_object('step', 'A the preview gives the existing pricing (compute_rent_repayment) for 8 day counts', 'pass', v_bad = 0);
  -- Existing pricing is not monotonic in days (daily payment falls to ~120 days, then rises), so assert the server returns the pricing function's own figure, not a direction.
  r := r || jsonb_build_object('step', 'A the daily payment is recalculated for the chosen days (30 days costs more per day than 90, and 364 days differs from 90)',
    'pass', (public.preview_renewal_amount(v_prev, 600000, 90)->>'daily_repayment')::numeric < (public.preview_renewal_amount(v_prev, 600000, 30)->>'daily_repayment')::numeric
        AND (public.preview_renewal_amount(v_prev, 600000, 364)->>'daily_repayment')::numeric <> (public.preview_renewal_amount(v_prev, 600000, 90)->>'daily_repayment')::numeric);
  v_pv := public.preview_renewal_amount(v_prev, v_cur_rent, NULL);
  r := r || jsonb_build_object('step', 'A NULL days means the current days, and an unchanged rent and days is not "changed"',
    'pass', (v_pv->>'new_days')::int = v_cur_days AND NOT (v_pv->>'changed')::boolean AND NOT (v_pv->>'explanation_required')::boolean);
  r := r || jsonb_build_object('step', 'A a changed rent or days says an explanation is required',
    'pass', (public.preview_renewal_amount(v_prev, v_cur_rent + 10000, NULL)->>'explanation_required')::boolean
        AND (public.preview_renewal_amount(v_prev, v_cur_rent, CASE WHEN v_cur_days = 90 THEN 60 ELSE 90 END)->>'explanation_required')::boolean);
  v_ok := true;
  FOREACH d IN ARRAY ARRAY[0, 29, 45, 210 + 1, 365, 400, -7] LOOP
    BEGIN PERFORM public.preview_renewal_amount(v_prev, 300000, d); v_ok := false;
    EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE 'RENEWAL_DAYS_NOT_ALLOWED%' OR SQLSTATE <> '22023' THEN v_ok := false; END IF; END;
  END LOOP;
  r := r || jsonb_build_object('step', 'A the preview refuses a day count that is not allowed (RENEWAL_DAYS_NOT_ALLOWED, 22023)', 'pass', v_ok);
  v_ok := false; BEGIN PERFORM public.preview_renewal_amount(v_prev, 0, 30); EXCEPTION WHEN OTHERS THEN v_ok := SQLERRM LIKE 'RENEWAL_AMOUNT_INVALID%'; END;
  r := r || jsonb_build_object('step', 'A the preview refuses a rent of 0 (RENEWAL_AMOUNT_INVALID)', 'pass', v_ok);
  v_ok := false; BEGIN PERFORM public.get_renewal_advice(v_prev, 45); EXCEPTION WHEN OTHERS THEN v_ok := SQLERRM LIKE 'RENEWAL_DAYS_NOT_ALLOWED%'; END;
  r := r || jsonb_build_object('step', 'A the advice refuses a day count that is not allowed', 'pass', v_ok);

  -- A: advice
  v_adv := public.get_renewal_advice(v_prev);
  v_adv90 := public.get_renewal_advice(v_prev, 90);
  r := r || jsonb_build_object('step', 'A the advice carries every field in the spec',
    'pass', v_adv ?& ARRAY['current_days', 'allowed_days', 'current_rent', 'on_time_pct', 'fully_repaid', 'longest_missed_streak', 'band', 'suggested_step_pct',
                           'avg_daily_paid', 'affordability_rent', 'access_limit', 'suggested_max_rent', 'reasons', 'computed_at'],
    'detail', (SELECT jsonb_agg(k) FROM unnest(ARRAY['current_days', 'allowed_days', 'current_rent', 'on_time_pct', 'fully_repaid', 'longest_missed_streak', 'band', 'suggested_step_pct',
                           'avg_daily_paid', 'affordability_rent', 'access_limit', 'suggested_max_rent', 'reasons', 'computed_at']) k WHERE NOT v_adv ? k));
  r := r || jsonb_build_object('step', 'A the advice is for the chosen days (NULL = current days) and lists the 56 allowed day counts',
    'pass', (v_adv->>'chosen_days')::int = v_cur_days AND (v_adv->>'current_days')::int = v_cur_days AND (v_adv90->>'chosen_days')::int = 90
        AND (v_adv90->>'current_days')::int = v_cur_days AND jsonb_array_length(v_adv->'allowed_days') = 56);
  r := r || jsonb_build_object('step', 'A the suggestion is never below the current rent, and is a whole 10,000 above it',
    'pass', (v_adv->>'suggested_max_rent')::numeric >= v_cur_rent AND (v_adv90->>'suggested_max_rent')::numeric >= v_cur_rent
        AND ((v_adv->>'suggested_max_rent')::numeric = v_cur_rent OR (v_adv->>'suggested_max_rent')::numeric % 10000 = 0));
  r := r || jsonb_build_object('step', 'A the access limit in the advice is the server Rent Access Limit',
    'pass', (v_adv->>'access_limit')::numeric = (public.rent_access_limit_server(v_tenant)->>'limit')::numeric);
  r := r || jsonb_build_object('step', 'A the reasons are plain sentences with no banned word (loan, lender, ROI, interest) and the amounts read "UGX 1,234"',
    'pass', jsonb_typeof(v_adv->'reasons') = 'array' AND jsonb_array_length(v_adv->'reasons') >= 4
        AND NOT (v_adv->>'reasons') ~* '\m(loan|lender|roi|interest)\M' AND (v_adv->>'reasons') ~ 'UGX [0-9]{1,3}(,[0-9]{3})*', 'detail', v_adv->'reasons');
  -- the suggestion is the GREATEST(current, LEAST(step-up, affordability, limit)) the spec asks for
  r := r || jsonb_build_object('step', 'A suggested_max_rent = GREATEST(current rent, LEAST(step-up rent, affordability rent, access-limit rent))',
    'pass', (v_adv->>'suggested_max_rent')::numeric = GREATEST(v_cur_rent, LEAST((v_adv->>'step_up_rent')::numeric, (v_adv->>'affordability_rent')::numeric, (v_adv->>'access_limit_rent')::numeric))
        AND (v_adv90->>'suggested_max_rent')::numeric = GREATEST(v_cur_rent, LEAST((v_adv90->>'step_up_rent')::numeric, (v_adv90->>'affordability_rent')::numeric, (v_adv90->>'access_limit_rent')::numeric)));

  -- A: the max-rent search is exact (round 1): the total fits at the answer and not at one shilling more
  v_bad := 0;
  FOREACH d IN ARRAY ARRAY[7, 30, 60, 90, 210, 364] LOOP
    FOREACH v_cap IN ARRAY ARRAY[100000::numeric, 300000, 450000, 1234567, 5000000] LOOP
      v_n := public._renewal_max_rent(d, v_cap, NULL, 1);
      SELECT * INTO v_cmp FROM public.compute_rent_repayment(v_n::numeric, d);
      IF v_n > 0 AND v_cmp.total_repayment > v_cap THEN v_bad := v_bad + 1; END IF;
      SELECT * INTO v_cmp FROM public.compute_rent_repayment(v_n::numeric + 1, d);
      IF v_cmp.total_repayment <= v_cap THEN v_bad := v_bad + 1; END IF;
      v_n := public._renewal_max_rent(d, NULL, v_cap / 20, 1);
      SELECT * INTO v_cmp FROM public.compute_rent_repayment(v_n::numeric + 1, d);
      IF v_cmp.daily_repayment <= v_cap / 20 THEN v_bad := v_bad + 1; END IF;
    END LOOP;
  END LOOP;
  r := r || jsonb_build_object('step', 'A the maximum-rent search is exact for totals and for daily payments (30 cases)', 'pass', v_bad = 0, 'detail', v_bad);

  -- A: bands and config
  r := r || jsonb_build_object('step', 'A bands: 90%+ fully repaid = A / 50, 90%+ not fully repaid = B / 25, 75-89 = B / 25, 60-74 = C / 10, below = D / 0, no record = D',
    'pass', public._renewal_band(95, true, public._renewal_advice_params()) = '{"name": "A", "step_pct": 50}'::jsonb
        AND public._renewal_band(90, true, public._renewal_advice_params()) = '{"name": "A", "step_pct": 50}'::jsonb
        AND public._renewal_band(95, false, public._renewal_advice_params()) = '{"name": "B", "step_pct": 25}'::jsonb
        AND public._renewal_band(89.9, true, public._renewal_advice_params()) = '{"name": "B", "step_pct": 25}'::jsonb
        AND public._renewal_band(75, false, public._renewal_advice_params()) = '{"name": "B", "step_pct": 25}'::jsonb
        AND public._renewal_band(74.9, true, public._renewal_advice_params()) = '{"name": "C", "step_pct": 10}'::jsonb
        AND public._renewal_band(60, false, public._renewal_advice_params()) = '{"name": "C", "step_pct": 10}'::jsonb
        AND public._renewal_band(59.9, true, public._renewal_advice_params()) = '{"name": "D", "step_pct": 0}'::jsonb
        AND public._renewal_band(NULL, false, public._renewal_advice_params()) = '{"name": "D", "step_pct": 0}'::jsonb);
  UPDATE public.system_config SET value = '{"bands": [{"name": "X", "min_on_time_pct": 50, "require_fully_repaid": false, "step_up_pct": 7}, {"name": "Y", "min_on_time_pct": 0, "require_fully_repaid": false, "step_up_pct": 1}], "affordability_multiplier": 2, "min_explanation_length": 33, "rounding_ugx": 5000}'::jsonb
   WHERE key = 'rent_renewal_advice_params';
  r := r || jsonb_build_object('step', 'A the config is admin-tunable: bands, multiplier, minimum explanation length and rounding all follow system_config',
    'pass', public._renewal_band(60, true, public._renewal_advice_params()) = '{"name": "X", "step_pct": 7}'::jsonb
        AND public._renewal_band(10, true, public._renewal_advice_params()) = '{"name": "Y", "step_pct": 1}'::jsonb
        AND (public._renewal_advice_params()->>'affordability_multiplier')::numeric = 2
        AND (public._renewal_advice_params()->>'min_explanation_length')::int = 33
        AND (public.get_renewal_advice(v_prev)->>'band') IN ('X', 'Y')
        AND (public.preview_renewal_amount(v_prev, 300000)->>'min_explanation_length')::int = 33);
  UPDATE public.system_config SET value = '{"bands": "not an array"}'::jsonb WHERE key = 'rent_renewal_advice_params';
  r := r || jsonb_build_object('step', 'A a damaged config falls back to the defaults instead of failing',
    'pass', public._renewal_band(95, true, public._renewal_advice_params()) = '{"name": "A", "step_pct": 50}'::jsonb
        AND (public._renewal_advice_params()->>'min_explanation_length')::int = 10);
  DELETE FROM public.system_config WHERE key = 'rent_renewal_advice_params';
  r := r || jsonb_build_object('step', 'A with no config row the shipped defaults apply (1.3x, 10 characters, 10,000 steps)',
    'pass', (public._renewal_advice_params()->>'affordability_multiplier')::numeric = 1.3 AND (public._renewal_advice_params()->>'min_explanation_length')::int = 10
        AND (public._renewal_advice_params()->>'rounding_ugx')::numeric = 10000);

  -- A: the plan statistics equal an independent recompute for 30 real plans
  FOR c IN
    SELECT rr.id FROM public.rent_requests rr
     WHERE rr.status IN ('completed', 'repaying') AND rr.total_repayment > 0 AND rr.daily_repayment > 0
       AND EXISTS (SELECT 1 FROM public.agent_collections ac WHERE ac.rent_request_id = rr.id AND ac.reversed_at IS NULL AND ac.amount > 0)
     ORDER BY md5(rr.id::text) LIMIT 30
  LOOP
    v_checked := v_checked + 1;
    v_stats := public._renewal_plan_stats(c.id, v_today);
    SELECT * INTO a FROM public._am_plan_arrears_core(ARRAY[c.id], v_today);
    v_cs := a.clock_start; v_step := CASE WHEN a.cadence = 'weekly' THEN 7 ELSE 1 END;
    SELECT total_repayment, daily_repayment * v_step INTO v_total, v_period FROM public.rent_requests WHERE id = c.id;
    v_due := 0; v_ok_n := 0; v_streak := 0; v_run := 0;
    IF v_cs IS NOT NULL THEN
      v_k := 1;
      LOOP
        v_dd := v_cs + (v_k - 1) * v_step;
        EXIT WHEN v_dd >= v_today OR v_period * (v_k - 1) >= v_total;
        v_cumdue := LEAST(v_total, v_period * v_k);
        SELECT COALESCE(sum(x.amount), 0) INTO v_cumpaid FROM (
          SELECT ac.amount FROM public.agent_collections ac WHERE ac.rent_request_id = c.id AND ac.reversed_at IS NULL AND ac.amount > 0
             AND (ac.created_at AT TIME ZONE 'Africa/Kampala')::date <= v_dd
          UNION ALL
          SELECT rp.amount FROM public.repayments rp WHERE rp.rent_request_id = c.id AND rp.amount > 0 AND (rp.created_at AT TIME ZONE 'Africa/Kampala')::date <= v_dd
             AND NOT EXISTS (SELECT 1 FROM public.agent_collections ac WHERE ac.rent_request_id = rp.rent_request_id AND ac.reversed_at IS NULL AND ac.amount = rp.amount AND abs(extract(epoch FROM ac.created_at - rp.created_at)) < 300)) x;
        SELECT COALESCE(sum(x.amount), 0) INTO v_inp FROM (
          SELECT ac.amount FROM public.agent_collections ac WHERE ac.rent_request_id = c.id AND ac.reversed_at IS NULL AND ac.amount > 0
             AND (ac.created_at AT TIME ZONE 'Africa/Kampala')::date BETWEEN v_dd AND v_dd + v_step - 1 AND (ac.created_at AT TIME ZONE 'Africa/Kampala')::date <= v_today
          UNION ALL
          SELECT rp.amount FROM public.repayments rp WHERE rp.rent_request_id = c.id AND rp.amount > 0
             AND (rp.created_at AT TIME ZONE 'Africa/Kampala')::date BETWEEN v_dd AND v_dd + v_step - 1 AND (rp.created_at AT TIME ZONE 'Africa/Kampala')::date <= v_today
             AND NOT EXISTS (SELECT 1 FROM public.agent_collections ac WHERE ac.rent_request_id = rp.rent_request_id AND ac.reversed_at IS NULL AND ac.amount = rp.amount AND abs(extract(epoch FROM ac.created_at - rp.created_at)) < 300)) x;
        v_due := v_due + 1;
        IF v_cumpaid >= v_cumdue THEN v_ok_n := v_ok_n + 1; END IF;
        IF v_inp = 0 AND v_dd + (v_step - 1) < v_today THEN v_run := v_run + 1; v_streak := GREATEST(v_streak, v_run); ELSE v_run := 0; END IF;
        v_k := v_k + 1;
      END LOOP;
    END IF;
    SELECT COALESCE(sum(x.amount), 0), min(x.d), max(x.d) INTO v_paidtot, v_first, v_last FROM (
      SELECT ac.amount, (ac.created_at AT TIME ZONE 'Africa/Kampala')::date AS d FROM public.agent_collections ac WHERE ac.rent_request_id = c.id AND ac.reversed_at IS NULL AND ac.amount > 0
      UNION ALL
      SELECT rp.amount, (rp.created_at AT TIME ZONE 'Africa/Kampala')::date FROM public.repayments rp WHERE rp.rent_request_id = c.id AND rp.amount > 0
         AND NOT EXISTS (SELECT 1 FROM public.agent_collections ac WHERE ac.rent_request_id = rp.rent_request_id AND ac.reversed_at IS NULL AND ac.amount = rp.amount AND abs(extract(epoch FROM ac.created_at - rp.created_at)) < 300)) x
     WHERE x.d <= v_today;
    SELECT (status IN ('completed', 'fully_repaid') OR (total_repayment > 0 AND amount_repaid >= total_repayment) OR (total_repayment > 0 AND v_paidtot >= total_repayment)) INTO v_fully FROM public.rent_requests WHERE id = c.id;
    v_end := CASE WHEN v_fully THEN COALESCE(v_last, v_today) ELSE v_today END;
    v_dayscount := GREATEST(1, v_end - COALESCE(v_cs, v_first, v_end) + 1);
    v_avg := CASE WHEN v_paidtot > 0 THEN round(v_paidtot / v_dayscount, 2) ELSE 0 END;
    IF (v_stats->>'due_periods')::int <> v_due OR (v_stats->>'on_time_periods')::int <> v_ok_n OR (v_stats->>'longest_missed_streak')::int <> v_streak
       OR (v_stats->>'avg_daily_paid')::numeric <> v_avg OR (v_stats->>'fully_repaid')::boolean <> v_fully THEN
      ex := ex || jsonb_build_object('plan', c.id, 'server', v_stats, 'independent', jsonb_build_array(v_due, v_ok_n, v_streak, v_avg, v_fully));
    ELSE v_same := v_same + 1; END IF;
  END LOOP;
  r := r || jsonb_build_object('step', 'A the plan statistics (due periods, on-time periods, longest missed streak, average daily paid, fully repaid) equal an independent recompute for 30 plans',
    'pass', v_checked = 30 AND v_same = 30, 'detail', jsonb_build_object('checked', v_checked, 'matched', v_same, 'examples', ex));

  -- A: permissions
  SELECT DISTINCT COALESCE(x.assigned_agent_id, x.agent_id) INTO v_other FROM public.rent_requests x
   WHERE COALESCE(x.assigned_agent_id, x.agent_id) IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.rent_requests y WHERE y.tenant_id = v_tenant AND (y.agent_id = COALESCE(x.assigned_agent_id, x.agent_id) OR y.assigned_agent_id = COALESCE(x.assigned_agent_id, x.agent_id)))
     AND NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = COALESCE(x.assigned_agent_id, x.agent_id) AND ur.enabled AND ur.role::text IN ('agent_ops','tenant_ops','operations','manager','super_admin'))
     AND NOT EXISTS (SELECT 1 FROM public.agent_subagents s WHERE s.status = 'verified' AND (s.parent_agent_id = COALESCE(x.assigned_agent_id, x.agent_id) OR s.sub_agent_id = COALESCE(x.assigned_agent_id, x.agent_id)))
   LIMIT 1;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_other, 'role', 'authenticated')::text, true);
  v_ok := false; BEGIN PERFORM public.get_renewal_advice(v_prev); EXCEPTION WHEN OTHERS THEN v_ok := SQLERRM = 'NOT_YOUR_REQUEST'; END;
  r := r || jsonb_build_object('step', 'A another agent cannot read the advice (NOT_YOUR_REQUEST)', 'pass', v_ok);
  v_ok := false; BEGIN PERFORM public.preview_renewal_amount(v_prev, 300000, 30); EXCEPTION WHEN OTHERS THEN v_ok := SQLERRM = 'NOT_YOUR_REQUEST'; END;
  r := r || jsonb_build_object('step', 'A another agent cannot preview an amount (NOT_YOUR_REQUEST)', 'pass', v_ok);
  PERFORM set_config('request.jwt.claims', '', true);
  v_ok := false; BEGIN PERFORM public.get_renewal_advice(v_prev); EXCEPTION WHEN OTHERS THEN v_ok := SQLERRM = 'NOT_AUTHENTICATED'; END;
  r := r || jsonb_build_object('step', 'A signed-out cannot read the advice', 'pass', v_ok);
  r := r || jsonb_build_object('step', 'A anon cannot call the new functions; authenticated can; the helpers are internal; advice and preview are STABLE',
    'pass', NOT has_function_privilege('anon', 'public.get_renewal_advice(uuid,integer)', 'EXECUTE')
        AND NOT has_function_privilege('anon', 'public.preview_renewal_amount(uuid,numeric,integer)', 'EXECUTE')
        AND NOT has_function_privilege('anon', 'public.renew_rent_request(uuid,numeric,numeric,numeric,integer,text,text,text)', 'EXECUTE')
        AND has_function_privilege('authenticated', 'public.get_renewal_advice(uuid,integer)', 'EXECUTE')
        AND has_function_privilege('authenticated', 'public.preview_renewal_amount(uuid,numeric,integer)', 'EXECUTE')
        AND has_function_privilege('authenticated', 'public.renew_rent_request(uuid,numeric,numeric,numeric,integer,text,text,text)', 'EXECUTE')
        AND NOT has_function_privilege('authenticated', 'public._renewal_advice_core(public.rent_requests,integer,date)', 'EXECUTE')
        AND NOT has_function_privilege('authenticated', 'public._renewal_plan_stats(uuid,date)', 'EXECUTE')
        AND NOT has_function_privilege('authenticated', 'public._renewal_advice_params()', 'EXECUTE')
        AND (SELECT bool_and(provolatile = 's') FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('get_renewal_advice', 'preview_renewal_amount')));
  r := r || jsonb_build_object('step', 'A there is exactly one renew_rent_request and one rent_renewal_otp_context (no ambiguous overload)',
    'pass', (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'renew_rent_request') = 1
        AND (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'rent_renewal_otp_context') = 1);

  RAISE EXCEPTION 'ROLLED BACK REPORT (block 1): % passed of % | failing: %', (SELECT count(*) FROM jsonb_array_elements(r) e WHERE (e->>'pass') = 'true'), jsonb_array_length(r),
    COALESCE((SELECT string_agg(e->>'step' || ' ' || COALESCE((e->'detail')::text, ''), '; ') FROM jsonb_array_elements(r) e WHERE (e->>'pass') = 'false'), 'none');
END
$test$;

-- =====================================================================================================================================
-- Block 2: renewal cases (B). Every case runs in its own rolled-back sub-block against a live completed Rent Plan chosen at run time.
-- =====================================================================================================================================
DO $test$
DECLARE
  r jsonb := '[]'::jsonb;
  c record; k jsonb; v_cases jsonb;
  v_prev uuid; v_tenant uuid; v_agent uuid; v_R numeric; v_D int; v_L int; v_S int; v_Low numeric; v_Far numeric; v_S0 numeric; v_lc1 uuid; v_cat text; v_nosp boolean; v_landlord uuid;
  v_found boolean := false; v_new uuid; v_err text; v_tried int := 0;
  v_eff_rent numeric; v_eff_days int; v_changed boolean; v_exp numeric; v_cmp record; v_mode text; v_otpmode text; v_sg numeric;
  v_row jsonb; v_prev_before jsonb; v_prev_after jsonb; v_log jsonb; v_ev jsonb; v_otp jsonb; v_pass boolean; v_detail jsonb;
  v_keep_a jsonb; v_keep_b jsonb; v_rep jsonb; v_photo text; v_cn text;
  v_stable text := '(_at$|^id$)';
  E_OK constant text := 'The tenant asked for a different plan after talking to the landlord';
  CFG_GEN constant text := '{"bands":[{"name":"A","min_on_time_pct":0,"require_fully_repaid":false,"step_up_pct":50}],"affordability_multiplier":100,"min_explanation_length":10,"rounding_ugx":10000}';
  LIM_GEN constant text := '{"paid_increment_ugx":1000000,"missed_decrement_ugx":1,"max_limit_ugx":50000000}';
BEGIN
  -- fixture: the first candidate whose same-rent renewal is accepted by the live triggers
  FOR c IN
    SELECT rr.id, rr.tenant_id, COALESCE(rr.assigned_agent_id, rr.agent_id) AS agent_id, rr.rent_amount, rr.duration_days
      FROM public.rent_requests rr
     WHERE rr.status = 'completed' AND rr.landlord_id IS NOT NULL AND COALESCE(rr.assigned_agent_id, rr.agent_id) IS NOT NULL
       AND rr.rent_amount BETWEEN 100000 AND 1500000 AND rr.duration_days >= 14 AND public._rent_days_allowed(rr.duration_days)
       AND rr.created_at = (SELECT max(x.created_at) FROM public.rent_requests x WHERE x.tenant_id = rr.tenant_id)
       AND EXISTS (SELECT 1 FROM public.agent_collections ac WHERE ac.rent_request_id = rr.id AND ac.reversed_at IS NULL AND ac.amount > 0)
     ORDER BY md5(rr.id::text) LIMIT 15
  LOOP
    EXIT WHEN v_found;
    v_tried := v_tried + 1;
    BEGIN
      PERFORM set_config('request.jwt.claims', json_build_object('sub', c.agent_id, 'role', 'authenticated')::text, true);
      INSERT INTO public.rent_renewal_otps (prev_request_id, tenant_id, agent_id, code_hash, expires_at, verified_at) VALUES (c.id, c.tenant_id, c.agent_id, 'test', now() + interval '10 minutes', now());
      PERFORM public.renew_rent_request(c.id, 0.35, 32.58);
      v_prev := c.id; v_tenant := c.tenant_id; v_agent := c.agent_id; v_R := c.rent_amount; v_D := c.duration_days; v_found := true;
      RAISE EXCEPTION 'CASE_DONE';
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END LOOP;
  r := r || jsonb_build_object('step', 'B found a fixture plan whose same-rent renewal the live triggers accept', 'pass', v_found, 'detail', jsonb_build_object('tried', v_tried, 'rent', v_R, 'days', v_D));
  IF NOT v_found THEN RAISE EXCEPTION 'NO FIXTURE'; END IF;

  SELECT lc1_id, house_category, COALESCE(tenant_no_smartphone, false), landlord_id INTO v_lc1, v_cat, v_nosp, v_landlord FROM public.rent_requests WHERE id = v_prev;
  SELECT min(x) INTO v_L FROM unnest(public.rent_allowed_days()) x WHERE x >= v_D * 2;
  SELECT max(x) INTO v_S FROM unnest(public.rent_allowed_days()) x WHERE x <= v_D / 2;
  IF v_S IS NULL THEN v_S := 7; END IF;
  v_Low := GREATEST(10000, floor(v_R * 0.6 / 10000) * 10000);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_agent, 'role', 'authenticated')::text, true);
  v_S0 := (public.get_renewal_advice(v_prev)->>'suggested_max_rent')::numeric;
  v_Far := LEAST(6000000, GREATEST(ceil(v_S0 * 3 / 10000) * 10000, v_R + 300000));

  v_cases := jsonb_build_array(
    jsonb_build_object('n', 'same rent, same days, old call shape (no extras): accepted, nothing renewal-specific is written', 'expect', 'ok', 'otp', 'legacy', 'keep', 'a'),
    jsonb_build_object('n', 'same rent and days passed explicitly, no reason needed', 'expect', 'ok', 'rent', v_R, 'days', v_D, 'otp', 'bound', 'keep', 'b'),
    jsonb_build_object('n', 'a LONGER plan with an explanation: accepted, daily payment recalculated, advice recomputed for the new days', 'expect', 'ok', 'days', v_L, 'code', 'other', 'expl', E_OK),
    jsonb_build_object('n', 'a SHORTER plan with an explanation: accepted, daily payment recalculated', 'expect', 'ok', 'days', v_S, 'code', 'other', 'expl', E_OK),
    jsonb_build_object('n', 'days of 45 refused (not an allowed length)', 'expect', 'RENEWAL_DAYS_NOT_ALLOWED', 'days', 45, 'code', 'other', 'expl', E_OK, 'otp', 'legacy'),
    jsonb_build_object('n', 'days of 211 refused (not an allowed length)', 'expect', 'RENEWAL_DAYS_NOT_ALLOWED', 'days', 211, 'code', 'other', 'expl', E_OK, 'otp', 'legacy'),
    jsonb_build_object('n', 'days changed with no explanation refused', 'expect', 'RENEWAL_EXPLANATION_REQUIRED', 'days', v_L),
    jsonb_build_object('n', 'days changed with a 9-character explanation refused', 'expect', 'RENEWAL_EXPLANATION_REQUIRED', 'days', v_L, 'code', 'other', 'expl', 'too short'),
    jsonb_build_object('n', 'days changed with an unknown reason code refused', 'expect', 'RENEWAL_EXPLANATION_REQUIRED', 'days', v_L, 'code', 'because', 'expl', E_OK),
    jsonb_build_object('n', 'a LOWER rent with an explanation: accepted, not above the suggestion', 'expect', 'ok', 'rent', v_Low, 'code', 'tenant_requested_lower', 'expl', E_OK, 'above', 'false'),
    jsonb_build_object('n', 'a HIGHER rent exactly at the suggestion: accepted, not flagged', 'expect', 'ok', 'rent_mode', 'suggested', 'cfg', 'generous', 'needs_gt', 'true', 'code', 'landlord_raised', 'expl', E_OK, 'above', 'false'),
    jsonb_build_object('n', 'a HIGHER rent between the current rent and the suggestion: accepted, not flagged', 'expect', 'ok', 'rent_mode', 'between', 'cfg', 'generous', 'needs_gt', 'true', 'code', 'landlord_raised', 'expl', E_OK, 'above', 'false'),
    jsonb_build_object('n', 'a rent FAR ABOVE the suggestion: accepted and flagged above_suggestion, with the evidence link kept', 'expect', 'ok', 'rent', v_Far, 'code', 'landlord_raised', 'expl', E_OK, 'above', 'true', 'evidence', 'https://example.test/evidence.jpg'),
    jsonb_build_object('n', 'rent and days both changed with an explanation: accepted', 'expect', 'ok', 'rent', v_Low, 'days', v_L, 'code', 'moved_house', 'expl', E_OK),
    jsonb_build_object('n', 'a changed rent with no explanation refused', 'expect', 'RENEWAL_EXPLANATION_REQUIRED', 'rent', v_Low),
    jsonb_build_object('n', 'a rent of 0 refused', 'expect', 'RENEWAL_AMOUNT_INVALID', 'rent', 0, 'code', 'other', 'expl', E_OK, 'otp', 'legacy'),
    jsonb_build_object('n', 'a negative rent refused', 'expect', 'RENEWAL_AMOUNT_INVALID', 'rent', -5, 'code', 'other', 'expl', E_OK, 'otp', 'legacy'),
    jsonb_build_object('n', 'OTP bound to a different rent: refused (RENEWAL_OTP_MISMATCH)', 'expect', 'RENEWAL_OTP_MISMATCH', 'rent', v_Low, 'code', 'other', 'expl', E_OK, 'otp', 'bound_rent_other'),
    jsonb_build_object('n', 'OTP bound to a different number of days: refused (RENEWAL_OTP_MISMATCH)', 'expect', 'RENEWAL_OTP_MISMATCH', 'days', v_L, 'code', 'other', 'expl', E_OK, 'otp', 'bound_days_other'),
    jsonb_build_object('n', 'an old unbound OTP does not confirm a changed rent (RENEWAL_OTP_MISMATCH)', 'expect', 'RENEWAL_OTP_MISMATCH', 'rent', v_Low, 'code', 'other', 'expl', E_OK, 'otp', 'legacy'),
    jsonb_build_object('n', 'no OTP at all: refused (RENEWAL_OTP_REQUIRED)', 'expect', 'RENEWAL_OTP_REQUIRED', 'otp', 'none'),
    jsonb_build_object('n', 'changed amount with fresh GPS: trust signal is captured', 'expect', 'ok', 'rent', v_Low, 'code', 'other', 'expl', E_OK, 'trust', 'captured'),
    jsonb_build_object('n', 'changed amount with no fresh GPS: accepted, trust signal skipped', 'expect', 'ok', 'rent', v_Low, 'code', 'other', 'expl', E_OK, 'gps', 'no', 'trust', 'skipped_no_fresh_gps'),
    jsonb_build_object('n', 'config minimum of 40 characters: a 20-character explanation refused', 'expect', 'RENEWAL_EXPLANATION_REQUIRED', 'rent', v_Low, 'code', 'other', 'expl', 'twenty characters!!!', 'cfg', 'min40'),
    jsonb_build_object('n', 'config minimum of 40 characters: a 45-character explanation accepted', 'expect', 'ok', 'rent', v_Low, 'code', 'other', 'expl', 'This explanation is comfortably over forty chars', 'cfg', 'min40')
  );

  FOR k IN SELECT value FROM jsonb_array_elements(v_cases) LOOP
    v_new := NULL; v_err := NULL; v_row := NULL; v_log := NULL; v_ev := NULL; v_otp := NULL; v_prev_after := NULL;
    v_eff_rent := NULL; v_eff_days := NULL; v_changed := NULL; v_exp := NULL; v_sg := NULL; v_pass := false; v_detail := NULL;
    SELECT to_jsonb(p) INTO v_prev_before FROM public.rent_requests p WHERE p.id = v_prev;
    BEGIN
      IF k->>'cfg' = 'generous' THEN
        UPDATE public.system_config SET value = CFG_GEN::jsonb WHERE key = 'rent_renewal_advice_params';
        INSERT INTO public.system_config (key, value) VALUES ('rent_access_limit_params', LIM_GEN::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
      ELSIF k->>'cfg' = 'min40' THEN
        UPDATE public.system_config SET value = jsonb_set(value, '{min_explanation_length}', '40') WHERE key = 'rent_renewal_advice_params';
      END IF;
      PERFORM set_config('request.jwt.claims', json_build_object('sub', v_agent, 'role', 'authenticated')::text, true);
      v_eff_days := COALESCE((k->>'days')::int, v_D);
      v_mode := COALESCE(k->>'rent_mode', 'given');
      IF v_mode = 'suggested' THEN
        v_sg := (public.get_renewal_advice(v_prev, v_eff_days)->>'suggested_max_rent')::numeric; v_eff_rent := v_sg;
      ELSIF v_mode = 'between' THEN
        v_sg := (public.get_renewal_advice(v_prev, v_eff_days)->>'suggested_max_rent')::numeric; v_eff_rent := ceil(((v_R + v_sg) / 2) / 10000) * 10000;
      ELSE
        v_eff_rent := COALESCE((k->>'rent')::numeric, v_R);
      END IF;
      IF k->>'needs_gt' = 'true' AND NOT (v_sg > v_R AND v_eff_rent > v_R AND v_eff_rent <= v_sg) THEN
        RAISE EXCEPTION 'PRECONDITION: suggestion % is not above the current rent % in this fixture', v_sg, v_R;
      END IF;
      v_changed := (v_eff_rent IS DISTINCT FROM v_R) OR (v_eff_days IS DISTINCT FROM v_D);
      IF v_changed AND v_eff_rent > 0 AND public._rent_days_allowed(v_eff_days) THEN
        v_exp := (public.get_renewal_advice(v_prev, v_eff_days)->>'suggested_max_rent')::numeric;
      END IF;
      v_otpmode := COALESCE(k->>'otp', 'bound');
      IF v_otpmode <> 'none' THEN
        IF v_otpmode = 'legacy' OR v_eff_rent <= 0 OR NOT public._rent_days_allowed(v_eff_days) THEN
          INSERT INTO public.rent_renewal_otps (prev_request_id, tenant_id, agent_id, code_hash, expires_at, verified_at)
          VALUES (v_prev, v_tenant, v_agent, 'test', now() + interval '10 minutes', now());
        ELSE
          SELECT * INTO v_cmp FROM public.compute_rent_repayment(CASE v_otpmode WHEN 'bound_rent_other' THEN v_eff_rent + 10000 ELSE v_eff_rent END,
                                                                 CASE WHEN v_otpmode = 'bound_days_other' THEN CASE WHEN v_eff_days = 7 THEN 14 ELSE 7 END ELSE v_eff_days END);
          INSERT INTO public.rent_renewal_otps (prev_request_id, tenant_id, agent_id, code_hash, expires_at, verified_at, new_rent_amount, new_duration_days, new_daily_repayment, new_total_repayment)
          VALUES (v_prev, v_tenant, v_agent, 'test', now() + interval '10 minutes', now(),
                  CASE v_otpmode WHEN 'bound_rent_other' THEN v_eff_rent + 10000 ELSE v_eff_rent END,
                  CASE WHEN v_otpmode = 'bound_days_other' THEN CASE WHEN v_eff_days = 7 THEN 14 ELSE 7 END ELSE v_eff_days END,
                  v_cmp.daily_repayment, v_cmp.total_repayment);
        END IF;
      END IF;
      v_new := public.renew_rent_request(v_prev,
        CASE WHEN COALESCE(k->>'gps', 'yes') = 'yes' THEN 0.35 END, CASE WHEN COALESCE(k->>'gps', 'yes') = 'yes' THEN 32.58 END,
        CASE WHEN v_mode = 'given' THEN (k->>'rent')::numeric ELSE v_eff_rent END,
        (k->>'days')::int, k->>'code', k->>'expl', k->>'evidence');
      SELECT to_jsonb(n) INTO v_row FROM public.rent_requests n WHERE n.id = v_new;
      SELECT to_jsonb(l) INTO v_log FROM public.rent_amount_change_log l WHERE l.rent_request_id = v_new LIMIT 1;
      SELECT e.metadata INTO v_ev FROM public.system_events e WHERE e.event_type = 'rent_request.renewed_with_new_amount' AND e.related_entity_id = v_new LIMIT 1;
      SELECT to_jsonb(o) INTO v_otp FROM public.rent_renewal_otps o WHERE o.tenant_id = v_tenant AND o.agent_id = v_agent ORDER BY o.created_at DESC LIMIT 1;
      SELECT to_jsonb(p) INTO v_prev_after FROM public.rent_requests p WHERE p.id = v_prev;
      RAISE EXCEPTION 'CASE_DONE';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'CASE_DONE' THEN v_err := SQLERRM; END IF;
    END;

    IF k->>'expect' = 'ok' THEN
      v_pass := v_err IS NULL AND v_row IS NOT NULL;
      IF v_pass THEN
        SELECT * INTO v_cmp FROM public.compute_rent_repayment(v_eff_rent, v_eff_days);
        v_pass := COALESCE(v_prev_before = v_prev_after, false)
              AND (v_row->>'rent_amount')::numeric = v_eff_rent AND (v_row->>'duration_days')::int = v_eff_days
              AND (v_row->>'access_fee')::numeric = v_cmp.access_fee AND (v_row->>'request_fee')::numeric = v_cmp.request_fee
              AND (v_row->>'total_repayment')::numeric = v_cmp.total_repayment AND (v_row->>'daily_repayment')::numeric = v_cmp.daily_repayment
              AND v_row->>'registration_type' = 'renewal'
              AND COALESCE((v_otp->>'consumed_request_id') = v_new::text, false);
        IF v_changed THEN
          v_pass := v_pass
              AND (v_row->>'renewal_previous_rent')::numeric = v_R AND (v_row->>'renewal_previous_days')::int = v_D
              AND (v_row->'renewal_advice_snapshot'->>'chosen_days')::int = v_eff_days
              AND (v_row->'renewal_advice_snapshot'->>'suggested_max_rent')::numeric = v_exp
              AND (v_row->>'renewal_above_suggestion')::boolean = (v_eff_rent > v_exp)
              AND (v_row->>'renewal_above_by')::numeric = GREATEST(0, v_eff_rent - v_exp)
              AND v_row->>'renewal_change_reason_code' = k->>'code' AND v_row->>'renewal_change_explanation' = btrim(k->>'expl')
              AND COALESCE(v_row->>'renewal_evidence_url' IS NOT DISTINCT FROM k->>'evidence', false)
              AND v_log IS NOT NULL AND v_log->>'source' = 'agent_renewal_edit'
              AND (v_log->>'old_rent_amount')::numeric = v_R AND (v_log->>'new_rent_amount')::numeric = v_eff_rent
              AND (v_log->>'old_duration_days')::int = v_D AND (v_log->>'new_duration_days')::int = v_eff_days
              AND (v_log->>'new_daily_repayment')::numeric = v_cmp.daily_repayment
              AND v_ev IS NOT NULL AND (v_ev->>'above_suggestion')::boolean = (v_eff_rent > v_exp)
              AND (v_ev->>'previous_days')::int = v_D AND (v_ev->>'new_days')::int = v_eff_days
              AND (v_ev->>'previous_rent')::numeric = v_R AND (v_ev->>'new_rent')::numeric = v_eff_rent
              AND (v_ev->>'suggested_max_rent')::numeric = v_exp AND v_ev->>'reason_code' = k->>'code';
          IF k->>'above' IS NOT NULL THEN v_pass := v_pass AND (v_row->>'renewal_above_suggestion')::boolean = (k->>'above')::boolean; END IF;
          IF k->>'trust' IS NOT NULL THEN v_pass := v_pass AND v_ev->>'trust_signal' = k->>'trust'; END IF;
        ELSE
          v_pass := v_pass AND v_row->>'renewal_previous_rent' IS NULL AND v_row->>'renewal_previous_days' IS NULL AND v_row->'renewal_advice_snapshot' IS NOT DISTINCT FROM 'null'::jsonb
              AND v_row->>'renewal_above_suggestion' IS NULL AND v_row->>'renewal_above_by' IS NULL AND v_row->>'renewal_change_reason_code' IS NULL
              AND v_row->>'renewal_change_explanation' IS NULL AND v_row->>'renewal_evidence_url' IS NULL AND v_log IS NULL AND v_ev IS NULL;
        END IF;
      END IF;
      IF k->>'keep' = 'a' THEN v_keep_a := v_row; ELSIF k->>'keep' = 'b' THEN v_keep_b := v_row; END IF;
    ELSE
      v_pass := v_err LIKE (k->>'expect') || '%' AND v_new IS NULL;
    END IF;
    r := r || jsonb_build_object('step', 'B ' || (k->>'n'), 'pass', COALESCE(v_pass, false),
         'detail', jsonb_build_object('err', left(v_err, 160), 'rent', v_eff_rent, 'days', v_eff_days, 'suggested', v_exp, 'row_status', v_row->>'status'));
  END LOOP;

  -- same rent and days is identical to what the old function wrote: a direct replica of its insert gives the same row
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_agent, 'role', 'authenticated')::text, true);
    INSERT INTO public.rent_renewal_otps (prev_request_id, tenant_id, agent_id, code_hash, expires_at, verified_at) VALUES (v_prev, v_tenant, v_agent, 'test', now() + interval '10 minutes', now());
    SELECT tenant_photo_url INTO v_photo FROM public.rent_requests WHERE tenant_id = v_tenant AND tenant_photo_url IS NOT NULL AND btrim(tenant_photo_url) <> '' ORDER BY created_at DESC LIMIT 1;
    PERFORM set_config('app.bypass_daily_eligibility', 'true', true);
    INSERT INTO public.rent_requests (tenant_id, agent_id, landlord_id, lc1_id, rent_amount, duration_days, access_fee, request_fee, total_repayment, daily_repayment,
        status, house_category, tenant_no_smartphone, request_latitude, request_longitude, tenant_photo_url, registration_type,
        agent_guarantor_consent, agent_guarantor_consent_at, agent_guarantor_consent_version)
    VALUES (v_tenant, v_agent, v_landlord, v_lc1, v_R, v_D, 0, 0, 0, 0, 'pending', v_cat, v_nosp, 0.35, 32.58, v_photo, 'renewal', true, now(), 'v1')
    RETURNING to_jsonb(rent_requests.*) INTO v_rep;
    RAISE EXCEPTION 'CASE_DONE';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'CASE_DONE' THEN v_err := SQLERRM; v_rep := NULL; END IF;
  END;
  r := r || jsonb_build_object('step', 'B a same-rent, same-days renewal is byte-identical to a direct replica of the old function''s insert (every column but ids and timestamps)',
    'pass', v_rep IS NOT NULL AND v_keep_a IS NOT NULL AND v_keep_b IS NOT NULL
        AND (SELECT jsonb_object_agg(key, value) FROM jsonb_each(v_rep) WHERE key !~ v_stable) = (SELECT jsonb_object_agg(key, value) FROM jsonb_each(v_keep_a) WHERE key !~ v_stable)
        AND (SELECT jsonb_object_agg(key, value) FROM jsonb_each(v_keep_a) WHERE key !~ v_stable) = (SELECT jsonb_object_agg(key, value) FROM jsonb_each(v_keep_b) WHERE key !~ v_stable),
    'detail', jsonb_build_object('err', v_err, 'diff', (SELECT jsonb_agg(a.key) FROM jsonb_each(COALESCE(v_rep, '{}')) a JOIN jsonb_each(COALESCE(v_keep_a, '{}')) b USING (key) WHERE a.key !~ v_stable AND a.value IS DISTINCT FROM b.value)));

  RAISE EXCEPTION 'ROLLED BACK REPORT (block 2): % passed of % | failing: %', (SELECT count(*) FROM jsonb_array_elements(r) e WHERE (e->>'pass') = 'true'), jsonb_array_length(r),
    COALESCE((SELECT string_agg(e->>'step' || ' ' || COALESCE((e->'detail')::text, ''), '; ') FROM jsonb_array_elements(r) e WHERE (e->>'pass') = 'false'), 'none');
END
$test$;

-- =====================================================================================================================================
-- Block 3: OTP context (C), written-once renewal columns (C), reviewer notes and reviewer reads under real RLS (D).
-- =====================================================================================================================================
DO $test$
DECLARE
  r jsonb := '[]'::jsonb;
  c record;
  v_prev uuid; v_tenant uuid; v_agent uuid; v_R numeric; v_D int; v_L int; v_Low numeric; v_found boolean := false;
  v_U uuid; v_Z uuid; v_other uuid; v_new uuid; v_note uuid; v_role text; v_n int; v_ok boolean; v_ctx jsonb; v_cmp record; v_row jsonb; v_q jsonb;
  v_agent_staff boolean; v_def text; v_err text; v_msg text;
  E_OK constant text := 'The tenant asked for a different plan after talking to the landlord';
BEGIN
  FOR c IN
    SELECT rr.id, rr.tenant_id, COALESCE(rr.assigned_agent_id, rr.agent_id) AS agent_id, rr.rent_amount, rr.duration_days
      FROM public.rent_requests rr
     WHERE rr.status = 'completed' AND rr.landlord_id IS NOT NULL AND COALESCE(rr.assigned_agent_id, rr.agent_id) IS NOT NULL
       AND rr.rent_amount BETWEEN 100000 AND 1500000 AND rr.duration_days >= 14 AND public._rent_days_allowed(rr.duration_days)
       AND rr.created_at = (SELECT max(x.created_at) FROM public.rent_requests x WHERE x.tenant_id = rr.tenant_id)
       AND EXISTS (SELECT 1 FROM public.agent_collections ac WHERE ac.rent_request_id = rr.id AND ac.reversed_at IS NULL AND ac.amount > 0)
     ORDER BY md5(rr.id::text) LIMIT 15
  LOOP
    EXIT WHEN v_found;
    BEGIN
      PERFORM set_config('request.jwt.claims', json_build_object('sub', c.agent_id, 'role', 'authenticated')::text, true);
      INSERT INTO public.rent_renewal_otps (prev_request_id, tenant_id, agent_id, code_hash, expires_at, verified_at) VALUES (c.id, c.tenant_id, c.agent_id, 'test', now() + interval '10 minutes', now());
      PERFORM public.renew_rent_request(c.id, 0.35, 32.58);
      v_prev := c.id; v_tenant := c.tenant_id; v_agent := c.agent_id; v_R := c.rent_amount; v_D := c.duration_days; v_found := true;
      RAISE EXCEPTION 'CASE_DONE';
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END LOOP;
  r := r || jsonb_build_object('step', 'C found a fixture plan', 'pass', v_found);
  IF NOT v_found THEN RAISE EXCEPTION 'NO FIXTURE'; END IF;
  SELECT min(x) INTO v_L FROM unnest(public.rent_allowed_days()) x WHERE x >= v_D * 2;
  v_Low := GREATEST(10000, floor(v_R * 0.6 / 10000) * 10000);

  -- the OTP context carries the NEW rent, NEW daily payment and NEW days
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_agent, 'role', 'authenticated')::text, true);
  v_ctx := public.rent_renewal_otp_context(v_prev);
  SELECT * INTO v_cmp FROM public.compute_rent_repayment(v_R, v_D);
  r := r || jsonb_build_object('step', 'C the OTP context with no new figures gives the current rent and days, unchanged, with the daily payment',
    'pass', v_ctx ?& ARRAY['tenant_id', 'tenant_phone', 'tenant_name', 'agent_id', 'agent_name', 'new_rent_amount', 'new_days', 'new_daily_repayment', 'new_total_repayment', 'changed']
        AND (v_ctx->>'new_rent_amount')::numeric = v_R AND (v_ctx->>'new_days')::int = v_D AND (v_ctx->>'new_daily_repayment')::numeric = v_cmp.daily_repayment
        AND (v_ctx->>'new_total_repayment')::numeric = v_cmp.total_repayment AND NOT (v_ctx->>'changed')::boolean);
  v_ctx := public.rent_renewal_otp_context(v_prev, v_Low, v_L);
  SELECT * INTO v_cmp FROM public.compute_rent_repayment(v_Low, v_L);
  r := r || jsonb_build_object('step', 'C the OTP context for a new rent and new days gives that rent, those days and the daily payment the server will apply',
    'pass', (v_ctx->>'new_rent_amount')::numeric = v_Low AND (v_ctx->>'new_days')::int = v_L AND (v_ctx->>'new_daily_repayment')::numeric = v_cmp.daily_repayment
        AND (v_ctx->>'new_total_repayment')::numeric = v_cmp.total_repayment AND (v_ctx->>'changed')::boolean);
  v_ok := false; BEGIN PERFORM public.rent_renewal_otp_context(v_prev, v_Low, 45); EXCEPTION WHEN OTHERS THEN v_ok := SQLERRM LIKE 'RENEWAL_DAYS_NOT_ALLOWED%'; END;
  r := r || jsonb_build_object('step', 'C the OTP context refuses days that are not allowed', 'pass', v_ok);
  v_ok := false; BEGIN PERFORM public.rent_renewal_otp_context(v_prev, 0, v_D); EXCEPTION WHEN OTHERS THEN v_ok := SQLERRM LIKE 'RENEWAL_AMOUNT_INVALID%'; END;
  r := r || jsonb_build_object('step', 'C the OTP context refuses a rent of 0', 'pass', v_ok);

  SELECT DISTINCT COALESCE(x.assigned_agent_id, x.agent_id) INTO v_other FROM public.rent_requests x
   WHERE COALESCE(x.assigned_agent_id, x.agent_id) IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.rent_requests y WHERE y.tenant_id = v_tenant AND (y.agent_id = COALESCE(x.assigned_agent_id, x.agent_id) OR y.assigned_agent_id = COALESCE(x.assigned_agent_id, x.agent_id)))
     AND NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = COALESCE(x.assigned_agent_id, x.agent_id) AND ur.enabled AND ur.role::text IN ('agent_ops','tenant_ops','landlord_ops','coo','cfo','operations','manager','super_admin'))
     AND NOT EXISTS (SELECT 1 FROM public.agent_subagents s WHERE s.status = 'verified' AND (s.parent_agent_id = COALESCE(x.assigned_agent_id, x.agent_id) OR s.sub_agent_id = COALESCE(x.assigned_agent_id, x.agent_id)))
   LIMIT 1;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_other, 'role', 'authenticated')::text, true);
  v_ok := false; BEGIN PERFORM public.rent_renewal_otp_context(v_prev, v_Low, v_L); EXCEPTION WHEN OTHERS THEN v_ok := SQLERRM = 'NOT_YOUR_REQUEST'; END;
  r := r || jsonb_build_object('step', 'C another agent cannot get the OTP context (NOT_YOUR_REQUEST)', 'pass', v_ok);
  PERFORM set_config('request.jwt.claims', '', true);
  v_ok := false; BEGIN PERFORM public.rent_renewal_otp_context(v_prev, v_Low, v_L); EXCEPTION WHEN OTHERS THEN v_ok := SQLERRM = 'NOT_AUTHENTICATED'; END;
  r := r || jsonb_build_object('step', 'C signed-out cannot get the OTP context', 'pass', v_ok);
  r := r || jsonb_build_object('step', 'C anon cannot call the OTP context, authenticated can',
    'pass', NOT has_function_privilege('anon', 'public.rent_renewal_otp_context(uuid,numeric,integer)', 'EXECUTE') AND has_function_privilege('authenticated', 'public.rent_renewal_otp_context(uuid,numeric,integer)', 'EXECUTE'));

  -- the previous plan is only ever read: the function has no UPDATE of rent_requests
  v_def := pg_get_functiondef('public.renew_rent_request(uuid,numeric,numeric,numeric,integer,text,text,text)'::regprocedure);
  r := r || jsonb_build_object('step', 'C renew_rent_request contains no UPDATE or DELETE of rent_requests (the previous plan is never edited)',
    'pass', v_def !~* 'update\s+(public\.)?rent_requests' AND v_def !~* 'delete\s+from\s+(public\.)?rent_requests');

  SELECT p.id INTO v_U FROM public.profiles p
   WHERE p.id NOT IN (v_agent, v_tenant) AND p.id <> v_other
     AND NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = p.id)
     AND NOT EXISTS (SELECT 1 FROM public.rent_requests y WHERE y.agent_id = p.id OR y.assigned_agent_id = p.id)
   ORDER BY md5(p.id::text) LIMIT 1;
  SELECT p.id INTO v_Z FROM public.profiles p
   WHERE p.id NOT IN (v_agent, v_tenant, v_U) AND p.id <> v_other
     AND NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = p.id)
     AND NOT EXISTS (SELECT 1 FROM public.rent_requests y WHERE y.agent_id = p.id OR y.assigned_agent_id = p.id)
   ORDER BY md5(p.id::text) LIMIT 1;
  v_agent_staff := public.has_role(v_agent, 'agent_ops'::app_role) OR public.has_role(v_agent, 'tenant_ops'::app_role) OR public.has_role(v_agent, 'landlord_ops'::app_role)
                OR public.has_role(v_agent, 'coo'::app_role) OR public.has_role(v_agent, 'cfo'::app_role) OR public.has_role(v_agent, 'super_admin'::app_role);
  r := r || jsonb_build_object('step', 'D found two role-less users, one other agent, and a fixture agent', 'pass', v_U IS NOT NULL AND v_Z IS NOT NULL AND v_other IS NOT NULL, 'detail', jsonb_build_object('agent_is_staff', v_agent_staff));

  -- one renewed (changed) request per reviewer role, in a rolled-back sub-block
  FOREACH v_role IN ARRAY ARRAY['agent_ops', 'tenant_ops', 'landlord_ops', 'coo', 'cfo', 'super_admin'] LOOP
    v_err := NULL;
    BEGIN
      PERFORM set_config('request.jwt.claims', json_build_object('sub', v_agent, 'role', 'authenticated')::text, true);
      SELECT * INTO v_cmp FROM public.compute_rent_repayment(v_Low, v_D);
      INSERT INTO public.rent_renewal_otps (prev_request_id, tenant_id, agent_id, code_hash, expires_at, verified_at, new_rent_amount, new_duration_days, new_daily_repayment, new_total_repayment)
      VALUES (v_prev, v_tenant, v_agent, 'test', now() + interval '10 minutes', now(), v_Low, v_D, v_cmp.daily_repayment, v_cmp.total_repayment);
      v_new := public.renew_rent_request(v_prev, 0.35, 32.58, v_Low, NULL, 'tenant_requested_lower', E_OK, 'https://example.test/e.jpg');

      -- written once: the advice, reason and explanation cannot be changed afterwards, by anyone
      v_ok := false; BEGIN UPDATE public.rent_requests SET renewal_change_explanation = 'rewritten after the fact' WHERE id = v_new; EXCEPTION WHEN OTHERS THEN v_ok := SQLSTATE = '42501' AND SQLERRM LIKE '%written once%'; END;
      r := r || jsonb_build_object('step', 'C ' || v_role || ': the explanation on a renewal cannot be rewritten', 'pass', v_ok);
      IF v_role = 'agent_ops' THEN
        v_ok := true;
        BEGIN UPDATE public.rent_requests SET renewal_advice_snapshot = '{}'::jsonb WHERE id = v_new; v_ok := false; EXCEPTION WHEN OTHERS THEN NULL; END;
        BEGIN UPDATE public.rent_requests SET renewal_above_suggestion = NOT COALESCE(renewal_above_suggestion, false) WHERE id = v_new; v_ok := false; EXCEPTION WHEN OTHERS THEN NULL; END;
        BEGIN UPDATE public.rent_requests SET renewal_above_by = 1 WHERE id = v_new; v_ok := false; EXCEPTION WHEN OTHERS THEN NULL; END;
        BEGIN UPDATE public.rent_requests SET renewal_change_reason_code = 'other' WHERE id = v_new; v_ok := false; EXCEPTION WHEN OTHERS THEN NULL; END;
        BEGIN UPDATE public.rent_requests SET renewal_previous_rent = 1 WHERE id = v_new; v_ok := false; EXCEPTION WHEN OTHERS THEN NULL; END;
        BEGIN UPDATE public.rent_requests SET renewal_previous_days = 7 WHERE id = v_new; v_ok := false; EXCEPTION WHEN OTHERS THEN NULL; END;
        BEGIN UPDATE public.rent_requests SET renewal_evidence_url = NULL WHERE id = v_new; v_ok := false; EXCEPTION WHEN OTHERS THEN NULL; END;
        r := r || jsonb_build_object('step', 'C every other renewal column is written once too', 'pass', v_ok);
        v_ok := false; BEGIN UPDATE public.rent_requests SET tenant_no_smartphone = tenant_no_smartphone WHERE id = v_new; v_ok := true; EXCEPTION WHEN OTHERS THEN v_ok := false; END;
        r := r || jsonb_build_object('step', 'C an update that leaves the renewal columns alone is not blocked by the guard', 'pass', v_ok);
      END IF;

      -- reviewer: holds exactly this one role (rolled back with the sub-block)
      INSERT INTO public.user_roles (user_id, role) VALUES (v_U, v_role::public.app_role);
      PERFORM set_config('request.jwt.claims', json_build_object('sub', v_U, 'role', 'authenticated')::text, true);
      SET LOCAL ROLE authenticated;

      SELECT to_jsonb(q) INTO v_row FROM (SELECT renewal_previous_rent, renewal_previous_days, renewal_advice_snapshot, renewal_above_suggestion, renewal_above_by,
                                                 renewal_change_reason_code, renewal_change_explanation, renewal_evidence_url FROM public.rent_requests WHERE id = v_new) q;
      r := r || jsonb_build_object('step', 'D ' || v_role || ' can read the renewal columns of the request through the normal request read',
        'pass', v_row IS NOT NULL AND (v_row->>'renewal_previous_rent')::numeric = v_R AND (v_row->>'renewal_previous_days')::int = v_D
            AND v_row->'renewal_advice_snapshot' ? 'suggested_max_rent' AND v_row->>'renewal_change_explanation' = E_OK AND v_row->>'renewal_change_reason_code' = 'tenant_requested_lower'
            AND v_row->>'renewal_evidence_url' = 'https://example.test/e.jpg' AND v_row->>'renewal_above_suggestion' IS NOT NULL AND v_row->>'renewal_above_by' IS NOT NULL);

      v_note := public.add_rent_request_review_note(v_new, 'Checked the explanation against the landlord call');
      SELECT count(*) INTO v_n FROM public.rent_request_review_notes WHERE request_id = v_new;
      RESET ROLE;
      r := r || jsonb_build_object('step', 'D ' || v_role || ' can add a note and read it back; the role and the stage are recorded',
        'pass', v_n = 1 AND (SELECT author = v_U AND author_role = v_role AND stage = (SELECT status FROM public.rent_requests WHERE id = v_new) AND note = 'Checked the explanation against the landlord call'
                               FROM public.rent_request_review_notes WHERE id = v_note));
      SET LOCAL ROLE authenticated;

      v_ok := false; BEGIN PERFORM public.add_rent_request_review_note(v_new, 'too short'); EXCEPTION WHEN OTHERS THEN v_ok := SQLERRM LIKE 'NOTE_TOO_SHORT%'; END;
      r := r || jsonb_build_object('step', 'D ' || v_role || ': a note under 10 characters is refused', 'pass', v_ok);
      v_ok := false; BEGIN PERFORM public.add_rent_request_review_note(v_new, 'A note claiming a role this user does not hold', NULL,
                          CASE WHEN v_role = 'cfo' THEN 'coo' ELSE 'cfo' END); EXCEPTION WHEN OTHERS THEN v_ok := SQLERRM LIKE 'NOT_A_REVIEWER%'; END;
      r := r || jsonb_build_object('step', 'D ' || v_role || ': a note cannot claim a role the user does not hold', 'pass', v_ok);
      v_ok := false; BEGIN PERFORM public.add_rent_request_review_note(gen_random_uuid(), 'A note on a request that does not exist'); EXCEPTION WHEN OTHERS THEN v_ok := SQLERRM LIKE 'REQUEST_NOT_FOUND%'; END;
      r := r || jsonb_build_object('step', 'D ' || v_role || ': a note on an unknown request is refused', 'pass', v_ok);

      v_ok := false; BEGIN INSERT INTO public.rent_request_review_notes (request_id, author, author_role, stage, note) VALUES (v_new, v_U, v_role, 'x', 'direct insert attempt note'); EXCEPTION WHEN insufficient_privilege THEN v_ok := true; WHEN OTHERS THEN v_ok := false; END;
      r := r || jsonb_build_object('step', 'D ' || v_role || ': a direct INSERT into the notes table is not allowed (notes only through the RPC)', 'pass', v_ok);
      v_ok := false; BEGIN UPDATE public.rent_request_review_notes SET note = 'edited after the fact!!' WHERE id = v_note; v_ok := NOT FOUND; EXCEPTION WHEN insufficient_privilege THEN v_ok := true; WHEN OTHERS THEN v_ok := false; END;
      r := r || jsonb_build_object('step', 'D ' || v_role || ': a note cannot be edited', 'pass', v_ok);
      v_ok := false; BEGIN DELETE FROM public.rent_request_review_notes WHERE id = v_note; v_ok := NOT FOUND; EXCEPTION WHEN insufficient_privilege THEN v_ok := true; WHEN OTHERS THEN v_ok := false; END;
      r := r || jsonb_build_object('step', 'D ' || v_role || ': a note cannot be deleted', 'pass', v_ok);
      RESET ROLE;

      IF v_role = 'agent_ops' THEN
        -- even the table owner cannot edit, delete or truncate a note
        v_ok := false; BEGIN UPDATE public.rent_request_review_notes SET note = 'owner edit after the fact' WHERE id = v_note; EXCEPTION WHEN OTHERS THEN v_ok := SQLERRM LIKE '%append-only%'; END;
        r := r || jsonb_build_object('step', 'D append-only: even the owner cannot UPDATE a note', 'pass', v_ok);
        v_ok := false; BEGIN DELETE FROM public.rent_request_review_notes WHERE id = v_note; EXCEPTION WHEN OTHERS THEN v_ok := SQLERRM LIKE '%append-only%'; END;
        r := r || jsonb_build_object('step', 'D append-only: even the owner cannot DELETE a note', 'pass', v_ok);
        v_ok := false; BEGIN TRUNCATE public.rent_request_review_notes; EXCEPTION WHEN OTHERS THEN v_ok := SQLERRM LIKE '%append-only%'; END;
        r := r || jsonb_build_object('step', 'D append-only: even the owner cannot TRUNCATE the notes', 'pass', v_ok);
        r := r || jsonb_build_object('step', 'D the notes table grants no INSERT, UPDATE or DELETE to the API roles',
          'pass', NOT has_table_privilege('authenticated', 'public.rent_request_review_notes', 'INSERT') AND NOT has_table_privilege('authenticated', 'public.rent_request_review_notes', 'UPDATE')
              AND NOT has_table_privilege('authenticated', 'public.rent_request_review_notes', 'DELETE') AND NOT has_table_privilege('anon', 'public.rent_request_review_notes', 'SELECT')
              AND has_table_privilege('authenticated', 'public.rent_request_review_notes', 'SELECT')
              AND NOT has_table_privilege('service_role', 'public.rent_request_review_notes', 'UPDATE') AND NOT has_table_privilege('service_role', 'public.rent_request_review_notes', 'DELETE'));

        -- who can NOT read the notes (or the renewal request)
        PERFORM set_config('request.jwt.claims', json_build_object('sub', v_Z, 'role', 'authenticated')::text, true);
        SET LOCAL ROLE authenticated;
        SELECT count(*) INTO v_n FROM public.rent_request_review_notes WHERE request_id = v_new;
        r := r || jsonb_build_object('step', 'D a user with no staff role and no link to the request sees none of its notes', 'pass', v_n = 0);
        SELECT count(*) INTO v_n FROM public.rent_requests WHERE id = v_new;
        r := r || jsonb_build_object('step', 'D that user cannot read the request either', 'pass', v_n = 0);
        RESET ROLE;
        PERFORM set_config('request.jwt.claims', json_build_object('sub', v_other, 'role', 'authenticated')::text, true);
        SET LOCAL ROLE authenticated;
        SELECT count(*) INTO v_n FROM public.rent_request_review_notes WHERE request_id = v_new;
        r := r || jsonb_build_object('step', 'D ANOTHER agent cannot read the notes on this agent''s request', 'pass', v_n = 0);
        v_ok := false; BEGIN PERFORM public.add_rent_request_review_note(v_new, 'An agent trying to add a review note'); EXCEPTION WHEN OTHERS THEN v_ok := SQLERRM LIKE 'NOT_A_REVIEWER%'; END;
        r := r || jsonb_build_object('step', 'D a plain agent cannot add a review note', 'pass', v_ok);
        RESET ROLE;
        IF NOT v_agent_staff THEN
          PERFORM set_config('request.jwt.claims', json_build_object('sub', v_agent, 'role', 'authenticated')::text, true);
          SET LOCAL ROLE authenticated;
          SELECT count(*) INTO v_n FROM public.rent_request_review_notes WHERE request_id = v_new;
          r := r || jsonb_build_object('step', 'D the request''s own agent can read the notes on it', 'pass', v_n = 1);
          RESET ROLE;
        END IF;

        -- the request survives with its notes only until it is deleted: deleting the request takes its notes with it
        v_ok := false;
        BEGIN
          DELETE FROM public.rent_requests WHERE id = v_new;
          v_ok := NOT EXISTS (SELECT 1 FROM public.rent_request_review_notes WHERE request_id = v_new);
        EXCEPTION WHEN OTHERS THEN v_msg := SQLERRM; v_ok := NULL; END;
        r := r || jsonb_build_object('step', 'D deleting a request removes its notes (the append-only guard lets the cascade through)', 'pass', COALESCE(v_ok, false), 'detail', v_msg);
      END IF;

      RAISE EXCEPTION 'CASE_DONE';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'CASE_DONE' THEN
        r := r || jsonb_build_object('step', 'D ' || v_role || ': the sub-block ran to its end', 'pass', false, 'detail', left(SQLERRM, 300));
      END IF;
    END;
  END LOOP;

  RAISE EXCEPTION 'ROLLED BACK REPORT (block 3): % passed of % | failing: %', (SELECT count(*) FROM jsonb_array_elements(r) e WHERE (e->>'pass') = 'true'), jsonb_array_length(r),
    COALESCE((SELECT string_agg(e->>'step' || ' ' || COALESCE((e->'detail')::text, ''), '; ') FROM jsonb_array_elements(r) e WHERE (e->>'pass') = 'false'), 'none');
END
$test$;

-- =====================================================================================================================================
-- Block 4: the Service Center queue RPC returns the renewal fields (D).
-- =====================================================================================================================================
DO $test$
DECLARE
  r jsonb := '[]'::jsonb; c record; v_found boolean := false;
  v_prev uuid; v_tenant uuid; v_agent uuid; v_R numeric; v_D int; v_Low numeric; v_new uuid; v_mgr uuid; v_q jsonb; v_item jsonb; v_status text; v_cmp record; v_why text;
  E_OK constant text := 'The tenant asked for a different plan after talking to the landlord';
BEGIN
  FOR c IN
    SELECT rr.id, rr.tenant_id, COALESCE(rr.assigned_agent_id, rr.agent_id) AS agent_id, rr.rent_amount, rr.duration_days
      FROM public.rent_requests rr
     WHERE rr.status = 'completed' AND rr.landlord_id IS NOT NULL AND COALESCE(rr.assigned_agent_id, rr.agent_id) IS NOT NULL
       AND rr.rent_amount BETWEEN 100000 AND 1500000 AND rr.duration_days >= 14 AND public._rent_days_allowed(rr.duration_days)
       AND rr.created_at = (SELECT max(x.created_at) FROM public.rent_requests x WHERE x.tenant_id = rr.tenant_id)
       AND EXISTS (SELECT 1 FROM public.agent_collections ac WHERE ac.rent_request_id = rr.id AND ac.reversed_at IS NULL AND ac.amount > 0)
     ORDER BY md5(rr.id::text) LIMIT 15
  LOOP
    EXIT WHEN v_found;
    BEGIN
      PERFORM set_config('request.jwt.claims', json_build_object('sub', c.agent_id, 'role', 'authenticated')::text, true);
      v_Low := GREATEST(10000, floor(c.rent_amount * 0.6 / 10000) * 10000);
      SELECT * INTO v_cmp FROM public.compute_rent_repayment(v_Low, c.duration_days);
      INSERT INTO public.rent_renewal_otps (prev_request_id, tenant_id, agent_id, code_hash, expires_at, verified_at, new_rent_amount, new_duration_days, new_daily_repayment, new_total_repayment)
      VALUES (c.id, c.tenant_id, c.agent_id, 'test', now() + interval '10 minutes', now(), v_Low, c.duration_days, v_cmp.daily_repayment, v_cmp.total_repayment);
      v_new := public.renew_rent_request(c.id, 0.35, 32.58, v_Low, NULL, 'tenant_requested_lower', E_OK, NULL);
      SELECT status, service_center_manager_id INTO v_status, v_mgr FROM public.rent_requests WHERE id = v_new;
      IF v_mgr IS NULL THEN
        SELECT user_id INTO v_mgr FROM public.user_roles WHERE enabled AND role::text IN ('tenant_ops', 'manager') LIMIT 1;
      END IF;
      IF v_status <> 'service_center_review' OR v_mgr IS NULL THEN
        UPDATE public.rent_requests SET status = 'service_center_review', service_center_manager_id = v_mgr WHERE id = v_new;
      END IF;
      PERFORM set_config('request.jwt.claims', json_build_object('sub', v_mgr, 'role', 'authenticated')::text, true);
      v_q := public.get_service_center_rent_queue();
      SELECT i INTO v_item FROM jsonb_array_elements(v_q->'pending') i WHERE i->>'id' = v_new::text;
      r := r || jsonb_build_object('step', 'D the Service Center queue lists the renewal with the new fields (previous rent and days, advice, above-suggestion flag, reason, explanation, evidence)',
        'pass', v_item IS NOT NULL AND v_item->>'registration_type' = 'renewal' AND (v_item->>'renewal_previous_rent')::numeric = c.rent_amount
            AND (v_item->>'renewal_previous_days')::int = c.duration_days AND v_item->'renewal_advice_snapshot' ? 'suggested_max_rent'
            AND v_item->>'renewal_above_suggestion' IS NOT NULL AND v_item->>'renewal_above_by' IS NOT NULL
            AND v_item->>'renewal_change_reason_code' = 'tenant_requested_lower' AND v_item->>'renewal_change_explanation' = E_OK AND v_item ? 'renewal_evidence_url'
            AND v_item ?& ARRAY['id', 'status', 'rent_amount', 'duration_days', 'daily_repayment', 'total_repayment', 'tenant_name', 'agent_name', 'landlord_name'],
        'detail', jsonb_build_object('status_before', v_status, 'item_keys', (SELECT jsonb_agg(k) FROM jsonb_object_keys(COALESCE(v_item, '{}')) k)));
      v_found := true;
      RAISE EXCEPTION 'CASE_DONE';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'CASE_DONE' THEN v_why := left(SQLERRM, 200); END IF;   -- a candidate the status guard will not move is skipped; the next one is tried
    END;
  END LOOP;
  IF NOT v_found THEN r := r || jsonb_build_object('step', 'D a Service Center fixture was found', 'pass', false, 'detail', v_why); END IF;
  RAISE EXCEPTION 'ROLLED BACK REPORT (block 4): % passed of % | failing: %', (SELECT count(*) FROM jsonb_array_elements(r) e WHERE (e->>'pass') = 'true'), jsonb_array_length(r),
    COALESCE((SELECT string_agg(e->>'step' || ' ' || COALESCE((e->'detail')::text, ''), '; ') FROM jsonb_array_elements(r) e WHERE (e->>'pass') = 'false'), 'none');
END
$test$;
