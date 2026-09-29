begin;

do $$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema='public' and table_name='user_roles'
                   and column_name='enabled') then
    raise exception 'Wrong database: public.user_roles.enabled not found. This migration belongs to RentFlow.';
  end if;
  if to_regclass('public.hr_pay_prompts') is null then
    raise exception 'public.hr_pay_prompts does not exist. Apply the payroll approval prompts migration first.';
  end if;
end $$;

-- A returned run now prompts the position holding prepare authority, the same
-- way approval prompts the CEO and payment prompts the CFO.
alter table public.hr_pay_prompts drop constraint if exists hr_pay_prompts_kind_ck;
alter table public.hr_pay_prompts add constraint hr_pay_prompts_kind_ck
  check (kind in ('approve','release','lock','rework'));

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
       or (kind = 'lock'    and old.status = 'paid')
       or (kind = 'rework'  and old.status = 'returned'));

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
  elsif new.status = 'returned' then
    insert into public.hr_pay_prompts (run_id, approver_id, kind)
    select new.id, u.uid, 'rework'
      from public.hr_pay_authority_user_ids('prepare') as u(uid)
    on conflict (run_id, approver_id, kind) do update
      set state = 'pending', snooze_until = null, snooze_count = 0,
          resolved_at = null, resolution = null;
  end if;

  return null;
end;
$fn$;

-- The return type gains the approver's note, so the function is recreated.
drop function if exists public.hr_pay_pending_prompt();
create function public.hr_pay_pending_prompt()
returns table(prompt_id uuid, kind text, run_id uuid, period_code text, run_type text,
              employees integer, total_net numeric, unpaid_count integer, unpaid_net numeric,
              snooze_count smallint, raised_at timestamptz, note text)
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
         pr.snooze_count, pr.created_at,
         (select e.note from public.hr_pay_run_events e
           where e.run_id = r.id and e.event_type = 'returned'
           order by e.created_at desc limit 1)
  from public.hr_pay_prompts pr
  join public.hr_pay_runs r on r.id = pr.run_id
  join public.hr_pay_periods pe on pe.id = r.period_id
  where pr.approver_id = auth.uid()
    and pr.state <> 'resolved'
    and (pr.snooze_until is null or pr.snooze_until <= now())
    and ((pr.kind = 'approve' and r.status = 'in_review')
      or (pr.kind = 'release' and r.status = 'approved')
      or (pr.kind = 'lock'    and r.status = 'paid')
      or (pr.kind = 'rework'  and r.status = 'returned'))
  order by pr.created_at
  limit 1;
$fn$;

revoke all on function public.hr_pay_pending_prompt() from public;
revoke all on function public.hr_pay_pending_prompt() from anon;
grant execute on function public.hr_pay_pending_prompt() to authenticated;

-- Runs already returned when this lands get their rework prompt now.
insert into public.hr_pay_prompts (run_id, approver_id, kind)
select r.id, u.uid, 'rework'
from public.hr_pay_runs r
cross join lateral public.hr_pay_authority_user_ids('prepare') as u(uid)
where r.status = 'returned'
on conflict (run_id, approver_id, kind) do nothing;

commit;