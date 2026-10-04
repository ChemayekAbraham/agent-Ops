begin;

do $$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema='public' and table_name='user_roles'
                   and column_name='enabled') then
    raise exception 'Wrong database: public.user_roles.enabled not found. This migration belongs to RentFlow.';
  end if;
end $$;

-- "Later" now brings a payroll prompt back after 1 hour (was 2).
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
     set state = 'snoozed', snooze_until = now() + interval '1 hour',
         snooze_count = snooze_count + 1
   where id = _prompt_id and approver_id = auth.uid() and state <> 'resolved'
  returning * into v_row;
  if v_row.id is null then
    raise exception 'That payroll prompt is not yours, or it has already been dealt with.';
  end if;
  return v_row;
end;
$fn$;

-- "Later" now brings a staff survey back after 1 hour (was 1 day).
create or replace function public.staff_survey_snooze(_survey_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $fn$
begin
  if auth.uid() is null then raise exception 'Not signed in.'; end if;
  insert into public.staff_survey_snoozes (survey_id, user_id, snooze_until, snooze_count)
  values (_survey_id, auth.uid(), now() + interval '1 hour', 1)
  on conflict (survey_id, user_id) do update
    set snooze_until = now() + interval '1 hour',
        snooze_count = public.staff_survey_snoozes.snooze_count + 1;
end;
$fn$;

-- Anyone already snoozed comes back within the hour, not at the old time.
update public.hr_pay_prompts
   set snooze_until = least(snooze_until, now() + interval '1 hour')
 where state = 'snoozed' and snooze_until > now() + interval '1 hour';
update public.staff_survey_snoozes
   set snooze_until = least(snooze_until, now() + interval '1 hour')
 where snooze_until > now() + interval '1 hour';

-- The staff reinvestment return is 20% per month.
update public.staff_surveys
   set body = replace(body, 'earns 15% per month', 'earns 20% per month')
 where code = 'salary_reinvestment_2026';

commit;