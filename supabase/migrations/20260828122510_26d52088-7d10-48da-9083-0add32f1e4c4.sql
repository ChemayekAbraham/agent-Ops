begin;

-- Fingerprint. RentFlow only: public.user_roles.enabled does not exist in welile.com.

do $$

begin

  if not exists (select 1 from information_schema.columns

                 where table_schema='public' and table_name='user_roles'

                   and column_name='enabled') then

    raise exception 'Wrong database: public.user_roles.enabled not found. This migration belongs to RentFlow.';

  end if;

  if not exists (select 1 from information_schema.columns

                 where table_schema='public' and table_name='hr_staff'

                   and column_name='ended_on') then

    raise exception 'hr_staff.ended_on not found. The exit-columns migration must be applied first.';

  end if;

end $$;

-- 1. Role revocation drives the single payroll population gate (hr_staff.active).

create or replace function public.hr_staff_follow_employee_role()

returns trigger

language plpgsql

security definer

set search_path to 'public'

as $fn$

declare v_reason text := 'Employee platform role revoked on '

                         || to_char(current_date,'YYYY-MM-DD')

                         || ' - automatic payroll exclusion';

begin

  if tg_op = 'INSERT' then

    if new.role <> 'employee' or not new.enabled then return new; end if;

    update public.hr_staff s

       set active = true, ended_on = null, exit_reason = null

     where s.user_id = new.user_id and s.active = false

       and s.exit_reason like 'Employee platform role revoked%';

    return new;

  elsif tg_op = 'UPDATE' then

    if new.role <> 'employee' then return new; end if;

    if old.enabled and not new.enabled then

      update public.hr_staff s

         set active = false, ended_on = current_date, exit_reason = v_reason

       where s.user_id = new.user_id and s.active;

    elsif new.enabled and not old.enabled then

      update public.hr_staff s

         set active = true, ended_on = null, exit_reason = null

       where s.user_id = new.user_id and s.active = false

         and s.exit_reason like 'Employee platform role revoked%';

    end if;

    return new;

  else

    if old.role <> 'employee' or not old.enabled then return old; end if;

    update public.hr_staff s

       set active = false, ended_on = current_date, exit_reason = v_reason

     where s.user_id = old.user_id and s.active;

    return old;

  end if;

end;

$fn$;

drop trigger if exists trg_hr_staff_follow_employee_role on public.user_roles;

create trigger trg_hr_staff_follow_employee_role

  after insert or update or delete on public.user_roles

  for each row execute function public.hr_staff_follow_employee_role();

-- 2. Release guard. A run calculated before the revocation still holds the payslip,

--    and no hr_pay_ row may be deleted, so block the money event instead.

create or replace function public.hr_pay_run_event_guard()

returns trigger

language plpgsql

security definer

set search_path to 'public'

as $fn$

declare v_missing int;

        v_status text;

        v_norole int;

begin

  -- NEW

  if new.event_type in ('approved','paid') then

    select count(*) into v_norole

    from public.hr_pay_payslips ps

    join public.hr_staff s on s.id = ps.staff_id

    where ps.run_id = new.run_id and ps.is_current and s.user_id is not null

      and not exists (select 1 from public.user_roles r

                      where r.user_id = s.user_id and r.role = 'employee' and r.enabled);

    if v_norole > 0 then

      raise exception

        'Cannot record a % event: % payslip(s) belong to staff whose employee platform role has been revoked. Recalculate the run so they leave the register.',

        new.event_type, v_norole;

    end if;

  end if;

  -- END NEW

  if new.event_type in ('created','calculated','submitted') then

    if not (public.hr_pay_is_preparer() or public.hr_pay_is_rule_admin()) then

      raise exception 'Only the position holding prepare authority may record a % event.', new.event_type;

    end if;

    new.actor_position_id := public.hr_pay_position_for('prepare');

  elsif new.event_type in ('returned','approved') then

    if not (public.hr_pay_is_approver() or public.hr_pay_is_rule_admin()) then

      raise exception 'Only the position holding approve authority may record a % event.', new.event_type;

    end if;

    new.actor_position_id := public.hr_pay_position_for('approve');

  elsif new.event_type in ('paid','locked') then

    if not (public.hr_pay_is_releaser() or public.hr_pay_is_approver()

            or public.hr_pay_is_rule_admin()) then

      raise exception 'Only the position holding release authority may record a % event.', new.event_type;

    end if;

    new.actor_position_id := public.hr_pay_position_for('release');

    if new.event_type = 'paid' then

      select count(*) into v_missing

      from public.hr_pay_payslips ps

      where ps.run_id = new.run_id and ps.is_current and ps.net > 0

        and not exists (select 1 from public.hr_pay_disbursements d

                        where d.payslip_id = ps.id and d.status = 'posted');

      if v_missing > 0 then

        raise exception

          'Cannot mark this run paid: % payslip(s) have no posted disbursement. Resolve or retry them first.', v_missing;

      end if;

    end if;

  elsif new.event_type = 'cancelled' then

    if not (public.hr_pay_is_preparer() or public.hr_pay_is_rule_admin()) then

      raise exception 'Only the position holding prepare authority may record a cancelled event.';

    end if;

    new.actor_position_id := public.hr_pay_position_for('prepare');

    select r.status into v_status from public.hr_pay_runs r where r.id = new.run_id;

    if not found then

      raise exception 'Cannot cancel: no pay run exists with id %.', new.run_id;

    end if;

    if v_status not in ('draft','calculated','in_review','returned') then

      raise exception

        'A run in status % cannot be cancelled. An approved run has to be returned before it can be cancelled, and paid and locked runs are settled money correctable only by an adjustment run.', v_status;

    end if;

    if length(btrim(coalesce(new.note, ''))) < 10 then

      raise exception 'A cancellation requires a written basis of at least 10 characters.';

    end if;

  elsif new.event_type = 'reversed' then

    raise exception

      'Reversal is not implemented: no status transition exists for a reversed event, and recording one would leave a misleading event trail against an unchanged run.';

  end if;

  return new;

