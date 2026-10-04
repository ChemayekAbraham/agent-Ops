-- WELILE-CC-METRICS7 : routed register + additive call-centre metrics calculator.
-- hr_compute_snapshots is NOT modified anywhere in this migration.

CREATE OR REPLACE VIEW public.v_cc_routed_register
WITH (security_invoker = true) AS
SELECT
  t.ref                                   AS ticket_ref,
  t.severity                              AS ticket_severity,
  t.raised_at                             AS raised_at,
  r.subject_type                          AS subject_type,
  cat.label                               AS feedback_category,
  cat.locked                              AS category_locked,
  pe.full_name                            AS routed_to_expected_name,
  pa.full_name                            AS routed_to_actual_name,
  (f.routed_to_expected IS NOT NULL
     AND f.routed_to_actual IS DISTINCT FROM f.routed_to_expected) AS misrouted,
  tk.ref                                  AS task_ref,
  tk.status                               AS task_status,
  pt.full_name                            AS task_assignee_name,
  tk.due_at                               AS due_at,
  tk.completed_at                         AS completed_at,
  ROUND(EXTRACT(epoch FROM (COALESCE(tk.completed_at, now()) - t.raised_at)) / 86400.0, 2) AS days_open,
  fu.completed_at                         AS followup_completed_at
FROM public.cc_feedback f
JOIN public.cc_call_attempts a       ON a.id = f.attempt_id
JOIN public.cc_cycle_rows r          ON r.id = a.cycle_row_id
JOIN public.cc_feedback_categories cat ON cat.id = f.category_id
LEFT JOIN public.hr_tickets t        ON t.id = f.ticket_id
LEFT JOIN public.hr_tasks tk         ON tk.id = t.task_id
LEFT JOIN public.hr_staff se         ON se.id = f.routed_to_expected
LEFT JOIN public.profiles pe         ON pe.id = se.user_id
LEFT JOIN public.hr_staff sa         ON sa.id = f.routed_to_actual
LEFT JOIN public.profiles pa         ON pa.id = sa.user_id
LEFT JOIN public.hr_staff st         ON st.id = tk.assignee_staff_id
LEFT JOIN public.profiles pt         ON pt.id = st.user_id
LEFT JOIN LATERAL (
  SELECT fw.completed_at
  FROM public.cc_followups fw
  WHERE fw.ticket_id = t.id
  ORDER BY fw.created_at DESC
  LIMIT 1
) fu ON true
WHERE public.has_role(auth.uid(), 'hr')
   OR public.has_role(auth.uid(), 'ceo')
   OR public.has_role(auth.uid(), 'coo')
   OR public.has_role(auth.uid(), 'operations')
   OR public.has_role(auth.uid(), 'super_admin');

GRANT SELECT ON public.v_cc_routed_register TO authenticated;

