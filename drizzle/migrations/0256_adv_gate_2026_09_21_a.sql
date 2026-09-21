-- =====================================================================
-- ADV-GATE-2026-09-21-A
-- Staff advance recovery gate, insert guard, and orphan recovery cleanup
-- =====================================================================

-- ---------------------------------------------------------------------
-- STEP 1 (F1a): reclassify legacy advances stranded at 'approved'
-- These predate the four-stage chain. Under the current model 'approved'
-- means released/disbursed, but these four have disbursed_at NULL and
-- disbursed_by NULL — no release ever occurred. Move them to
-- 'ceo_approved', which is where they correctly sit: awaiting release.
-- The guard rejects this direction, so it is disabled for this statement
-- only and re-enabled immediately.
-- ---------------------------------------------------------------------
alter table public.hr_pay_advances disable trigger hr_pay_advance_guard_trg;

update public.hr_pay_advances
set status = 'ceo_approved'
where status = 'approved'
  and disbursed_at is null
  and disbursed_by is null;

alter table public.hr_pay_advances enable trigger hr_pay_advance_guard_trg;

-- ---------------------------------------------------------------------
-- STEP 2 (F1b): gate payroll recovery on actual disbursement
-- Status alone is not a safe proxy for "money left the account".
-- Recovery now requires disbursed_at to be set. Signature unchanged.
-- ---------------------------------------------------------------------
create or replace function public.hr_pay_advance_due(_staff_id uuid, _gross numeric, _run_id uuid)
returns numeric
language sql
stable
security definer
set search_path to 'public'
as $function$
  select coalesce(sum(least(
           case when a.recovery_mode = 'fixed' then a.recovery_value
                else round(_gross * a.recovery_value / 100) end,
           a.principal - coalesce((select sum(r.amount)
                                   from public.hr_pay_advance_recoveries r
                                   join public.hr_pay_runs pr on pr.id = r.run_id
                                   where r.advance_id = a.id
                                     and r.run_id <> _run_id
                                     and pr.status in ('approved','paid')), 0)
         )), 0)
  from public.hr_pay_advances a
  where a.staff_id = _staff_id
    and a.status = 'approved'
    and a.disbursed_at is not null
    and a.first_recovery_on <= current_date
    and a.principal > coalesce((select sum(r.amount)
                                from public.hr_pay_advance_recoveries r
                                join public.hr_pay_runs pr on pr.id = r.run_id
                                where r.advance_id = a.id
                                  and r.run_id <> _run_id
                                  and pr.status in ('approved','paid')), 0);
$function$;

-- ---------------------------------------------------------------------
-- STEP 3 (F2): close the INSERT hole on the guard
-- The guard is currently BEFORE UPDATE only, so a row can be created at
-- any status with any approval stamp. Force every new row to 'requested'
-- with all approval and disbursement stamps cleared, and make the
-- trigger fire on INSERT as well as UPDATE. The UPDATE logic below is
-- unchanged from the live definition.
-- ---------------------------------------------------------------------
create or replace function public.hr_pay_advance_guard()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if tg_op = 'INSERT' then
    new.status                  := 'requested';
    new.hr_approved_by          := null;
    new.hr_approved_position_id := null;
    new.hr_approved_at          := null;
    new.approved_by             := null;
    new.approved_position_id    := null;
    new.approved_at             := null;
    new.disbursed_by            := null;
    new.disbursed_position_id   := null;
    new.disbursed_at            := null;
    new.requested_at            := coalesce(new.requested_at, now());
    return new;
  end if;

  if tg_op = 'UPDATE' then
    if new.principal is distinct from old.principal
    or new.staff_id  is distinct from old.staff_id then
      raise exception 'Advance principal and staff cannot be changed. Cancel and raise a new one.';
    end if;

    if new.status is distinct from old.status then
      if old.status = 'requested' and new.status = 'hr_approved' then
        if not (public.hr_pay_is_preparer() or public.hr_pay_is_rule_admin()) then
          raise exception 'Only the position holding prepare authority may give HR approval to an advance.';
        end if;
        new.hr_approved_by := auth.uid();
        new.hr_approved_position_id := public.hr_pay_position_for('prepare');
        new.hr_approved_at := now();

      elsif old.status = 'hr_approved' and new.status = 'ceo_approved' then
        if not (public.hr_pay_is_approver() or public.hr_pay_is_rule_admin()) then
          raise exception 'Only the position holding approve authority may approve an advance.';
        end if;
        new.approved_by := auth.uid();
        new.approved_position_id := public.hr_pay_position_for('approve');
        new.approved_at := now();

      elsif old.status = 'ceo_approved' and new.status = 'approved' then
        if not (public.hr_pay_is_releaser() or public.hr_pay_is_rule_admin()) then
          raise exception 'Only the position holding release authority may disburse an advance.';
        end if;
        new.disbursed_by := auth.uid();
        new.disbursed_position_id := public.hr_pay_position_for('release');
        new.disbursed_at := now();

      elsif new.status = 'rejected'
        and old.status in ('requested','hr_approved','ceo_approved') then
        if not (public.hr_pay_is_preparer() or public.hr_pay_is_approver()
                or public.hr_pay_is_releaser() or public.hr_pay_is_rule_admin()) then
          raise exception 'You do not hold authority to reject an advance.';
        end if;

      elsif new.status = 'cancelled'
        and old.status in ('requested','hr_approved','ceo_approved') then
        if not (public.hr_pay_is_preparer() or public.hr_pay_is_rule_admin()) then
          raise exception 'Only the position holding prepare authority may cancel an advance.';
        end if;

      elsif old.status = 'approved' and new.status = 'settled' then
        if not (public.hr_pay_is_preparer() or public.hr_pay_is_rule_admin()) then
          raise exception 'Only the position holding prepare authority may settle an advance.';
        end if;

      else
        raise exception 'Illegal advance status transition: % to %.', old.status, new.status;
      end if;
    end if;
  end if;

  return new;
