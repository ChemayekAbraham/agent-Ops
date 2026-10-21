-- 2026-10-21: landlord float weeks run THURSDAY to WEDNESDAY (CFO accounting rule: the weekly landlord float period
-- ends every Wednesday). Replaces the Monday–Sunday week of 20261016160000_landlord_float_budget_cap.
--
-- WHAT CHANGES
--   * landlord_float_week_start(d) returns the Thursday on or before d (was: the Monday). Every float function derives
--     its week from it and "start + 6": the CFO float position, setting a float, COO approvals, CFO miscellaneous
--     decisions, the allocations and history lists, and the payables reporting (Part 3). None of them is redefined.
--   * A weekly float must start on a Thursday and end on the Wednesday six days later (table rule).
--   * cfo_set_landlord_float_budget: only its error message changes (Monday -> Thursday); otherwise production's text.
--   * EXISTING DATA, re-keyed (CFO decision 2026-10-21: the current float is the week ENDING WEDNESDAY 21 OCT 2026):
--     each weekly float moves to the Thursday–Wednesday week that contains its Monday start, i.e. Mon M..Sun M+6
--     becomes Thu M-4..Wed M+2 (19–25 Oct 2026 -> 15–21 Oct 2026). Each allocation's week_start becomes the Thursday of
--     its own approval date. The migration REFUSES unless every allocation then still belongs to its float (approval on
--     the Monday–Wednesday of that float's old week); production on 2026-10-21: all 33 approvals on Tue 20 Oct.
--     Every re-keyed float is recorded in audit_logs (old and new dates). Amounts, approvals and links are unchanged.
--   * Daily floats are unchanged.
--
-- DEPLOYMENT GATE: the migration locks both float tables and then REFUSES (changing nothing) if any landlord float
-- approval exists from Thursday 22 October 2026 onward, checked on the live rows at migration time. Apply it before the
-- first approval on Thursday 22 October 2026 (Kampala), or keep approvals paused until it is applied.
--
-- NOT CHANGED: no ledger entry, wallet, payout, withdrawal, rent request, amount or approval. No trigger exists on the
-- two float tables. The screens show the week dates the server returns; no client-side week arithmetic exists.
-- OPERATIONAL NOTE: from the first Thursday after this is applied, COO approvals need a weekly float for the new
-- Thursday week (NO_BUDGET until the CFO sets one), exactly as at the start of every week today.
-- Rollback: supabase/rollbacks/20261021200000_landlord_float_thursday_week.rollback.sql
-- Verification (read-only): supabase/tests/landlord_float_thursday_week.sql

SET lock_timeout = '5s';
-- Freeze both float tables for this transaction (in a fixed order, before any check), so no approval or float can be
-- written between the checks below and the re-key. Approvals arriving meanwhile wait, then see the new rules.
LOCK TABLE public.landlord_float_budgets, public.landlord_float_budget_allocations IN ACCESS EXCLUSIVE MODE;
DO $pre$
DECLARE
  v_n bigint;
BEGIN
  -- DEPLOYMENT GATE (CFO, 2026-10-21), evaluated on the LIVE rows under the locks above: refuse if any landlord float
  -- approval exists from Thursday 22 October 2026 onward. Such an approval was charged under the Monday–Sunday rules to
  -- a week the Thursday–Wednesday rule ends on Wednesday 21 October. Every COO and CFO approval writes an allocation
  -- (trg_landlord_float_guard_coo_step blocks any other path), so the allocations are the complete list. Nothing has
  -- been changed when this refuses; the whole migration rolls back.
  SELECT count(*) INTO v_n FROM public.landlord_float_budget_allocations
   WHERE budget_date >= DATE '2026-10-22' OR approved_at >= TIMESTAMPTZ '2026-10-22 00:00:00+03';
  IF v_n > 0 THEN
    RAISE EXCEPTION 'deployment gate: % landlord float approval(s) exist from Thursday 22 October 2026 onward, made under the Monday–Sunday rules; nothing was changed. Decide how to re-key them, then re-key by hand or regenerate this migration', v_n;
  END IF;

  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.landlord_float_week_start(date)'::regprocedure) <> '1c696acb11253c892274b127f3e09b16'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.cfo_set_landlord_float_budget(text,numeric,text,date)'::regprocedure) <> '8e014ba3b7546730a56cd39c08b5f7f0'
     OR (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.landlord_float_budgets'::regclass
          AND conname = 'landlord_float_budgets_period_shape') IS DISTINCT FROM 'CHECK ((((period_type = ''daily''::text) AND (period_end = period_start)) OR ((period_type = ''weekly''::text) AND (period_end = (period_start + 6)) AND (EXTRACT(isodow FROM period_start) = (1)::numeric))))'
     OR (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.landlord_float_budget_allocations'::regclass
          AND conname = 'landlord_float_alloc_week') IS DISTINCT FROM 'CHECK ((week_start = landlord_float_week_start(budget_date)))' THEN
    RAISE EXCEPTION 'precondition failed: the landlord float week definitions are not the Monday–Sunday ones this migration replaces';
  END IF;
  IF EXISTS (SELECT 1 FROM public.landlord_float_budgets WHERE period_type = 'weekly' AND extract(isodow FROM period_start) <> 1) THEN
    RAISE EXCEPTION 'precondition failed: a weekly landlord float does not start on a Monday';
  END IF;
  -- every allocation must stay with its weekly float after the re-key
  IF EXISTS (SELECT 1 FROM public.landlord_float_budget_allocations a
               JOIN public.landlord_float_budgets b ON b.id = a.weekly_budget_id
              WHERE (a.budget_date - ((extract(isodow FROM a.budget_date)::int + 3) % 7)) <> b.period_start - 4) THEN
    RAISE EXCEPTION 'precondition failed: an allocation was approved Thursday–Sunday of its float week and would leave its float; re-key by hand';
  END IF;
