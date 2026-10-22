-- Read-only verification for 20261021235500_landlord_float_thursday_week.sql (run AFTER the migration). It only SELECTs and can run inside
-- BEGIN TRANSACTION READ ONLY. The block ends in RAISE EXCEPTION; the error text IS the report: a JSON list of 6 steps,
-- each with "pass": true/false.
--   1  landlord_float_week_start maps every day to the Thursday on or before it (Thu -> itself, Wed -> the Thursday
--      six days earlier), e.g. Mon 19 Oct 2026 -> Thu 15 Oct, Wed 21 Oct -> Thu 15 Oct, Thu 22 Oct -> Thu 22 Oct
--   2  every weekly float starts on a Thursday and ends on the Wednesday six days later
--   3  every allocation's week is the Thursday week of its approval date and is its weekly float's week
--   4  the CFO float position for today reports a Thursday–Wednesday week
--   5  the table rules and the set-float message are the Thursday ones
--   6  if the payables reporting (20261021235100) is present: every float line is due on a Wednesday, and payouts made
--      without a weekly float are grouped by Thursday weeks
DO $test$
DECLARE
  r jsonb := '[]'::jsonb;
  v_pos jsonb;
BEGIN
  -- 1
  r := r || jsonb_build_object('step', 1, 'pass',
        NOT EXISTS (SELECT 1 FROM generate_series(DATE '2026-01-01', DATE '2027-12-31', interval '1 day') g(d)
                     WHERE extract(isodow FROM public.landlord_float_week_start(g.d::date)) <> 4
                        OR g.d::date - public.landlord_float_week_start(g.d::date) NOT BETWEEN 0 AND 6)
    AND public.landlord_float_week_start(DATE '2026-10-19') = DATE '2026-10-15'
    AND public.landlord_float_week_start(DATE '2026-10-21') = DATE '2026-10-15'
    AND public.landlord_float_week_start(DATE '2026-10-22') = DATE '2026-10-22');

  -- 2
  r := r || jsonb_build_object('step', 2, 'pass', NOT EXISTS (
        SELECT 1 FROM public.landlord_float_budgets
         WHERE period_type = 'weekly' AND (extract(isodow FROM period_start) <> 4 OR extract(isodow FROM period_end) <> 3
                                           OR period_end <> period_start + 6)),
    'weekly_floats', (SELECT jsonb_agg(jsonb_build_object('start', period_start, 'end', period_end, 'amount', amount,
                                       'current', superseded_at IS NULL) ORDER BY period_start)
                        FROM public.landlord_float_budgets WHERE period_type = 'weekly'));

  -- 3
  r := r || jsonb_build_object('step', 3, 'pass',
        NOT EXISTS (SELECT 1 FROM public.landlord_float_budget_allocations WHERE week_start <> public.landlord_float_week_start(budget_date))
    AND NOT EXISTS (SELECT 1 FROM public.landlord_float_budget_allocations a JOIN public.landlord_float_budgets b ON b.id = a.weekly_budget_id
                     WHERE a.week_start <> b.period_start OR a.budget_date NOT BETWEEN b.period_start AND b.period_end),
    'allocations', (SELECT count(*) FROM public.landlord_float_budget_allocations));

  -- 4
  v_pos := public._landlord_float_position((now() AT TIME ZONE 'Africa/Kampala')::date);
  r := r || jsonb_build_object('step', 4, 'pass',
        extract(isodow FROM (v_pos->>'week_start')::date) = 4 AND extract(isodow FROM (v_pos->>'week_end')::date) = 3,
    'week_start', v_pos->'week_start', 'week_end', v_pos->'week_end');

  -- 5
  r := r || jsonb_build_object('step', 5, 'pass',
        (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.landlord_float_budgets'::regclass
          AND conname = 'landlord_float_budgets_period_shape') LIKE '%= (4)::numeric%'
    AND (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.landlord_float_budget_allocations'::regclass
          AND conname = 'landlord_float_alloc_week') LIKE '%landlord_float_week_start(budget_date)%'
    AND (SELECT prosrc FROM pg_proc WHERE oid = 'public.cfo_set_landlord_float_budget(text,numeric,text,date)'::regprocedure)
          LIKE '%starts on a Thursday%');

  -- 6
  IF to_regclass('public.v_landlord_float_payables') IS NULL THEN
    r := r || jsonb_build_object('step', 6, 'pass', true, 'note', 'payables reporting not applied');
  ELSE
    EXECUTE $q$SELECT jsonb_build_object('step', 6, 'pass',
          NOT EXISTS (SELECT 1 FROM public.v_landlord_float_payables WHERE extract(isodow FROM week_end) <> 3 OR extract(isodow FROM week_start) <> 4)
      AND NOT EXISTS (SELECT 1 FROM public.v_payables_lines WHERE category_key = 'landlord' AND extract(isodow FROM due_date) <> 3)
      AND NOT EXISTS (SELECT 1 FROM public.v_landlord_payout_settlement WHERE extract(isodow FROM report_week_start) <> 4),
      'float_lines', (SELECT jsonb_agg(jsonb_build_object('label', counterparty_name, 'due', due_date, 'amount', outstanding_amount))
                        FROM public.v_payables_lines WHERE category_key = 'landlord'))$q$ INTO v_pos;
    r := r || v_pos;
  END IF;

  RAISE EXCEPTION 'landlord_float_thursday_week verification (rolled back): %', r;
END
$test$;
