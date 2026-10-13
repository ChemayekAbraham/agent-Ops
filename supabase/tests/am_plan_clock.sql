-- Rolled-back verification for 20261012100000_am_plan_clock_and_arrears.sql
--
-- Run against the live database. Everything happens in one transaction that ends in
-- RAISE EXCEPTION, so nothing is kept (the fixture payouts it inserts are rolled back).
-- The error text IS the report: a JSON list of steps, each with "pass": true/false.
-- Every step must pass; "report" steps print the live bucket counts.
--
-- Cases: single payout, split payout (start = day after the LAST payout), failed / pending /
-- disbursing payout ignored, outstanding_balance kept, tenant paying without a landlord
-- payout, awaiting landlord, daily plan arrears, weekly plan arrears, no clock => zero,
-- ahead of schedule, access refused without a role, input cap.
DO $test$
DECLARE
  r jsonb := '[]'::jsonb;
  v_staff uuid;
  v_plain uuid;
  v_daily record;   -- active daily plan, no payouts, no payments
  v_weekly record;  -- active weekly plan, no payouts, no payments
  v_ob record;      -- outstanding_balance plan
  v_tp record;      -- tenant paying, no landlord payout
  v_aw record;      -- awaiting landlord
  c record;
  a record;
  v_ids uuid[];
  v_phone text;
  v_ok boolean;
  v_msg text;
  v_start date;
  v_asat date;
  v_expected numeric;
