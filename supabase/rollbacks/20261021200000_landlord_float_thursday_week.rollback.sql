-- Rollback for 20261021200000_landlord_float_thursday_week.sql: landlord float weeks back to Monday–Sunday.
-- Re-keys every weekly float Thu T..Wed T+6 -> Mon T+4..Sun T+10 (the inverse of the migration) and every allocation to
-- the Monday of its approval date, restores the Monday rules, the Monday week function and production's set-float
-- function, with an audit row per float. REFUSES if any allocation would leave its float (approved Thursday–Sunday of
-- a Thursday week, e.g. after new floats were set under the Thursday rule): reverse those by hand.

SET lock_timeout = '5s';
LOCK TABLE public.landlord_float_budgets, public.landlord_float_budget_allocations IN ACCESS EXCLUSIVE MODE;
DO $pre$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.landlord_float_week_start(date)'::regprocedure) <> '70e7f84031ee9ecde35818af1789cc9b' THEN
    RAISE EXCEPTION 'precondition failed: landlord_float_week_start is not the Thursday definition 20261021200000 created; reverse it by hand';
  END IF;
  IF EXISTS (SELECT 1 FROM public.landlord_float_budgets WHERE period_type = 'weekly' AND extract(isodow FROM period_start) <> 4)
     OR EXISTS (SELECT 1 FROM public.landlord_float_budget_allocations a
                  JOIN public.landlord_float_budgets b ON b.id = a.weekly_budget_id
                 WHERE (a.budget_date - (extract(isodow FROM a.budget_date)::int - 1)) <> b.period_start + 4) THEN
    RAISE EXCEPTION 'precondition failed: a weekly float or an allocation cannot be moved back to a Monday week; reverse it by hand';
  END IF;
END
$pre$;

ALTER TABLE public.landlord_float_budgets DROP CONSTRAINT landlord_float_budgets_period_shape;
ALTER TABLE public.landlord_float_budget_allocations DROP CONSTRAINT landlord_float_alloc_week;

CREATE OR REPLACE FUNCTION public.landlord_float_week_start(p_day date)
 RETURNS date
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$ SELECT p_day - (extract(isodow FROM p_day)::int - 1) $function$;
COMMENT ON FUNCTION public.landlord_float_week_start(date) IS NULL;

WITH moved AS (
  UPDATE public.landlord_float_budgets
     SET period_start = period_start + 4, period_end = period_start + 10
   WHERE period_type = 'weekly'
  RETURNING id, period_start, period_end, amount, superseded_at
)
INSERT INTO public.audit_logs (action_type, table_name, record_id, reason, old_values, new_values, metadata)
SELECT 'landlord_float_week_rekey', 'landlord_float_budgets', m.id::text,
       'Rollback of 20261021200000_landlord_float_thursday_week: landlord float weeks back to Monday to Sunday',
       jsonb_build_object('period_start', m.period_start - 4, 'period_end', m.period_start + 2),
       jsonb_build_object('period_start', m.period_start, 'period_end', m.period_end),
       jsonb_build_object('amount', m.amount, 'superseded', m.superseded_at IS NOT NULL, 'migration', '20261021200000_landlord_float_thursday_week', 'rollback', true)
  FROM moved m;

WITH moved AS (
  UPDATE public.landlord_float_budget_allocations
     SET week_start = public.landlord_float_week_start(budget_date)
   WHERE week_start IS DISTINCT FROM public.landlord_float_week_start(budget_date)
  RETURNING id
)
INSERT INTO public.audit_logs (action_type, table_name, reason, metadata)
SELECT 'landlord_float_week_rekey', 'landlord_float_budget_allocations',
       'Rollback of 20261021200000_landlord_float_thursday_week: allocation weeks back to Monday to Sunday',
       jsonb_build_object('allocations', count(*), 'migration', '20261021200000_landlord_float_thursday_week', 'rollback', true)
  FROM moved HAVING count(*) > 0;

ALTER TABLE public.landlord_float_budgets ADD CONSTRAINT landlord_float_budgets_period_shape
  CHECK (((period_type = 'daily'::text) AND (period_end = period_start)) OR ((period_type = 'weekly'::text) AND (period_end = (period_start + 6)) AND (EXTRACT(isodow FROM period_start) = (1)::numeric)));
ALTER TABLE public.landlord_float_budget_allocations ADD CONSTRAINT landlord_float_alloc_week
  CHECK (week_start = public.landlord_float_week_start(budget_date));

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
    RAISE EXCEPTION 'A weekly budget starts on a Monday' USING ERRCODE = 'check_violation';
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

RESET lock_timeout;
