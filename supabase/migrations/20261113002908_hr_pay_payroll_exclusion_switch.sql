-- Payroll exclusion switch: a staff member keeps their employee role and staff record but is
-- left off REGULAR payroll runs while the switch is on. Off-cycle (arrears) runs are unaffected,
-- because an arrears entry is already an explicit, per-person decision.
-- History is kept: switching off writes a row; switching back on closes it. Every change is audited.
-- Safety net: a regular run cannot be approved while it holds a payslip for an excluded person.

create table if not exists public.hr_pay_payroll_exclusions (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references public.hr_staff(id) on delete restrict,
  reason text not null check (length(btrim(reason)) >= 10),
  excluded_by uuid not null,
  excluded_at timestamptz not null default now(),
  ended_by uuid,
  ended_at timestamptz,
  end_note text,
  check ((ended_at is null) = (ended_by is null))
);
create unique index if not exists hr_pay_payroll_exclusions_one_open
  on public.hr_pay_payroll_exclusions (staff_id) where ended_at is null;
alter table public.hr_pay_payroll_exclusions enable row level security;
-- No policies: reached only through the functions below.

-- 1. Is this staff member excluded right now?
create or replace function public.hr_pay_is_payroll_excluded(_staff_id uuid)
returns boolean
language sql stable security definer set search_path to 'public'
as $function$
  select exists (select 1 from public.hr_pay_payroll_exclusions
                  where staff_id = _staff_id and ended_at is null);
$function$;

-- 2. The switch. Prepare authority (or super_admin) only. A reason is required both ways.
create or replace function public.hr_pay_set_payroll_exclusion(_staff_id uuid, _exclude boolean, _reason text)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_reason text := nullif(btrim(_reason), '');
  v_open uuid;
  v_ref text;
begin
  if not (public.hr_pay_is_preparer() or public._has_enabled_role(auth.uid(), array['super_admin'])) then
    raise exception 'Only the position holding payroll prepare authority can change who is on payroll.';
  end if;
  if v_reason is null or length(v_reason) < 10 then
    raise exception 'Give a reason of at least 10 characters.';
  end if;

  select staff_ref into v_ref from public.hr_staff where id = _staff_id and active;
  if v_ref is null then
    raise exception 'Staff record not found or not active.';
  end if;

  select id into v_open from public.hr_pay_payroll_exclusions
   where staff_id = _staff_id and ended_at is null for update;

  if _exclude then
    if v_open is not null then
      raise exception '% is already off payroll.', v_ref;
    end if;
    insert into public.hr_pay_payroll_exclusions (staff_id, reason, excluded_by)
    values (_staff_id, v_reason, auth.uid());
  else
    if v_open is null then
      raise exception '% is already on payroll.', v_ref;
    end if;
    update public.hr_pay_payroll_exclusions
       set ended_by = auth.uid(), ended_at = now(), end_note = v_reason
     where id = v_open;
  end if;

  insert into public.audit_logs (user_id, action_type, table_name, record_id, action, metadata)
  values (auth.uid(),
          case when _exclude then 'hr_pay_payroll_excluded' else 'hr_pay_payroll_included' end,
          'hr_staff', _staff_id::text,
          case when _exclude then 'Staff left off regular payroll runs (employee role kept)'
               else 'Staff returned to regular payroll runs' end,
          jsonb_build_object('staff_ref', v_ref, 'reason', v_reason));

  return jsonb_build_object('staff_id', _staff_id, 'staff_ref', v_ref, 'on_payroll', not _exclude);
end $function$;

-- 3. Read: current exclusions and their history (HR, approver, releaser, CFO, super_admin).
create or replace function public.hr_pay_payroll_exclusions_list(_include_history boolean default false)
returns table(staff_id uuid, staff_ref text, full_name text, reason text,
              excluded_by_name text, excluded_at timestamptz,
              ended_by_name text, ended_at timestamptz, end_note text, is_current boolean)
language plpgsql stable security definer set search_path to 'public'
as $function$
#variable_conflict use_column
begin
  if not (public.hr_pay_is_preparer() or public.hr_pay_is_approver() or public.hr_pay_is_releaser()
          or public._has_enabled_role(auth.uid(), array['cfo','super_admin'])) then
    raise exception 'not authorised';
  end if;
  return query
  select e.staff_id, s.staff_ref::text, p.full_name, e.reason,
         pb.full_name, e.excluded_at, pe.full_name, e.ended_at, e.end_note, e.ended_at is null
    from public.hr_pay_payroll_exclusions e
    join public.hr_staff s on s.id = e.staff_id
    left join public.profiles p on p.id = s.user_id
    left join public.profiles pb on pb.id = e.excluded_by
    left join public.profiles pe on pe.id = e.ended_by
   where _include_history or e.ended_at is null
   order by e.ended_at is not null, e.excluded_at desc;
end $function$;

-- 4. Which current payslips on a run belong to staff who are off payroll (regular runs only).
create or replace function public.hr_pay_run_excluded_payslips(_run_id uuid)
returns table(staff_ref text, full_name text, reason text)
language sql stable security definer set search_path to 'public'
as $function$
  select s.staff_ref::text, p.full_name, e.reason
    from public.hr_pay_payslips x
    join public.hr_pay_runs r on r.id = x.run_id and r.run_type = 'regular'
    join public.hr_staff s on s.id = x.staff_id
    join public.hr_pay_payroll_exclusions e on e.staff_id = x.staff_id and e.ended_at is null
    left join public.profiles p on p.id = s.user_id
   where x.run_id = _run_id and x.is_current;
$function$;

-- 5. Safety net: refuse approval of a regular run that still pays someone who is off payroll.
create or replace function public.hr_pay_run_exclusion_guard()
returns trigger
language plpgsql security definer set search_path to 'public'
as $function$
declare v_names text; v_n int;
begin
  if new.event_type = 'approved' then
    select count(*), string_agg(coalesce(full_name, staff_ref), ', ')
      into v_n, v_names
      from public.hr_pay_run_excluded_payslips(new.run_id);
    if v_n > 0 then
      raise exception 'Cannot approve: % payslip(s) belong to staff switched off payroll (%). Recalculate the run so they leave it.', v_n, v_names;
    end if;
  end if;
  return new;
end $function$;

drop trigger if exists hr_pay_run_exclusion_guard_trg on public.hr_pay_run_events;
create trigger hr_pay_run_exclusion_guard_trg
  before insert on public.hr_pay_run_events
  for each row execute function public.hr_pay_run_exclusion_guard();

revoke all on function public.hr_pay_is_payroll_excluded(uuid) from public, anon;
revoke all on function public.hr_pay_set_payroll_exclusion(uuid, boolean, text) from public, anon;
revoke all on function public.hr_pay_payroll_exclusions_list(boolean) from public, anon;
revoke all on function public.hr_pay_run_excluded_payslips(uuid) from public, anon;
revoke all on function public.hr_pay_run_exclusion_guard() from public, anon, authenticated;
grant execute on function public.hr_pay_is_payroll_excluded(uuid) to authenticated;
grant execute on function public.hr_pay_set_payroll_exclusion(uuid, boolean, text) to authenticated;
grant execute on function public.hr_pay_payroll_exclusions_list(boolean) to authenticated;
grant execute on function public.hr_pay_run_excluded_payslips(uuid) to authenticated;