BEGIN
  -- Fixture payouts hit landlord_payouts triggers (e.g. the Platform Controls float pause).
  -- This setting is transaction-local and reverts with the rollback; no trigger is disabled.
  SET LOCAL session_replication_role = replica;
  SELECT user_id INTO v_staff FROM public.user_roles WHERE role = 'tenant_ops' LIMIT 1;
  SELECT p.id INTO v_plain FROM public.profiles p
   WHERE NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = p.id) LIMIT 1;

  -- Fixtures: plans that nothing has happened to yet (no payouts, no payments).
  SELECT rr.id, rr.agent_id, rr.landlord_id, rr.tenant_id, rr.duration_days, rr.daily_repayment, rr.total_repayment,
         rr.repayment_starts_on INTO v_daily
    FROM public.rent_requests rr
   WHERE rr.status IN ('funded','repaying') AND rr.registration_type <> 'outstanding_balance'
     AND COALESCE(rr.repayment_frequency,'daily') = 'daily' AND rr.agent_id IS NOT NULL AND rr.landlord_id IS NOT NULL
     AND COALESCE(rr.amount_repaid,0) = 0 AND rr.daily_repayment > 0 AND rr.total_repayment > rr.daily_repayment * 10
     AND NOT EXISTS (SELECT 1 FROM public.landlord_payouts lp WHERE lp.rent_request_id = rr.id)
     AND NOT EXISTS (SELECT 1 FROM public.agent_collections ac WHERE ac.rent_request_id = rr.id)
     AND NOT EXISTS (SELECT 1 FROM public.repayments x WHERE x.rent_request_id = rr.id)
   ORDER BY rr.created_at DESC LIMIT 1;

  -- A weekly plan: its existing payouts are removed inside this rolled-back transaction so
  -- only the fixture payout below defines the clock.
  SELECT rr.id, rr.agent_id, rr.landlord_id, rr.tenant_id, rr.duration_days, rr.daily_repayment, rr.total_repayment,
         rr.repayment_starts_on INTO v_weekly
    FROM public.rent_requests rr
   WHERE rr.repayment_frequency = 'weekly' AND rr.registration_type <> 'outstanding_balance'
     AND rr.agent_id IS NOT NULL AND rr.landlord_id IS NOT NULL
     AND rr.daily_repayment > 0 AND rr.total_repayment > rr.daily_repayment * 21
   ORDER BY rr.created_at DESC LIMIT 1;

  SELECT rr.id, rr.repayment_starts_on INTO v_ob
    FROM public.rent_requests rr
   WHERE rr.registration_type = 'outstanding_balance' AND rr.status IN ('funded','repaying','disbursed')
     AND rr.repayment_starts_on IS NOT NULL LIMIT 1;

  SELECT rr.id INTO v_tp
    FROM public.rent_requests rr
   WHERE rr.status IN ('funded','repaying','disbursed') AND rr.registration_type <> 'outstanding_balance'
     AND NOT EXISTS (SELECT 1 FROM public.landlord_payouts lp WHERE lp.rent_request_id = rr.id AND lp.status IN ('awaiting_agent_receipt','completed'))
     AND (COALESCE(rr.amount_repaid,0) > 0 OR EXISTS (SELECT 1 FROM public.agent_collections ac WHERE ac.rent_request_id = rr.id AND ac.reversed_at IS NULL))
   LIMIT 1;

  SELECT rr.id INTO v_aw
    FROM public.rent_requests rr
   WHERE rr.status IN ('funded','repaying','disbursed') AND rr.registration_type <> 'outstanding_balance'
     AND COALESCE(rr.amount_repaid,0) = 0
     AND NOT EXISTS (SELECT 1 FROM public.landlord_payouts lp WHERE lp.rent_request_id = rr.id AND lp.status IN ('awaiting_agent_receipt','completed'))
     AND NOT EXISTS (SELECT 1 FROM public.agent_collections ac WHERE ac.rent_request_id = rr.id AND ac.reversed_at IS NULL)
   LIMIT 1;

  r := r || jsonb_build_object('step', 'setup', 'pass',
        v_staff IS NOT NULL AND v_daily.id IS NOT NULL AND v_weekly.id IS NOT NULL AND v_ob.id IS NOT NULL
        AND v_tp.id IS NOT NULL AND v_aw.id IS NOT NULL,
        'detail', jsonb_build_object('staff', v_staff IS NOT NULL, 'daily', v_daily.id, 'weekly', v_weekly.id,
                                     'outstanding_balance', v_ob.id, 'tenant_paying', v_tp.id, 'awaiting', v_aw.id));

  -- ── Access ─────────────────────────────────────────────────────────────
  BEGIN
    PERFORM set_config('request.jwt.claims', '', true);
    v_ok := false;
    BEGIN PERFORM * FROM public.am_plan_clock(ARRAY[v_daily.id]); EXCEPTION WHEN OTHERS THEN v_ok := SQLSTATE = '42501'; END;
    r := r || jsonb_build_object('step', 'A1 signed-out call refused (clock)', 'pass', v_ok);
    v_ok := false;
    BEGIN PERFORM * FROM public.am_plan_arrears(ARRAY[v_daily.id], current_date); EXCEPTION WHEN OTHERS THEN v_ok := SQLSTATE = '42501'; END;
    r := r || jsonb_build_object('step', 'A2 signed-out call refused (arrears)', 'pass', v_ok);
    IF v_plain IS NOT NULL THEN
      PERFORM set_config('request.jwt.claims', json_build_object('sub', v_plain, 'role', 'authenticated')::text, true);
      v_ok := false;
      BEGIN PERFORM * FROM public.am_plan_clock(ARRAY[v_daily.id]); EXCEPTION WHEN OTHERS THEN v_ok := SQLSTATE = '42501'; END;
      r := r || jsonb_build_object('step', 'A3 user without a role refused', 'pass', v_ok);
    END IF;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_staff, 'role', 'authenticated')::text, true);
    v_ok := false;
    BEGIN PERFORM * FROM public.am_plan_clock(ARRAY(SELECT gen_random_uuid() FROM generate_series(1, 10001))); EXCEPTION WHEN OTHERS THEN v_ok := SQLSTATE = '22023'; END;
    r := r || jsonb_build_object('step', 'A4 more than 10000 plans refused', 'pass', v_ok);
    r := r || jsonb_build_object('step', 'A5 empty / null list returns nothing', 'pass',
          NOT EXISTS (SELECT 1 FROM public.am_plan_clock(NULL)) AND NOT EXISTS (SELECT 1 FROM public.am_plan_arrears('{}', current_date)));
    RAISE EXCEPTION 'case_done';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'case_done' THEN r := r || jsonb_build_object('step', 'A block', 'pass', false, 'detail', SQLERRM); END IF;
  END;

  -- ── Buckets that need no fixture ───────────────────────────────────────
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_staff, 'role', 'authenticated')::text, true);
    SELECT * INTO c FROM public.am_plan_clock(ARRAY[v_ob.id]);
    r := r || jsonb_build_object('step', 'B1 outstanding_balance keeps repayment_starts_on',
          'pass', c.bucket = 'outstanding_balance' AND c.clock_start = v_ob.repayment_starts_on AND c.shift_days = 0, 'detail', to_jsonb(c));
    SELECT * INTO c FROM public.am_plan_clock(ARRAY[v_tp.id]);
    r := r || jsonb_build_object('step', 'B2 tenant paying, no landlord payout: no clock',
          'pass', c.bucket = 'tenant_paying_no_landlord' AND c.clock_start IS NULL AND c.clock_end IS NULL AND c.landlord_paid_count = 0, 'detail', to_jsonb(c));
    SELECT * INTO c FROM public.am_plan_clock(ARRAY[v_aw.id]);
    r := r || jsonb_build_object('step', 'B3 awaiting landlord: no clock',
          'pass', c.bucket = 'awaiting_landlord' AND c.clock_start IS NULL AND c.shift_days IS NULL, 'detail', to_jsonb(c));
    SELECT * INTO a FROM public.am_plan_arrears(ARRAY[v_aw.id], current_date);
    r := r || jsonb_build_object('step', 'B4 no clock => zero expected, zero arrears',
          'pass', a.expected_to_date = 0 AND a.arrears = 0 AND a.days_behind = 0 AND a.days_ahead = 0, 'detail', to_jsonb(a));
    -- a duplicated id returns one row
    r := r || jsonb_build_object('step', 'B5 repeated id gives one row',
          'pass', (SELECT count(*) FROM public.am_plan_clock(ARRAY[v_aw.id, v_aw.id, v_tp.id])) = 2);
    RAISE EXCEPTION 'case_done';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'case_done' THEN r := r || jsonb_build_object('step', 'B block', 'pass', false, 'detail', SQLERRM); END IF;
  END;

  -- ── Daily plan: single payout, split payout, ignored statuses, arrears ──
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_staff, 'role', 'authenticated')::text, true);
    SELECT phone INTO v_phone FROM public.landlords WHERE id = v_daily.landlord_id;

    -- failed / pending / disbursing payouts are ignored
    INSERT INTO public.landlord_payouts (agent_id, landlord_id, rent_request_id, amount, landlord_phone, landlord_name, mobile_money_provider, status, finops_disbursed_at)
    VALUES (v_daily.agent_id, v_daily.landlord_id, v_daily.id, 100000, v_phone, 'T', 'MTN', 'failed',               '2026-09-20 10:00+03'),
           (v_daily.agent_id, v_daily.landlord_id, v_daily.id, 100000, v_phone, 'T', 'MTN', 'pending_merchant_payout', '2026-09-21 10:00+03'),
           (v_daily.agent_id, v_daily.landlord_id, v_daily.id, 100000, v_phone, 'T', 'MTN', 'disbursing',            '2026-09-22 10:00+03');
    SELECT * INTO c FROM public.am_plan_clock(ARRAY[v_daily.id]);
    r := r || jsonb_build_object('step', 'C1 failed, pending and disbursing payouts are ignored',
          'pass', c.landlord_paid_count = 0 AND c.clock_start IS NULL AND c.bucket = 'awaiting_landlord', 'detail', to_jsonb(c));

    -- single payout, paid late evening Kampala time (still that Kampala day)
    INSERT INTO public.landlord_payouts (agent_id, landlord_id, rent_request_id, amount, landlord_phone, landlord_name, mobile_money_provider, status, finops_disbursed_at)
    VALUES (v_daily.agent_id, v_daily.landlord_id, v_daily.id, 400000, v_phone, 'T', 'MTN', 'completed', '2026-09-01 23:30+03');
    SELECT * INTO c FROM public.am_plan_clock(ARRAY[v_daily.id]);
    r := r || jsonb_build_object('step', 'C2 single payout: start = day after it, end = start + duration - 1',
          'pass', c.bucket = 'counting' AND c.landlord_paid_count = 1 AND c.landlord_paid_total = 400000
                  AND c.first_landlord_paid_on = DATE '2026-09-01' AND c.last_landlord_paid_on = DATE '2026-09-01'
                  AND c.clock_start = DATE '2026-09-02' AND c.clock_end = DATE '2026-09-02' + v_daily.duration_days - 1
                  AND c.shift_days = DATE '2026-09-02' - v_daily.repayment_starts_on, 'detail', to_jsonb(c));

    -- split payout: the clock starts after the LAST one; the earlier one comes from disbursed_at
    INSERT INTO public.landlord_payouts (agent_id, landlord_id, rent_request_id, amount, landlord_phone, landlord_name, mobile_money_provider, status, disbursed_at)
    VALUES (v_daily.agent_id, v_daily.landlord_id, v_daily.id, 250000, v_phone, 'T', 'MTN', 'awaiting_agent_receipt', '2026-09-05 09:00+03');
    SELECT * INTO c FROM public.am_plan_clock(ARRAY[v_daily.id]);
    r := r || jsonb_build_object('step', 'C3 split payout: start = day after the LAST payout',
          'pass', c.landlord_paid_count = 2 AND c.landlord_paid_total = 650000
                  AND c.first_landlord_paid_on = DATE '2026-09-01' AND c.last_landlord_paid_on = DATE '2026-09-05'
                  AND c.clock_start = DATE '2026-09-06', 'detail', to_jsonb(c));

    -- daily arrears with nothing paid: day 1 of the clock is 1 instalment due
    SELECT * INTO a FROM public.am_plan_arrears(ARRAY[v_daily.id], DATE '2026-09-05');
    r := r || jsonb_build_object('step', 'D1 as-at before the clock starts: nothing expected',
          'pass', a.expected_to_date = 0 AND a.arrears = 0 AND a.cadence = 'daily', 'detail', to_jsonb(a));
    SELECT * INTO a FROM public.am_plan_arrears(ARRAY[v_daily.id], DATE '2026-09-06');
    r := r || jsonb_build_object('step', 'D2 first clock day: one instalment, none behind yet',
          'pass', a.expected_to_date = least(v_daily.total_repayment, v_daily.daily_repayment)
                  AND a.arrears = a.expected_to_date AND a.days_behind = 0, 'detail', to_jsonb(a));
    SELECT * INTO a FROM public.am_plan_arrears(ARRAY[v_daily.id], DATE '2026-09-10');
    r := r || jsonb_build_object('step', 'D3 five days in, nothing paid: 5 instalments, 4 days behind',
          'pass', a.expected_to_date = least(v_daily.total_repayment, 5 * v_daily.daily_repayment)
                  AND a.arrears = a.expected_to_date AND a.paid_to_date = 0 AND a.days_behind = 4 AND a.days_ahead = 0, 'detail', to_jsonb(a));
    -- capped at the plan total
    SELECT * INTO a FROM public.am_plan_arrears(ARRAY[v_daily.id], DATE '2030-01-01');
    r := r || jsonb_build_object('step', 'D4 far in the future: capped at total_repayment',
          'pass', a.expected_to_date = v_daily.total_repayment, 'detail', to_jsonb(a));
    RAISE EXCEPTION 'case_done';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'case_done' THEN r := r || jsonb_build_object('step', 'C/D block', 'pass', false, 'detail', SQLERRM); END IF;
  END;

  -- ── Weekly plan: instalment = daily x 7, due on the week boundary ──────
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_staff, 'role', 'authenticated')::text, true);
    SELECT phone INTO v_phone FROM public.landlords WHERE id = v_weekly.landlord_id;
    DELETE FROM public.landlord_payouts WHERE rent_request_id = v_weekly.id;
    INSERT INTO public.landlord_payouts (agent_id, landlord_id, rent_request_id, amount, landlord_phone, landlord_name, mobile_money_provider, status, finops_disbursed_at)
    VALUES (v_weekly.agent_id, v_weekly.landlord_id, v_weekly.id, 400000, v_phone, 'T', 'MTN', 'completed', '2026-09-01 10:00+03');
    -- clock starts 2026-09-02
    SELECT * INTO a FROM public.am_plan_arrears(ARRAY[v_weekly.id], DATE '2026-09-02');
    r := r || jsonb_build_object('step', 'E1 weekly, first clock day: one weekly instalment (daily x 7)',
          'pass', a.cadence = 'weekly' AND a.unit = 'week' AND a.expected_to_date = least(v_weekly.total_repayment, 7 * v_weekly.daily_repayment), 'detail', to_jsonb(a));
    SELECT * INTO a FROM public.am_plan_arrears(ARRAY[v_weekly.id], DATE '2026-09-08');
    r := r || jsonb_build_object('step', 'E2 weekly, day 7 of the first week: still one instalment',
          'pass', a.expected_to_date = least(v_weekly.total_repayment, 7 * v_weekly.daily_repayment), 'detail', to_jsonb(a));
    SELECT * INTO a FROM public.am_plan_arrears(ARRAY[v_weekly.id], DATE '2026-09-16');
    r := r || jsonb_build_object('step', 'E3 weekly, 15 days in (start + 14): three instalments, 2 weeks (14 days) behind',
          'pass', a.expected_to_date = least(v_weekly.total_repayment, 21 * v_weekly.daily_repayment)
                  AND a.periods_behind = greatest(0, ceil(a.arrears / (7 * v_weekly.daily_repayment))::int - 1)
                  AND a.days_behind = 7 * a.periods_behind
                  AND a.arrears = greatest(0, a.expected_to_date - a.paid_to_date), 'detail', to_jsonb(a));
    RAISE EXCEPTION 'case_done';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'case_done' THEN r := r || jsonb_build_object('step', 'E block', 'pass', false, 'detail', SQLERRM); END IF;
  END;

  -- ── Ahead of schedule, duplicate repayment counted once, reversed collection ignored ──
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_staff, 'role', 'authenticated')::text, true);
    SELECT phone INTO v_phone FROM public.landlords WHERE id = v_daily.landlord_id;
    INSERT INTO public.landlord_payouts (agent_id, landlord_id, rent_request_id, amount, landlord_phone, landlord_name, mobile_money_provider, status, finops_disbursed_at)
    VALUES (v_daily.agent_id, v_daily.landlord_id, v_daily.id, 400000, v_phone, 'T', 'MTN', 'completed', '2026-09-05 10:00+03');
    -- clock starts 2026-09-06. A tenant self-payment of 7 instalments on 09-07 ...
    INSERT INTO public.repayments (tenant_id, rent_request_id, amount, created_at, payment_method)
    VALUES (v_daily.tenant_id, v_daily.id, 7 * v_daily.daily_repayment, '2026-09-07 10:00+03', 'test');
    -- ... a collection of 1 instalment on 09-07 and its mirror repayment 2 minutes later (same money) ...
    INSERT INTO public.agent_collections (agent_id, tenant_id, rent_request_id, amount, created_at, payment_method)
    VALUES (v_daily.agent_id, v_daily.tenant_id, v_daily.id, v_daily.daily_repayment, '2026-09-07 11:00+03', 'cash');
    INSERT INTO public.repayments (tenant_id, rent_request_id, amount, created_at, payment_method)
    VALUES (v_daily.tenant_id, v_daily.id, v_daily.daily_repayment, '2026-09-07 11:02+03', 'test');
    -- ... and a reversed collection that must not count.
    INSERT INTO public.agent_collections (agent_id, tenant_id, rent_request_id, amount, created_at, reversed_at, payment_method)
    VALUES (v_daily.agent_id, v_daily.tenant_id, v_daily.id, 5 * v_daily.daily_repayment, '2026-09-07 12:00+03', '2026-09-07 13:00+03', 'cash');
    SELECT * INTO a FROM public.am_plan_arrears(ARRAY[v_daily.id], DATE '2026-09-08');
    r := r || jsonb_build_object('step', 'G1 paid = 7 + 1 instalments (duplicate counted once, reversed ignored); 3 due => 5 days ahead',
          'pass', a.paid_to_date = 8 * v_daily.daily_repayment AND a.expected_to_date = 3 * v_daily.daily_repayment
                  AND a.arrears = 0 AND a.days_ahead = 5 AND a.days_behind = 0, 'detail', to_jsonb(a));
    -- payments after the as-at day do not count
    SELECT * INTO a FROM public.am_plan_arrears(ARRAY[v_daily.id], DATE '2026-09-06');
    r := r || jsonb_build_object('step', 'G2 as-at before the payments: they are not counted yet',
          'pass', a.paid_to_date = 0 AND a.arrears = a.expected_to_date, 'detail', to_jsonb(a));
    RAISE EXCEPTION 'case_done';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'case_done' THEN r := r || jsonb_build_object('step', 'G block', 'pass', false, 'detail', SQLERRM); END IF;
  END;

  -- ── Paid amounts: collections + non-duplicate repayments, reversed ones ignored ──
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_staff, 'role', 'authenticated')::text, true);
    -- Independent recomputation for every active plan that has payments: the function must
    -- equal non-reversed collections + repayments that do not mirror a collection.
    v_asat := current_date;
    SELECT array_agg(id) INTO v_ids FROM public.rent_requests WHERE status IN ('funded','disbursed','repaying');
    r := r || jsonb_build_object('step', 'F1 paid_to_date equals an independent sum for every active plan',
          'pass', NOT EXISTS (
            SELECT 1
              FROM public.am_plan_arrears(v_ids, v_asat) x
              LEFT JOIN LATERAL (
                SELECT COALESCE(sum(ac.amount), 0) AS s FROM public.agent_collections ac
                 WHERE ac.rent_request_id = x.rent_request_id AND ac.reversed_at IS NULL
                   AND (ac.created_at AT TIME ZONE 'Africa/Kampala')::date <= v_asat) col ON true
              LEFT JOIN LATERAL (
                SELECT COALESCE(sum(rp.amount), 0) AS s FROM public.repayments rp
                 WHERE rp.rent_request_id = x.rent_request_id
                   AND (rp.created_at AT TIME ZONE 'Africa/Kampala')::date <= v_asat
                   AND NOT EXISTS (SELECT 1 FROM public.agent_collections ac2
                                    WHERE ac2.rent_request_id = rp.rent_request_id AND ac2.reversed_at IS NULL
                                      AND ac2.amount = rp.amount
                                      AND abs(extract(epoch FROM (ac2.created_at - rp.created_at))) < 300)) rep ON true
             WHERE x.paid_to_date <> col.s + rep.s),
          'detail', jsonb_build_object('plans_checked', cardinality(v_ids)));
    -- identity checks on every active plan
    r := r || jsonb_build_object('step', 'F2 arrears = max(0, expected - paid) and never both behind and ahead',
          'pass', NOT EXISTS (
            SELECT 1 FROM public.am_plan_arrears(v_ids, v_asat) x
             WHERE x.arrears <> greatest(0, x.expected_to_date - x.paid_to_date) * (CASE WHEN x.clock_start IS NULL THEN 0 ELSE 1 END)
                OR (x.arrears > 0 AND x.days_ahead > 0)
                OR x.days_behind < 0 OR x.days_ahead < 0));
    RAISE EXCEPTION 'case_done';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'case_done' THEN r := r || jsonb_build_object('step', 'F block', 'pass', false, 'detail', SQLERRM); END IF;
  END;

  -- ── Report: live counts per bucket ─────────────────────────────────────
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_staff, 'role', 'authenticated')::text, true);
    SELECT array_agg(id) INTO v_ids FROM public.rent_requests WHERE status IN ('funded','disbursed','repaying');
    r := r || jsonb_build_object('step', 'R live buckets, active plans', 'pass', NULL,
          'detail', jsonb_build_object(
            'buckets', (SELECT jsonb_object_agg(bucket, n) FROM (SELECT bucket, count(*) n FROM public.am_plan_clock(v_ids) GROUP BY 1) q),
            'shift_days_gt_0', (SELECT count(*) FROM public.am_plan_clock(v_ids) WHERE shift_days > 0),
            'shift_days_lt_0', (SELECT count(*) FROM public.am_plan_clock(v_ids) WHERE shift_days < 0),
            'payout_dates_estimated', (SELECT count(*) FROM public.am_plan_clock(v_ids) WHERE landlord_paid_dates_estimated > 0)));
    RAISE EXCEPTION 'case_done';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'case_done' THEN r := r || jsonb_build_object('step', 'R block', 'pass', false, 'detail', SQLERRM); END IF;
  END;

  RAISE EXCEPTION 'ROLLED BACK REPORT: %', jsonb_pretty(r);
END
$test$;