END
$pre$;

-- 1. Lift the Monday rules while the rows move.
ALTER TABLE public.landlord_float_budgets DROP CONSTRAINT landlord_float_budgets_period_shape;
ALTER TABLE public.landlord_float_budget_allocations DROP CONSTRAINT landlord_float_alloc_week;

-- 2. The week: Thursday to Wednesday.
CREATE OR REPLACE FUNCTION public.landlord_float_week_start(p_day date)
 RETURNS date
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$ SELECT p_day - ((extract(isodow FROM p_day)::int + 3) % 7) $function$;
COMMENT ON FUNCTION public.landlord_float_week_start(date) IS 'Landlord float week start: the Thursday on or before the day (weeks run Thursday to Wednesday, CFO rule 2026-10-21).';

-- 3. Re-key the weekly floats (Mon M..Sun M+6 -> Thu M-4..Wed M+2) with an audit row each, then the allocations.
WITH moved AS (
  UPDATE public.landlord_float_budgets
     SET period_start = period_start - 4, period_end = period_start + 2
   WHERE period_type = 'weekly'
  RETURNING id, period_start, period_end, amount, superseded_at
)
INSERT INTO public.audit_logs (action_type, table_name, record_id, reason, old_values, new_values, metadata)
SELECT 'landlord_float_week_rekey', 'landlord_float_budgets', m.id::text,
       'Landlord float weeks run Thursday to Wednesday (CFO rule 2026-10-21); migration 20261021200000_landlord_float_thursday_week',
       jsonb_build_object('period_start', m.period_start + 4, 'period_end', m.period_start + 10),
       jsonb_build_object('period_start', m.period_start, 'period_end', m.period_end),
       jsonb_build_object('amount', m.amount, 'superseded', m.superseded_at IS NOT NULL, 'migration', '20261021200000_landlord_float_thursday_week')
  FROM moved m;

