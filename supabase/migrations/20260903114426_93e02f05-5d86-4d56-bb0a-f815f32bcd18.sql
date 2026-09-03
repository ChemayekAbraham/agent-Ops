begin;

-- Fingerprint. RentFlow only, and step 1 must already be applied.
do $$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema='public' and table_name='user_roles'
                   and column_name='enabled') then
    raise exception 'Wrong database: public.user_roles.enabled not found. This migration belongs to RentFlow.';
  end if;
  if to_regclass('public.hr_pay_arrears') is null then
    raise exception 'public.hr_pay_arrears does not exist. Apply the arrears table migration first.';
  end if;
end $$;

-- 1. Arrears and regular runs must not cross, and an off-cycle run must still
--    agree with its arrears entries before any money moves.
create or replace function public.hr_pay_arrears_run_guard()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_run_type text;
  v_linked   int;
  v_payslips int;
  v_mismatch int;
begin
  if new.event_type not in ('calculated','approved','paid') then
    return new;
  end if;

  select r.run_type into v_run_type
    from public.hr_pay_runs r where r.id = new.run_id;
  if v_run_type is null then
    return new;   -- a missing run is the existing guard's business, not this one
  end if;

  select count(*) into v_linked
    from public.hr_pay_arrears a
   where a.paid_in_run_id = new.run_id and a.status = 'pending';

  -- A regular run never carries arrears.
  if v_run_type <> 'off_cycle' then
    if v_linked > 0 then
      raise exception
        'This is a % run and % arrears entry(ies) are linked to it. Arrears are paid only on an off-cycle run.',
        v_run_type, v_linked;
    end if;
    return new;
  end if;

  -- Off-cycle from here. Reconcile only at the money gates.
  if new.event_type = 'calculated' then
    return new;
  end if;

  select count(*) into v_payslips
    from public.hr_pay_payslips ps
   where ps.run_id = new.run_id and ps.is_current;

  if v_payslips = 0 then
    return new;   -- nothing calculated yet; the state machine owns that
  end if;

  if v_linked = 0 then
    raise exception
      'This off-cycle run has % payslip(s) but no arrears entry is linked to it. Recalculate it from the arrears list before recording a % event.',
      v_payslips, new.event_type;
  end if;

  -- The people on the register and the amounts owed must match exactly.
  select count(*) into v_mismatch
  from (
    select ps.staff_id, ps.gross
      from public.hr_pay_payslips ps
     where ps.run_id = new.run_id and ps.is_current
  ) sl
  full join (
    select ar.staff_id, sum(ar.amount) as owed
      from public.hr_pay_arrears ar
     where ar.paid_in_run_id = new.run_id and ar.status = 'pending'
     group by ar.staff_id
  ) aw on aw.staff_id = sl.staff_id
  where sl.staff_id is null
     or aw.staff_id is null
     or sl.gross is distinct from aw.owed;

  if v_mismatch > 0 then
    raise exception
      'This off-cycle run no longer agrees with its arrears entries: % person(s) differ. An entry was cancelled or changed after the run was calculated. Recalculate the run before recording a % event.',
      v_mismatch, new.event_type;
  end if;

  return new;
end;
$fn$;

drop trigger if exists zz_hr_pay_arrears_run_guard_trg on public.hr_pay_run_events;
create trigger zz_hr_pay_arrears_run_guard_trg
  before insert on public.hr_pay_run_events
  for each row execute function public.hr_pay_arrears_run_guard();

-- 2. Settle on paid; release the link on cancelled. A settled row is never
--    reverted — reopening a run does not un-pay money that has left, and a
--    correction is a new arrears entry.
create or replace function public.hr_pay_arrears_settle()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $fn$
begin
  if new.event_type = 'paid' then
    update public.hr_pay_arrears a
       set status = 'paid'
     where a.paid_in_run_id = new.run_id
       and a.status = 'pending';

  elsif new.event_type = 'cancelled' then
    update public.hr_pay_arrears a
       set paid_in_run_id = null
     where a.paid_in_run_id = new.run_id
       and a.status = 'pending';
  end if;

  return null;
end;
$fn$;

drop trigger if exists zz_hr_pay_arrears_settle_trg on public.hr_pay_run_events;
create trigger zz_hr_pay_arrears_settle_trg
  after insert on public.hr_pay_run_events
  for each row execute function public.hr_pay_arrears_settle();

commit;