begin;

-- Fingerprint. RentFlow only: public.user_roles.enabled does not exist in welile.com.
do $$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema='public' and table_name='user_roles'
                   and column_name='enabled') then
    raise exception 'Wrong database: public.user_roles.enabled not found. This migration belongs to RentFlow.';
  end if;
end $$;

insert into public.hr_pay_components
  (code, name, kind, taxable, nssf_able, lst_able, is_statutory,
   calc_method, display_order, active, notes)
values
  ('ARREARS', 'Salary Arrears', 'earning', true, true, true, false,
   'fixed', 16, true,
   'Salary owed for an earlier period, paid in a later run. Taxable, pensionable and LST-able on the same basis as BASIC. Always entered with a bounded effective_from/effective_to so it cannot repeat.')
on conflict (code) do nothing;

commit;