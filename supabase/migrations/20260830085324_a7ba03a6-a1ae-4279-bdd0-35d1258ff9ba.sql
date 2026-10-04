alter table public.hr_pay_advances
  add column hr_approved_by uuid,
  add column hr_approved_position_id uuid references public.hr_positions(id),
  add column hr_approved_at timestamptz,
  add column disbursed_by uuid,
  add column disbursed_position_id uuid references public.hr_positions(id),
  add column disbursed_at timestamptz,
  add column recovery_months smallint;

alter table public.hr_pay_advances
  drop constraint hr_pay_advances_status_check;

alter table public.hr_pay_advances
  add constraint hr_pay_advances_status_check check (status = any (array[
    'requested'::text, 'hr_approved'::text, 'ceo_approved'::text,
    'approved'::text, 'rejected'::text, 'settled'::text, 'cancelled'::text]));

alter table public.hr_pay_advances
  add constraint hr_pay_adv_months_ck check (recovery_months is null or recovery_months between 1 and 3);

create policy hr_pay_adv_self_insert on public.hr_pay_advances
  for insert to authenticated
  with check (
    public.hr_my_staff_id() is not null
    and staff_id = public.hr_my_staff_id()
    and status = 'requested'
    and requested_by = auth.uid()
  );

create policy hr_pay_adv_release_update on public.hr_pay_advances
  for update to authenticated
  using (public.hr_pay_is_releaser())
  with check (public.hr_pay_is_releaser());

drop trigger if exists hr_pay_advance_guard_trg on public.hr_pay_advances;

create or replace function public.hr_pay_advance_guard()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
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

create trigger hr_pay_advance_guard_trg
  before update on public.hr_pay_advances
  for each row execute function public.hr_pay_advance_guard();