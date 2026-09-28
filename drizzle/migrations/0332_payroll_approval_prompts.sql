-- Fingerprint. RentFlow only: public.user_roles.enabled does not exist in welile.com.
do $$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema='public' and table_name='user_roles'
                   and column_name='enabled') then
    raise exception 'Wrong database: public.user_roles.enabled not found. This migration belongs to RentFlow.';
  end if;
end $$;

create table if not exists public.hr_pay_prompts (
  id            uuid primary key default gen_random_uuid(),
  run_id        uuid not null references public.hr_pay_runs(id) on delete cascade,
  approver_id   uuid not null,
  kind          text not null,
  state         text not null default 'pending',
  snooze_until  timestamptz,
  snooze_count  smallint not null default 0,
  created_at    timestamptz not null default now(),
  resolved_at   timestamptz,
  resolution    text,
  constraint hr_pay_prompts_kind_ck  check (kind in ('approve','release','lock')),
  constraint hr_pay_prompts_state_ck check (state in ('pending','snoozed','resolved')),
  constraint hr_pay_prompts_uq unique (run_id, approver_id, kind)
);

alter table public.hr_pay_prompts enable row level security;

drop policy if exists hr_pay_prompts_read on public.hr_pay_prompts;
create policy hr_pay_prompts_read on public.hr_pay_prompts
  for select using (approver_id = auth.uid());

create or replace function public.hr_pay_authority_user_ids(_fn text)
returns setof uuid
language sql
stable
security definer
set search_path to 'public'
as $fn$
  select distinct s.user_id
  from public.hr_pay_authorities au
  join public.hr_assignments a on a.position_id = au.position_id
  join public.hr_staff s on s.id = a.staff_id
  where au.function_code = _fn
    and s.user_id is not null
    and s.active
    and a.started_on <= current_date
    and (a.ended_on is null or a.ended_on >= current_date);
$fn$;

revoke all on function public.hr_pay_authority_user_ids(text) from public;
revoke all on function public.hr_pay_authority_user_ids(text) from anon;
revoke all on function public.hr_pay_authority_user_ids(text) from authenticated;

create or replace function public.hr_pay_prompt_follow_run()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $fn$
begin
  if new.status is not distinct from old.status then
    return null;
  end if;

  update public.hr_pay_prompts
     set state = 'resolved', resolved_at = now(), resolution = new.status
   where run_id = new.id
     and state <> 'resolved'
     and ((kind = 'approve' and old.status = 'in_review')
       or (kind = 'release' and old.status = 'approved')
       or (kind = 'lock'    and old.status = 'paid'));

  if new.status = 'in_review' then
    insert into public.hr_pay_prompts (run_id, approver_id, kind)
    select new.id, u.uid, 'approve'
      from public.hr_pay_authority_user_ids('approve') as u(uid)
    on conflict (run_id, approver_id, kind) do update
      set state = 'pending', snooze_until = null, snooze_count = 0,
          resolved_at = null, resolution = null;
  elsif new.status = 'approved' then
    insert into public.hr_pay_prompts (run_id, approver_id, kind)
    select new.id, u.uid, 'release'
      from public.hr_pay_authority_user_ids('release') as u(uid)
    on conflict (run_id, approver_id, kind) do update
      set state = 'pending', snooze_until = null, snooze_count = 0,
          resolved_at = null, resolution = null;
  elsif new.status = 'paid' then
    insert into public.hr_pay_prompts (run_id, approver_id, kind)
    select new.id, u.uid, 'lock'
      from public.hr_pay_authority_user_ids('release') as u(uid)
    on conflict (run_id, approver_id, kind) do update
      set state = 'pending', snooze_until = null, snooze_count = 0,
          resolved_at = null, resolution = null;
  end if;

  return null;
end;
$fn$;

drop trigger if exists hr_pay_prompt_follow_run_trg on public.hr_pay_runs;
create trigger hr_pay_prompt_follow_run_trg
  after update of status on public.hr_pay_runs
  for each row execute function public.hr_pay_prompt_follow_run();

create or replace function public.hr_pay_pending_prompt()
returns table(prompt_id uuid, kind text, run_id uuid, period_code text, run_type text,
              employees integer, total_net numeric, unpaid_count integer, unpaid_net numeric,
              snooze_count smallint, raised_at timestamptz)
language sql
stable
security definer
set search_path to 'public'
as $fn$
  select pr.id, pr.kind, r.id, pe.code, r.run_type,
         (select count(*)::int from public.hr_pay_payslips ps
           where ps.run_id = r.id and ps.is_current),
         coalesce(r.total_net, 0),
         (select count(*)::int from public.hr_pay_payslips ps
           where ps.run_id = r.id and ps.is_current and ps.net > 0
             and not exists (select 1 from public.hr_pay_disbursements d
                             where d.payslip_id = ps.id and d.status = 'posted')),
         (select coalesce(sum(ps.net), 0) from public.hr_pay_payslips ps
           where ps.run_id = r.id and ps.is_current and ps.net > 0
             and not exists (select 1 from public.hr_pay_disbursements d
                             where d.payslip_id = ps.id and d.status = 'posted')),
         pr.snooze_count, pr.created_at
  from public.hr_pay_prompts pr
  join public.hr_pay_runs r on r.id = pr.run_id
  join public.hr_pay_periods pe on pe.id = r.period_id
  where pr.approver_id = auth.uid()
    and pr.state <> 'resolved'
    and (pr.snooze_until is null or pr.snooze_until <= now())
    and ((pr.kind = 'approve' and r.status = 'in_review')
      or (pr.kind = 'release' and r.status = 'approved')
      or (pr.kind = 'lock'    and r.status = 'paid'))
  order by pr.created_at
  limit 1;
$fn$;

create or replace function public.hr_pay_prompt_snooze(_prompt_id uuid)
returns public.hr_pay_prompts
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare v_row public.hr_pay_prompts%rowtype;
begin
  if auth.uid() is null then raise exception 'Not signed in.'; end if;
  update public.hr_pay_prompts
     set state = 'snoozed', snooze_until = now() + interval '2 hours',
         snooze_count = snooze_count + 1
   where id = _prompt_id and approver_id = auth.uid() and state <> 'resolved'
  returning * into v_row;
  if v_row.id is null then
    raise exception 'That payroll prompt is not yours, or it has already been dealt with.';
  end if;
  return v_row;
end;
$fn$;

revoke all on function public.hr_pay_pending_prompt() from public;
revoke all on function public.hr_pay_pending_prompt() from anon;
grant execute on function public.hr_pay_pending_prompt() to authenticated;
revoke all on function public.hr_pay_prompt_snooze(uuid) from public;
revoke all on function public.hr_pay_prompt_snooze(uuid) from anon;
grant execute on function public.hr_pay_prompt_snooze(uuid) to authenticated;

insert into public.hr_pay_prompts (run_id, approver_id, kind)
select r.id, u.uid,
       case r.status when 'in_review' then 'approve' when 'approved' then 'release' else 'lock' end
from public.hr_pay_runs r
cross join lateral public.hr_pay_authority_user_ids(
  case r.status when 'in_review' then 'approve' else 'release' end) as u(uid)
where r.status in ('in_review','approved','paid')
on conflict (run_id, approver_id, kind) do nothing;