end;
$function$;

drop trigger if exists hr_pay_advance_guard_trg on public.hr_pay_advances;

create trigger hr_pay_advance_guard_trg
before insert or update on public.hr_pay_advances
for each row execute function public.hr_pay_advance_guard();

-- ---------------------------------------------------------------------
-- STEP 4 (F3): remove recovery rows attached to cancelled pay runs
-- These never represented money. hr_pay_advance_due already excludes
-- them arithmetically, but they inflate any direct sum of the table and
-- are the source of the double-count in financial reporting.
-- Recovery rows on approved or paid runs are NOT touched — those are
-- evidence of real deductions and are dealt with separately.
-- ---------------------------------------------------------------------
delete from public.hr_pay_advance_recoveries r
using public.hr_pay_runs pr
where pr.id = r.run_id
  and pr.status = 'cancelled';

-- ---------------------------------------------------------------------
-- STEP 5: assertions. Any failure aborts the whole migration.
-- ---------------------------------------------------------------------
do $$
declare
  v_bad     integer;
  v_orphan  integer;
  v_due     numeric;
  v_ceo     integer;
  v_ins     boolean;
  v_upd     boolean;
begin
  select count(*) into v_bad
  from public.hr_pay_advances
  where status = 'approved' and disbursed_at is null;
  if v_bad <> 0 then
    raise exception 'FAIL A: % advance(s) still at approved with no disbursed_at', v_bad;
  end if;

  select count(*) into v_orphan
  from public.hr_pay_advance_recoveries r
  join public.hr_pay_runs pr on pr.id = r.run_id
  where pr.status = 'cancelled';
  if v_orphan <> 0 then
    raise exception 'FAIL B: % orphan recovery row(s) remain on cancelled runs', v_orphan;
  end if;

  select coalesce(sum(public.hr_pay_advance_due(x.staff_id, 1000000, gen_random_uuid())), 0)
    into v_due
  from (select distinct staff_id
        from public.hr_pay_advances
        where disbursed_at is null) x;
  if v_due <> 0 then
    raise exception 'FAIL C: recovery of % still computed against undisbursed advances', v_due;
  end if;

  select bool_or((t.tgtype & 4) > 0), bool_or((t.tgtype & 16) > 0)
    into v_ins, v_upd
  from pg_trigger t
  join pg_class c on c.oid = t.tgrelid
  where c.relname = 'hr_pay_advances'
    and t.tgname = 'hr_pay_advance_guard_trg'
    and not t.tgisinternal;
  if not coalesce(v_ins,false) or not coalesce(v_upd,false) then
    raise exception 'FAIL D: guard trigger is not firing on both INSERT and UPDATE';
  end if;

  select count(*) into v_ceo
  from public.hr_pay_advances where status = 'ceo_approved';

  raise notice 'ADV-GATE-2026-09-21-A PASSED — % advance(s) now at ceo_approved awaiting release', v_ceo;
end $$;

-- =====================================================================
-- END ADV-GATE-2026-09-21-A
-- =====================================================================