-- Additive calculator. Writes only cc_* metric keys into hr_metric_snapshots,
-- mirroring the period predicates, conflict targets and gating of the existing
-- calculator without altering it.
CREATE OR REPLACE FUNCTION public.hr_compute_cc_snapshots(
  _period_start date,
  _period_end   date
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
declare _rows integer := 0;
declare _delta integer := 0;
begin
  -- ---------- staff grain ----------
  with att as (
    select a.id, a.caller_id, a.revealed_at, a.recorded_at, a.outcome
    from public.cc_call_attempts a
  ),
  base as (
    select
      s.id as staff_id,
      asg.department_id,
      count(x.id) filter (where x.revealed_at::date between _period_start and _period_end) as attempted_n,
      count(x.id) filter (where x.recorded_at::date between _period_start and _period_end) as recorded_n,
      count(x.id) filter (where x.outcome = 'engaged'
        and x.recorded_at::date between _period_start and _period_end) as engaged_n,
      count(fb.id) filter (where fb.created_at::date between _period_start and _period_end) as feedback_n,
      percentile_cont(0.5) within group (
        order by extract(epoch from (x.recorded_at - x.revealed_at)) / 60.0
      ) filter (where x.recorded_at is not null
        and x.recorded_at::date between _period_start and _period_end) as lag_minutes,
      count(distinct fu.id) filter (where fu.due_at::date between _period_start and _period_end) as promise_due_n,
      count(distinct fu.id) filter (where fu.due_at::date between _period_start and _period_end
        and fu.completed_at is not null and fu.completed_at <= fu.due_at) as promise_kept_n
    from public.hr_staff s
    join public.hr_assignments asg on asg.staff_id = s.id and asg.is_primary = true
      and asg.started_on <= _period_end
      and (asg.ended_on is null or asg.ended_on > _period_end)
    left join att x on x.caller_id = s.user_id
    left join public.cc_feedback fb on fb.attempt_id = x.id
    left join public.cc_followups fu on fu.owed_by_staff_id = s.id
    where (s.ended_on is null or s.ended_on > _period_end)
    group by s.id, asg.department_id
  )
  insert into public.hr_metric_snapshots
    (staff_id, department_id, metric_key, metric_version, period_start, period_end, value, inputs_snapshot)
  select b.staff_id, b.department_id, m.key, 1, _period_start, _period_end, m.val,
         jsonb_build_object('attempted',b.attempted_n,'recorded',b.recorded_n,'engaged',b.engaged_n,
                            'feedback',b.feedback_n,'promise_due',b.promise_due_n,'promise_kept',b.promise_kept_n)
  from base b
  cross join lateral (values
    ('cc_calls_attempted',      b.attempted_n::numeric),
    ('cc_calls_engaged',        b.engaged_n::numeric),
    ('cc_reach_rate',           case when b.recorded_n = 0 then null else round(100.0 * b.engaged_n / b.recorded_n, 1) end),
    ('cc_feedback_yield',       case when b.engaged_n = 0 then null else round(100.0 * b.feedback_n / b.engaged_n, 1) end),
    ('cc_recording_lag_median', round(b.lag_minutes::numeric, 1)),
    ('cc_promise_kept_rate',    case when b.promise_due_n = 0 then null else round(100.0 * b.promise_kept_n / b.promise_due_n, 1) end)
  ) as m(key, val)
  where exists (
    select 1 from public.hr_metric_definitions d
    where d.key = m.key and d.department_id is null and d.active
  )
  on conflict (staff_id, metric_key, period_start, period_end, metric_version)
    where subject_kind = 'staff'
  do update set value = excluded.value,
                computed_at = now(),
                inputs_snapshot = excluded.inputs_snapshot
  where public.hr_metric_snapshots.locked = false;
  get diagnostics _delta = row_count;
  _rows := _rows + _delta;

  -- ---------- department grain ----------
  with dept_staff as (
    select s.id as staff_id, s.user_id, asg.department_id
    from public.hr_staff s
    join public.hr_assignments asg on asg.staff_id = s.id and asg.is_primary = true
      and asg.started_on <= _period_end
      and (asg.ended_on is null or asg.ended_on > _period_end)
    where (s.ended_on is null or s.ended_on > _period_end)
  ),
  dept as (
    select
      d.department_id,
      count(a.id) filter (where a.revealed_at::date between _period_start and _period_end) as attempted_n,
      count(a.id) filter (where a.recorded_at::date between _period_start and _period_end) as recorded_n,
      count(a.id) filter (where a.outcome = 'engaged'
        and a.recorded_at::date between _period_start and _period_end) as engaged_n,
      count(fb.id) filter (where fb.created_at::date between _period_start and _period_end) as feedback_n,
      count(fb.id) filter (where fb.created_at::date between _period_start and _period_end
        and fb.routed_to_expected is not null) as routed_n,
      count(fb.id) filter (where fb.created_at::date between _period_start and _period_end
        and fb.routed_to_expected is not null
        and fb.routed_to_actual is distinct from fb.routed_to_expected) as misrouted_n,
      count(distinct tk.id) filter (where tk.raised_at::date between _period_start and _period_end) as tickets_n,
      percentile_cont(0.5) within group (
        order by extract(epoch from (a.recorded_at - a.revealed_at)) / 60.0
      ) filter (where a.recorded_at is not null
        and a.recorded_at::date between _period_start and _period_end) as lag_minutes
    from dept_staff d
    left join public.cc_call_attempts a on a.caller_id = d.user_id
    left join public.cc_feedback fb on fb.attempt_id = a.id
    left join public.hr_tickets tk on tk.call_attempt_id = a.id
    group by d.department_id
  )
  insert into public.hr_metric_snapshots
    (staff_id, department_id, subject_kind, metric_key, metric_version,
     period_start, period_end, value, inputs_snapshot)
  select null, x.department_id, 'department', m.key, 1, _period_start, _period_end, m.val,
         jsonb_build_object('attempted',x.attempted_n,'recorded',x.recorded_n,'engaged',x.engaged_n,
                            'feedback',x.feedback_n,'routed',x.routed_n,'misrouted',x.misrouted_n,
                            'tickets',x.tickets_n)
  from dept x
  cross join lateral (values
    ('cc_calls_attempted',      x.attempted_n::numeric),
    ('cc_calls_engaged',        x.engaged_n::numeric),
    ('cc_reach_rate',           case when x.recorded_n = 0 then null else round(100.0 * x.engaged_n / x.recorded_n, 1) end),
    ('cc_feedback_yield',       case when x.engaged_n = 0 then null else round(100.0 * x.feedback_n / x.engaged_n, 1) end),
    ('cc_tickets_raised',       x.tickets_n::numeric),
    ('cc_misroute_rate',        case when x.routed_n = 0 then null else round(100.0 * x.misrouted_n / x.routed_n, 1) end),
    ('cc_recording_lag_median', round(x.lag_minutes::numeric, 1))
  ) as m(key, val)
  where x.department_id is not null
    and exists (
      select 1 from public.hr_metric_definitions d
      where d.key = m.key and d.department_id is null and d.active
    )
  on conflict (department_id, metric_key, period_start, period_end, metric_version)
    where subject_kind = 'department'
  do update set value = excluded.value,
                computed_at = now(),
                inputs_snapshot = excluded.inputs_snapshot
  where public.hr_metric_snapshots.locked = false;
  get diagnostics _delta = row_count;
  _rows := _rows + _delta;

  -- ---------- org grain ----------
  with org as (
    select
      (select count(*) from public.cc_call_attempts a
        where a.revealed_at::date between _period_start and _period_end) as attempted_n,
      (select count(*) from public.cc_call_attempts a
        where a.recorded_at::date between _period_start and _period_end) as recorded_n,
      (select count(*) from public.cc_call_attempts a
        where a.outcome = 'engaged'
          and a.recorded_at::date between _period_start and _period_end) as engaged_n,
      (select count(*) from public.cc_feedback fb
        where fb.created_at::date between _period_start and _period_end) as feedback_n,
      (select count(*) from public.cc_feedback fb
        where fb.created_at::date between _period_start and _period_end
          and fb.routed_to_expected is not null) as routed_n,
      (select count(*) from public.cc_feedback fb
        where fb.created_at::date between _period_start and _period_end
          and fb.routed_to_expected is not null
          and fb.routed_to_actual is distinct from fb.routed_to_expected) as misrouted_n,
      (select count(*) from public.hr_tickets t
        where t.call_attempt_id is not null
          and t.raised_at::date between _period_start and _period_end) as tickets_n,
      (select count(*) from public.cc_cycle_rows r
        where r.created_at::date <= _period_end) as cycle_rows_n,
      (select count(*) from public.cc_cycle_rows r
        where r.created_at::date <= _period_end and r.attempts_made > 0) as cycle_rows_touched_n,
      (select count(*) from public.cc_followups fu
        where fu.due_at::date between _period_start and _period_end) as promise_due_n,
      (select count(*) from public.cc_followups fu
        where fu.due_at::date between _period_start and _period_end
          and fu.completed_at is not null and fu.completed_at <= fu.due_at) as promise_kept_n,
      (select percentile_cont(0.5) within group (
                order by extract(epoch from (a.recorded_at - a.revealed_at)) / 60.0)
       from public.cc_call_attempts a
       where a.recorded_at is not null
         and a.recorded_at::date between _period_start and _period_end) as lag_minutes
  )
  insert into public.hr_metric_snapshots
    (staff_id, department_id, subject_kind, metric_key, metric_version,
     period_start, period_end, value, inputs_snapshot)
  select null, null, 'org', m.key, 1, _period_start, _period_end, m.val,
         jsonb_build_object('attempted',o.attempted_n,'recorded',o.recorded_n,'engaged',o.engaged_n,
                            'feedback',o.feedback_n,'routed',o.routed_n,'misrouted',o.misrouted_n,
                            'tickets',o.tickets_n,'cycle_rows',o.cycle_rows_n,
                            'cycle_rows_touched',o.cycle_rows_touched_n,
                            'promise_due',o.promise_due_n,'promise_kept',o.promise_kept_n,
                            'as_of', _period_end)
  from org o
  cross join lateral (values
    ('cc_calls_attempted',      o.attempted_n::numeric),
    ('cc_calls_engaged',        o.engaged_n::numeric),
    ('cc_reach_rate',           case when o.recorded_n = 0 then null else round(100.0 * o.engaged_n / o.recorded_n, 1) end),
    ('cc_coverage_rate',        case when o.cycle_rows_n = 0 then null else round(100.0 * o.cycle_rows_touched_n / o.cycle_rows_n, 1) end),
    ('cc_feedback_yield',       case when o.engaged_n = 0 then null else round(100.0 * o.feedback_n / o.engaged_n, 1) end),
    ('cc_tickets_raised',       o.tickets_n::numeric),
    ('cc_misroute_rate',        case when o.routed_n = 0 then null else round(100.0 * o.misrouted_n / o.routed_n, 1) end),
    ('cc_promise_kept_rate',    case when o.promise_due_n = 0 then null else round(100.0 * o.promise_kept_n / o.promise_due_n, 1) end),
    ('cc_recording_lag_median', round(o.lag_minutes::numeric, 1))
  ) as m(key, val)
  where exists (
    select 1 from public.hr_metric_definitions d
    where d.key = m.key and d.department_id is null and d.active
  )
  on conflict (metric_key, period_start, period_end, metric_version)
    where subject_kind = 'org'
  do update set value = excluded.value,
                computed_at = now(),
                inputs_snapshot = excluded.inputs_snapshot
  where public.hr_metric_snapshots.locked = false;
  get diagnostics _delta = row_count;
  _rows := _rows + _delta;

  return _rows;
end
$fn$;

REVOKE ALL ON FUNCTION public.hr_compute_cc_snapshots(date, date) FROM public;
GRANT EXECUTE ON FUNCTION public.hr_compute_cc_snapshots(date, date) TO service_role;