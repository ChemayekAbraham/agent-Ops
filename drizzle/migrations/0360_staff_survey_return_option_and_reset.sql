begin;

do $$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema='public' and table_name='user_roles'
                   and column_name='enabled') then
    raise exception 'Wrong database: public.user_roles.enabled not found. This migration belongs to RentFlow.';
  end if;
  if not exists (select 1 from information_schema.columns
                 where table_schema='public' and table_name='staff_survey_responses'
                   and column_name='payout_mode') then
    raise exception 'staff_survey_responses.payout_mode not found. Apply the monthly cycles migration first.';
  end if;
end $$;

-- A pledge made before the return option existed has no payout_mode. The survey
-- now comes back for exactly those people, asking only for the return option.
drop function if exists public.staff_survey_pending();
create function public.staff_survey_pending()
returns table(survey_id uuid, kind text, title text, body text, snooze_count smallint,
              cycle_start date, last_response text, last_percentage smallint, last_payout_mode text,
              needs_payout_mode boolean)
language sql
stable
security definer
set search_path to 'public'
as $fn$
  select s.id, s.kind, s.title, s.body, coalesce(z.snooze_count, 0)::smallint,
         public.staff_survey_current_cycle(),
         prev.response, prev.percentage, prev.payout_mode,
         (cur.id is not null)
  from public.staff_surveys s
  left join public.staff_survey_snoozes z on z.survey_id = s.id and z.user_id = auth.uid()
  left join lateral (
    select r.response, r.percentage, r.payout_mode
    from public.staff_survey_responses r
    where r.survey_id = s.id and r.user_id = auth.uid()
    order by r.cycle_start desc limit 1) prev on true
  left join lateral (
    select r.id
    from public.staff_survey_responses r
    where r.survey_id = s.id and r.user_id = auth.uid()
      and r.cycle_start = public.staff_survey_current_cycle()
      and r.response = 'pledge' and r.payout_mode is null
    limit 1) cur on true
  where s.active
    and auth.uid() is not null
    and public.staff_survey_is_employee()
    and (cur.id is not null
         or not exists (select 1 from public.staff_survey_responses r
                        where r.survey_id = s.id and r.user_id = auth.uid()
                          and r.cycle_start = public.staff_survey_current_cycle()))
    and (z.snooze_until is null or z.snooze_until <= now())
    and (s.kind <> 'statutory_consent' or public.staff_survey_paye_off())
  order by (cur.id is not null) desc, s.created_at
  limit 1;
$fn$;

create or replace function public.staff_survey_set_payout_mode(_survey_id uuid, _payout_mode text)
returns public.staff_survey_responses
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare v_row public.staff_survey_responses%rowtype;
begin
  if auth.uid() is null then raise exception 'Not signed in.'; end if;
  if _payout_mode not in ('monthly_payout','monthly_compounding') then
    raise exception 'Choose monthly returns or compounding.';
  end if;
  update public.staff_survey_responses
     set payout_mode = _payout_mode
   where survey_id = _survey_id and user_id = auth.uid()
     and cycle_start = public.staff_survey_current_cycle()
     and response = 'pledge' and payout_mode is null
  returning * into v_row;
  if v_row.id is null then
    raise exception 'There is no reinvestment choice waiting for a return option.';
  end if;
  delete from public.staff_survey_snoozes where survey_id = _survey_id and user_id = auth.uid();
  return v_row;
end;
$fn$;

-- HR can clear one person's answer for the current cycle, so they are asked again.
-- The cleared answer is kept in audit_logs.
create or replace function public.staff_survey_reset_answer(_survey_id uuid, _user_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare v_old public.staff_survey_responses%rowtype;
begin
  if auth.uid() is null then raise exception 'Not signed in.'; end if;
  if not (public.hr_is_admin() or public.hr_pay_is_preparer()) then
    raise exception 'Only HR can reset a survey answer.';
  end if;
  delete from public.staff_survey_responses
   where survey_id = _survey_id and user_id = _user_id
     and cycle_start = public.staff_survey_current_cycle()
  returning * into v_old;
  if v_old.id is null then
    raise exception 'That person has no answer to reset in the current cycle.';
  end if;
  delete from public.staff_survey_snoozes where survey_id = _survey_id and user_id = _user_id;
  insert into public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  values (auth.uid(), 'staff_survey_answer_reset', 'staff_survey_responses', v_old.id::text,
          jsonb_build_object('survey_id', _survey_id, 'staff_user_id', _user_id,
                             'cycle_start', v_old.cycle_start, 'response', v_old.response,
                             'percentage', v_old.percentage, 'payout_mode', v_old.payout_mode,
                             'responded_at', v_old.responded_at));
end;
$fn$;

revoke all on function public.staff_survey_pending() from public, anon;
revoke all on function public.staff_survey_set_payout_mode(uuid, text) from public, anon;
revoke all on function public.staff_survey_reset_answer(uuid, uuid) from public, anon;
grant execute on function public.staff_survey_pending() to authenticated;
grant execute on function public.staff_survey_set_payout_mode(uuid, text) to authenticated;
grant execute on function public.staff_survey_reset_answer(uuid, uuid) to authenticated;

commit;
