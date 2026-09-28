begin;

-- Fingerprint. RentFlow only: public.user_roles.enabled does not exist in welile.com.
do $$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema='public' and table_name='user_roles'
                   and column_name='enabled') then
    raise exception 'Wrong database: public.user_roles.enabled not found. This migration belongs to RentFlow.';
  end if;
  if not exists (select 1 from pg_policies
                 where schemaname='public' and tablename='hr_staff' and policyname='hr_staff_read') then
    raise exception 'Policy hr_staff_read not found on public.hr_staff.';
  end if;
end $$;

-- The payroll release screen names each person by reading hr_staff alongside
-- their payslip. The CFO could read only the staff she manages, so everyone
-- outside Finance showed as a blank row with an amount, and a batch could not
-- be chosen by name. The position holding release authority may now read
-- hr_staff. The four existing conditions are unchanged.
alter policy hr_staff_read on public.hr_staff
  using (
    (id = public.hr_my_staff_id())
    or public.hr_manages(id)
    or public.hr_is_admin()
    or public.hr_is_executive()
    or public.hr_pay_is_releaser()
  );

commit;