WITH moved AS (
  UPDATE public.landlord_float_budget_allocations
     SET week_start = public.landlord_float_week_start(budget_date)
   WHERE week_start IS DISTINCT FROM public.landlord_float_week_start(budget_date)
  RETURNING id
)
INSERT INTO public.audit_logs (action_type, table_name, reason, metadata)
SELECT 'landlord_float_week_rekey', 'landlord_float_budget_allocations',
       'Allocation weeks re-keyed to Thursday–Wednesday; migration 20261021200000_landlord_float_thursday_week',
       jsonb_build_object('allocations', count(*), 'migration', '20261021200000_landlord_float_thursday_week')
  FROM moved HAVING count(*) > 0;

-- 4. The rules again, Thursday-based (both are validated against every row).
ALTER TABLE public.landlord_float_budgets ADD CONSTRAINT landlord_float_budgets_period_shape
  CHECK (((period_type = 'daily'::text) AND (period_end = period_start)) OR ((period_type = 'weekly'::text) AND (period_end = (period_start + 6)) AND (EXTRACT(isodow FROM period_start) = (4)::numeric)));
ALTER TABLE public.landlord_float_budget_allocations ADD CONSTRAINT landlord_float_alloc_week
  CHECK (week_start = public.landlord_float_week_start(budget_date));

