CREATE OR REPLACE FUNCTION public.hr_compute_snapshots(_period_start date, _period_end date)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare _rows integer := 0;
declare _delta integer := 0;
begin
  with base as (
    select
      s.id as staff_id,
      a.department_id,
      count(t.id) filter (where t.created_at::date between _period_start and _period_end) as assigned_n,
      count(t.id) filter (where t.status = 'completed'
        and t.completed_at::date between _period_start and _period_end) as completed_n,
      count(t.id) filter (where t.status = 'completed'
        and t.completed_at::date between _period_start and _period_end
        and t.due_at is not null and t.completed_at <= t.due_at) as ontime_n,
      count(t.id) filter (where t.status = 'completed'
        and t.completed_at::date between _period_start and _period_end
        and t.due_at is not null) as due_n,
      coalesce(sum(t.reopen_count) filter (where t.completed_at::date
        between _period_start and _period_end), 0) as reopens,
      percentile_cont(0.5) within group (
        order by extract(epoch from (t.completed_at - t.created_at)) / 86400.0
      ) filter (where t.status = 'completed'
        and t.completed_at::date between _period_start and _period_end) as median_days,
      percentile_cont(0.5) within group (
        order by extract(epoch from (t.started_at - t.created_at)) / 3600.0
      ) filter (where t.started_at is not null
        and t.started_at::date between _period_start and _period_end) as median_accept_hours,
      count(t.id) filter (where t.status in ('open','in_progress','blocked','submitted')) as open_n,
      count(t.id) filter (where t.status in ('open','in_progress','blocked','submitted')
        and t.due_at < now()) as overdue_n
    from public.hr_staff s
    join public.hr_assignments a on a.staff_id = s.id and a.ended_on is null and a.is_primary = true
    left join public.hr_tasks t on t.assignee_staff_id = s.id
    where s.active
    group by s.id, a.department_id
  )
  insert into public.hr_metric_snapshots
    (staff_id, department_id, metric_key, metric_version, period_start, period_end, value, inputs_snapshot)
  select b.staff_id, b.department_id, m.key, 1, _period_start, _period_end, m.val,
         jsonb_build_object('assigned',b.assigned_n,'completed',b.completed_n,'ontime',b.ontime_n,
                            'with_due',b.due_n,'reopens',b.reopens,'open',b.open_n,'overdue',b.overdue_n)
  from base b
  cross join lateral (values
    ('completion_rate',   case when b.assigned_n = 0 then null else round(100.0 * b.completed_n / b.assigned_n, 1) end),
    ('on_time_rate',      case when b.due_n = 0 then null else round(100.0 * b.ontime_n / b.due_n, 1) end),
    ('median_cycle_time', round(b.median_days::numeric, 2)),
    ('rework_rate',       case when b.completed_n = 0 then null else round(100.0 * b.reopens / b.completed_n, 1) end),
    ('open_load',         b.open_n::numeric),
    ('overdue_open',      b.overdue_n::numeric),
    ('acceptance_lag',    round(b.median_accept_hours::numeric, 1))
  ) as m(key, val)
  on conflict (staff_id, metric_key, period_start, period_end, metric_version)
    where subject_kind = 'staff'
  do update set value = excluded.value,
                computed_at = now(),
                inputs_snapshot = excluded.inputs_snapshot
  where public.hr_metric_snapshots.locked = false;
  get diagnostics _delta = row_count;
  _rows := _rows + _delta;

  insert into public.hr_metric_snapshots
    (staff_id, department_id, subject_kind, metric_key, metric_version,
     period_start, period_end, value, inputs_snapshot)
  select null, a.department_id, 'department', 'headcount', 1,
         _period_start, _period_end, count(*)::numeric,
         jsonb_build_object('active_staff', count(*))
  from public.hr_staff s
  join public.hr_assignments a
    on a.staff_id = s.id and a.ended_on is null and a.is_primary = true
  where s.active
  group by a.department_id
  on conflict (department_id, metric_key, period_start, period_end, metric_version)
    where subject_kind = 'department'
  do update set value = excluded.value,
                computed_at = now(),
                inputs_snapshot = excluded.inputs_snapshot
  where public.hr_metric_snapshots.locked = false;
  get diagnostics _delta = row_count;
  _rows := _rows + _delta;

  insert into public.hr_metric_snapshots
    (staff_id, department_id, subject_kind, metric_key, metric_version,
     period_start, period_end, value, inputs_snapshot)
  select null, null, 'org', 'headcount', 1,
         _period_start, _period_end, count(*)::numeric,
         jsonb_build_object('active_staff', count(*),
                            'departments_staffed', count(distinct a.department_id))
  from public.hr_staff s
  join public.hr_assignments a
    on a.staff_id = s.id and a.ended_on is null and a.is_primary = true
  where s.active
  on conflict (metric_key, period_start, period_end, metric_version)
    where subject_kind = 'org'
  do update set value = excluded.value,
                computed_at = now(),
                inputs_snapshot = excluded.inputs_snapshot
  where public.hr_metric_snapshots.locked = false;
  get diagnostics _delta = row_count;
  _rows := _rows + _delta;

  return _rows;
end $function$
