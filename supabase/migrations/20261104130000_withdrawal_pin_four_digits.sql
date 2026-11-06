-- Withdrawal PIN is 4 digits, not 6 (CTO, 2026-11-04). Follow-up to 20261104090100_withdrawal_pin.sql.
--
-- Only the PIN changes. The reset codes sent by SMS or email stay 6 digits.
-- Safe to apply only while no PIN exists (a stored 6-digit PIN could no longer be typed): it checks that first.
-- With 4 digits there are 10,000 combinations; the defence is still the lockout (5 tries, then 30 minutes) plus bcrypt.
set local lock_timeout = '5s';

do $$
begin
  if exists (select 1 from public.user_withdrawal_pins) then
    raise exception 'Refusing to switch to 4-digit PINs: % PIN(s) already exist', (select count(*) from public.user_withdrawal_pins);
  end if;
end $$;

create or replace function public.withdrawal_pin_format_ok(p text)
returns boolean
language sql
immutable
set search_path = public
as $$
  select coalesce(p, '') ~ '^[0-9]{4}$'
     and p !~ '^([0-9])\1{3}$'                                         -- 0000, 1111 ...
     and p not in ('0123', '1234', '2345', '3456', '4567', '5678', '6789',
                   '3210', '4321', '5432', '6543', '7654', '8765', '9876');
$$;

-- The three functions that carry the PIN length or its wording in their bodies are rewritten from their live
-- definitions, so nothing else in them can drift from what is deployed. Grants survive CREATE OR REPLACE.
do $$
declare
  r record;
  d text;
begin
  for r in
    select p.oid, p.proname
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('verify_withdrawal_pin', 'set_withdrawal_pin', 'pin_reset_complete')
  loop
    d := pg_get_functiondef(r.oid);
    d := replace(d, '^[0-9]{6}$', '^[0-9]{4}$');
    d := replace(d, 'Enter your 6-digit PIN.', 'Enter your 4-digit PIN.');
    d := replace(d, 'Choose 6 digits that are not all the same and not a run like 123456.',
                    'Choose 4 digits that are not all the same and not a run like 1234.');
    execute d;
  end loop;
end $$;