-- 5. Setting a float: the message names Thursday. Otherwise production's definition; CREATE OR REPLACE keeps grants.
CREATE OR REPLACE FUNCTION public.cfo_set_landlord_float_budget(p_period_type text, p_amount numeric, p_reason text DEFAULT NULL::text, p_period_start date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid       uuid := auth.uid();
  v_today     date := public.landlord_float_budget_today();
  v_type      text := lower(btrim(COALESCE(p_period_type, '')));
  v_reason    text := NULLIF(btrim(COALESCE(p_reason, '')), '');
  v_start     date;
  v_current   date;
  v_old      public.landlord_float_budgets%ROWTYPE;
  v_new_id    uuid;
  v_weekly    numeric;
  v_over      boolean := false;
  v_used      numeric;
  v_excess    numeric;
  v_label     text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  IF NOT public.is_cfo_approver(v_uid) THEN
    RAISE EXCEPTION 'Only the designated CFO can set the landlord float budget' USING ERRCODE = '42501';
  END IF;
  IF v_type NOT IN ('daily', 'weekly') THEN
    RAISE EXCEPTION 'Budget period must be daily or weekly' USING ERRCODE = 'check_violation';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 OR p_amount >= 1e12 THEN
    RAISE EXCEPTION 'Enter a budget amount above zero' USING ERRCODE = 'check_violation';
  END IF;

  v_start := COALESCE(p_period_start,
                      CASE WHEN v_type = 'daily' THEN v_today ELSE public.landlord_float_week_start(v_today) END);
  IF v_type = 'weekly' AND v_start <> public.landlord_float_week_start(v_start) THEN
    RAISE EXCEPTION 'A weekly budget starts on a Thursday (landlord float weeks run Thursday to Wednesday)' USING ERRCODE = 'check_violation';
  END IF;
  -- (No CASE inside an IF condition: PL/pgSQL ends the condition at the first THEN.)
  v_current := CASE WHEN v_type = 'daily' THEN v_today ELSE public.landlord_float_week_start(v_today) END;
  IF v_start < v_current THEN
    RAISE EXCEPTION 'A budget cannot be set for a period that has already ended' USING ERRCODE = 'check_violation';
  END IF;

  -- Serialises against COO approvals, which lock the same live row.
  SELECT * INTO v_old FROM public.landlord_float_budgets
   WHERE period_type = v_type AND period_start = v_start AND superseded_at IS NULL
   FOR UPDATE;

  IF v_type = 'daily' THEN
    SELECT amount INTO v_weekly FROM public.landlord_float_budgets
     WHERE period_type = 'weekly' AND period_start = public.landlord_float_week_start(v_start) AND superseded_at IS NULL;
    v_over := v_weekly IS NOT NULL AND p_amount > v_weekly;
  ELSE
    v_over := EXISTS (
      SELECT 1 FROM public.landlord_float_budgets
       WHERE period_type = 'daily' AND superseded_at IS NULL
         AND period_start BETWEEN v_start AND v_start + 6
         AND amount > p_amount);
  END IF;

  IF v_over AND length(COALESCE(v_reason, '')) < 10 THEN
    RAISE EXCEPTION 'OVER_WEEKLY_REASON_REQUIRED: the daily budget is above the weekly budget. Give a reason of at least 10 characters to save it.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_old.id IS NOT NULL THEN
    UPDATE public.landlord_float_budgets SET superseded_at = now() WHERE id = v_old.id;
  END IF;

  INSERT INTO public.landlord_float_budgets
    (period_type, period_start, period_end, amount, reason, over_weekly_warning, set_by)
  VALUES
    (v_type, v_start, CASE WHEN v_type = 'daily' THEN v_start ELSE v_start + 6 END, p_amount, v_reason, v_over, v_uid)
  RETURNING id INTO v_new_id;

  IF v_old.id IS NOT NULL THEN
    UPDATE public.landlord_float_budgets SET superseded_by = v_new_id WHERE id = v_old.id;
  END IF;

  INSERT INTO public.audit_logs (action_type, table_name, record_id, user_id, metadata)
  VALUES ('landlord_float_budget_set', 'landlord_float_budgets', v_new_id::text, v_uid,
          jsonb_build_object('period_type', v_type, 'period_start', v_start, 'amount', p_amount,
                             'previous_amount', v_old.amount, 'previous_budget_id', v_old.id,
                             'reason', v_reason, 'over_weekly_warning', v_over));

  -- What is already approved against the period, within the cap.
  SELECT COALESCE(sum(amount), 0) INTO v_used
    FROM public.landlord_float_budget_allocations
   WHERE released_at IS NULL AND kind = 'within_cap'
     AND CASE WHEN v_type = 'daily' THEN budget_date = v_start ELSE week_start = v_start END;
  v_excess := greatest(v_used - p_amount, 0);

  v_label := CASE WHEN v_type = 'daily' THEN format('daily landlord float budget for %s', to_char(v_start, 'DD Mon YYYY'))
                  ELSE format('weekly landlord float budget for the week of %s', to_char(v_start, 'DD Mon YYYY')) END;

  PERFORM public._landlord_float_notify(
    ARRAY['coo'],
    'Landlord float budget set',
    format('The CFO set the %s to %s.', v_label, public._landlord_float_ugx(p_amount)),
    jsonb_build_object('kind', 'landlord_float_budget_set', 'budget_id', v_new_id, 'period_type', v_type,
                       'period_start', v_start, 'amount', p_amount),
    'landlord_float_budget_set:' || v_new_id, '/coo/dashboard');

  IF v_excess > 0 THEN
    PERFORM public._landlord_float_notify(
      ARRAY['coo', 'cfo'],
      'Landlord float budget exceeded',
      format('The %s is now %s, but %s is already approved against it: over budget by %s.',
             v_label, public._landlord_float_ugx(p_amount), public._landlord_float_ugx(v_used),
             public._landlord_float_ugx(v_excess)),
      jsonb_build_object('kind', 'landlord_float_budget_exceeded', 'budget_id', v_new_id, 'period_type', v_type,
                         'period_start', v_start, 'amount', p_amount, 'used', v_used, 'excess', v_excess),
      'landlord_float_budget_exceeded:' || v_new_id);
  END IF;

  RETURN jsonb_build_object(
    'budget_id', v_new_id,
    'over_weekly_warning', v_over,
    'excess', v_excess,
    'status', public._landlord_float_position(CASE WHEN v_type = 'daily' THEN v_start ELSE greatest(v_start, v_today) END)
  );
END;
$function$;

-- 6. Post-check: every allocation still belongs to its weekly float.
DO $post$
BEGIN
  IF EXISTS (SELECT 1 FROM public.landlord_float_budget_allocations a
               JOIN public.landlord_float_budgets b ON b.id = a.weekly_budget_id
              WHERE a.week_start <> b.period_start OR a.budget_date NOT BETWEEN b.period_start AND b.period_end) THEN
    RAISE EXCEPTION 'post-check failed: an allocation is outside its weekly float after the re-key';
  END IF;
END
$post$;

RESET lock_timeout;
