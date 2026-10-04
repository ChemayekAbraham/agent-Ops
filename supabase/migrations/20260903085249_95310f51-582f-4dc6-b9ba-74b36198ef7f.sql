begin;

-- Fingerprint. RentFlow only: public.user_roles.enabled does not exist in welile.com.
do $$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema='public' and table_name='user_roles'
                   and column_name='enabled') then
    raise exception 'Wrong database: public.user_roles.enabled not found. This migration belongs to RentFlow.';
  end if;
  if not exists (select 1 from public.hr_pay_components where code = 'ARREARS') then
    raise exception 'The ARREARS component is not configured. Apply the arrears component migration first.';
  end if;
end $$;

create table public.hr_pay_arrears (
  id             uuid primary key default gen_random_uuid(),
  staff_id       uuid not null references public.hr_staff(id),
  component_id   uuid not null references public.hr_pay_components(id),
  amount         numeric not null,
  currency       text not null default 'UGX',
  period_owed    text not null,
  basis          text not null,
  status         text not null default 'pending',
  paid_in_run_id uuid references public.hr_pay_runs(id),
  requested_by   uuid not null default auth.uid(),
  requested_at   timestamptz not null default now(),
  created_at     timestamptz not null default now(),
  constraint hr_pay_arrears_amount_ck  check (amount > 0),
  constraint hr_pay_arrears_status_ck  check (status = any (array['pending','paid','cancelled'])),
  constraint hr_pay_arrears_basis_ck   check (length(btrim(basis)) >= 10),
  constraint hr_pay_arrears_period_ck  check (period_owed ~ '^[0-9]{4}-[0-9]{2}$'),
  constraint hr_pay_arrears_paid_ck    check ((status <> 'paid') or (paid_in_run_id is not null))
);

-- One pending amount per person, per component, per period owed.
create unique index hr_pay_arrears_one_pending
  on public.hr_pay_arrears (staff_id, component_id, period_owed)
  where status = 'pending';

create index hr_pay_arrears_pending_lookup
  on public.hr_pay_arrears (status, staff_id) where status = 'pending';

-- Guard: the component must be an active earning, and a settled row is immutable.
create or replace function public.hr_pay_arrears_guard()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare v_kind text; v_active boolean;
begin
  if tg_op = 'INSERT' or new.component_id is distinct from old.component_id then
    select c.kind, c.active into v_kind, v_active
      from public.hr_pay_components c where c.id = new.component_id;
    if v_kind is distinct from 'earning' or v_active is not true then
      raise exception 'Arrears must name an active earning component.';
    end if;
  end if;

  if tg_op = 'UPDATE' then
    if old.status in ('paid','cancelled') then
      raise exception 'A % arrears row is settled and cannot be changed.', old.status;
    end if;
    if new.staff_id  is distinct from old.staff_id
       or new.amount is distinct from old.amount
       or new.period_owed is distinct from old.period_owed then
      if new.status is distinct from 'pending' or old.status is distinct from 'pending' then
        raise exception 'Staff, amount and period cannot change on a row leaving pending. Cancel it and enter a new one.';
      end if;
    end if;
  end if;

  return new;
end;
$fn$;

drop trigger if exists trg_hr_pay_arrears_guard on public.hr_pay_arrears;
create trigger trg_hr_pay_arrears_guard
  before insert or update on public.hr_pay_arrears
  for each row execute function public.hr_pay_arrears_guard();

alter table public.hr_pay_arrears enable row level security;

drop policy if exists hr_pay_arrears_read on public.hr_pay_arrears;
create policy hr_pay_arrears_read on public.hr_pay_arrears
  for select using (
    public.hr_pay_is_rule_reader()
    or public.hr_pay_is_preparer()
    or public.hr_pay_is_approver()
    or public.hr_pay_is_releaser()
    or public.hr_pay_is_own_staff(staff_id)
  );

drop policy if exists hr_pay_arrears_insert on public.hr_pay_arrears;
create policy hr_pay_arrears_insert on public.hr_pay_arrears
  for insert with check (
    public.hr_pay_is_preparer() or public.hr_pay_is_rule_admin()
  );

drop policy if exists hr_pay_arrears_update on public.hr_pay_arrears;
create policy hr_pay_arrears_update on public.hr_pay_arrears
  for update
  using (public.hr_pay_is_preparer() or public.hr_pay_is_rule_admin())
  with check (public.hr_pay_is_preparer() or public.hr_pay_is_rule_admin());

commit;