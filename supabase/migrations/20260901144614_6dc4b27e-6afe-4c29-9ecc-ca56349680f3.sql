create or replace function public.hr_ticket_people(p_ticket_ids uuid[])
returns table (
  ticket_id uuid,
  raised_by_name text,
  closed_by_name text,
  assignee_name text,
  task_title text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    t.id,
    coalesce(rp.full_name, rs.staff_ref),
    coalesce(cp.full_name, cs.staff_ref),
    coalesce(ap.full_name, asf.staff_ref),
    tk.title
  from public.hr_tickets t
  left join public.hr_staff rs on rs.id = t.raised_by
  left join public.profiles rp on rp.id = rs.user_id
  left join public.hr_staff cs on cs.id = t.closed_no_task_by
  left join public.profiles cp on cp.id = cs.user_id
  left join public.hr_tasks tk on tk.id = t.task_id
  left join public.hr_staff asf on asf.id = tk.assignee_staff_id
  left join public.profiles ap on ap.id = asf.user_id
  where t.id = any(p_ticket_ids)
    and public.hr_my_staff_id() is not null
    and (
      public.hr_can_assign_tasks()
      or t.raised_by = public.hr_my_staff_id()
      or (t.task_id is null and t.closed_no_task_at is null)
      or exists (
        select 1 from public.hr_tasks x
        where x.id = t.task_id and x.assignee_staff_id = public.hr_my_staff_id()
      )
    )
$$;

grant execute on function public.hr_ticket_people(uuid[]) to authenticated;