end;

$fn$;

-- 3. Make it visible on screen before anyone tries to approve. Settled runs are

--    excluded so history is not retro-flagged.

create or replace function public.hr_pay_exceptions(_run_id uuid)

returns table(severity text, staff_ref text, issue text, detail text)

language sql

stable

security definer

set search_path to 'public'

as $fn$

  select 'BLOCK', s.staff_ref::text, 'Negative net pay',

         'Net is ' || ps.net::text

  from public.hr_pay_payslips ps join public.hr_staff s on s.id = ps.staff_id

  where ps.run_id = _run_id and ps.is_current and ps.net < 0

  union all

  select 'REVIEW', s.staff_ref::text, 'Zero net pay',

         'Staff member is on the run but is not payable for this period. Confirm the reason before approval.'

  from public.hr_pay_payslips ps join public.hr_staff s on s.id = ps.staff_id

  where ps.run_id = _run_id and ps.is_current and ps.net = 0

  union all

  select 'BLOCK', s.staff_ref::text, 'No linked user account',

         'Cannot be paid - no wallet can be resolved'

  from public.hr_pay_payslips ps join public.hr_staff s on s.id = ps.staff_id

  where ps.run_id = _run_id and ps.is_current and s.user_id is null

  union all

  -- NEW

  select 'BLOCK', s.staff_ref::text, 'Employee platform role revoked',

         'On the register but no longer holds an enabled employee role. Recalculate the run to drop them.'

  from public.hr_pay_payslips ps

  join public.hr_staff s on s.id = ps.staff_id

  join public.hr_pay_runs run on run.id = ps.run_id

  where ps.run_id = _run_id and ps.is_current and s.user_id is not null

    and run.status not in ('paid','locked','cancelled')

    and not exists (select 1 from public.user_roles r

                    where r.user_id = s.user_id and r.role = 'employee' and r.enabled)

  union all

  -- END NEW

  select 'REVIEW', s.staff_ref::text, 'No live assignment',

         'Nobody owns this staff member in the org chart'

  from public.hr_pay_payslips ps join public.hr_staff s on s.id = ps.staff_id

  where ps.run_id = _run_id and ps.is_current

    and not exists (select 1 from public.hr_assignments a

                    where a.staff_id = s.id and a.started_on <= current_date

                      and (a.ended_on is null or a.ended_on >= current_date))

  union all

  select 'REVIEW', s.staff_ref::text, 'Pay outside grade band',

         'Gross ' || ps.gross::text || ' against band ' || g.code

  from public.hr_pay_payslips ps

  join public.hr_staff s on s.id = ps.staff_id

  join public.hr_pay_compensation c on c.staff_id = s.id and c.grade_id is not null

  join public.hr_pay_grades g on g.id = c.grade_id

  where ps.run_id = _run_id and ps.is_current

    and (ps.gross < g.band_min or ps.gross > g.band_max)

  union all

  select 'REVIEW', s.staff_ref::text, 'Missing statutory identifier',

         trim(case when si.tin is null then 'TIN ' else '' end ||

              case when si.nssf_number is null then 'NSSF ' else '' end ||

              case when si.lst_district is null then 'LST district' else '' end)

  from public.hr_pay_payslips ps

  join public.hr_staff s on s.id = ps.staff_id

  left join public.hr_pay_statutory_ids si on si.staff_id = s.id

  where ps.run_id = _run_id and ps.is_current

    and (si.id is null or si.tin is null or si.nssf_number is null or si.lst_district is null)

  union all

  select 'REVIEW', s.staff_ref::text, 'Duplicate wallet account',

         'Another staff member shares this user account'

  from public.hr_pay_payslips ps join public.hr_staff s on s.id = ps.staff_id

  where ps.run_id = _run_id and ps.is_current and s.user_id is not null

    and (select count(*) from public.hr_staff h where h.user_id = s.user_id and h.active) > 1

  union all

  select 'INFO', s.staff_ref::text, 'Statutory item switched off',

         'PAYE ' || sp.paye_applicable::text || ' - NSSF ' || sp.nssf_applicable::text ||

         ' - LST ' || sp.lst_applicable::text || ' - basis: ' || coalesce(sp.exemption_basis,'none')

  from public.hr_pay_payslips ps

  join public.hr_staff s on s.id = ps.staff_id

  join public.hr_pay_statutory_profiles sp on sp.staff_id = s.id and sp.effective_to is null

  where ps.run_id = _run_id and ps.is_current

    and not (sp.paye_applicable and sp.nssf_applicable and sp.lst_applicable)

  order by 1, 2;

$fn$;

-- 4. Backfill: active staff whose employee role is already revoked. Exactly 2 rows.

update public.hr_staff s

   set active = false,

       ended_on = current_date,

       exit_reason = 'Employee platform role revoked on '

                     || to_char(current_date,'YYYY-MM-DD')

                     || ' - automatic payroll exclusion (backfill)'

 where s.active and s.user_id is not null

   and not exists (select 1 from public.user_roles r

                   where r.user_id = s.user_id and r.role = 'employee' and r.enabled);

commit;