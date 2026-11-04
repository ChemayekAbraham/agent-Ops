-- Hash investor_portfolios.portfolio_pin with bcrypt (pgcrypto). Approved 4 Nov 2026.
-- REQUIRES 20261104241000_portfolio_pin_backup.sql to have run first. This file refuses to hash
-- while any plaintext PIN has no row in private.portfolio_pin_backup_20261104.
-- Writers (create-investor-portfolio, coo-create-portfolio, coo-invest-for-partner, agent-invest-for-partner,
-- import-partners, NewPartnersPanel, ActivePartnersDetail, CreateUserInviteDialog, split/renewal RPCs that copy the pin)
-- keep sending a 4-digit PIN or copying the stored value: the trigger hashes plaintext and leaves existing hashes alone.
-- No live app code compares portfolio_pin to a typed PIN (checked 4 Nov 2026). The one-off
-- `WHERE portfolio_pin = '4891'` statement is a historical migration, not a live function.
-- ROLLBACK: drop trigger trg_hash_portfolio_pin on public.investor_portfolios; drop function public.hash_portfolio_pin();
--   drop function public.verify_portfolio_pin(uuid, text); restore pins from private.portfolio_pin_backup_20261104.

do $$
begin
  if to_regclass('private.portfolio_pin_backup_20261104') is null then
    raise exception 'PIN backup table private.portfolio_pin_backup_20261104 is missing. Apply 20261104241000_portfolio_pin_backup.sql first.';
  end if;
  if exists (
    select 1
    from public.investor_portfolios p
    where p.portfolio_pin is not null
      and p.portfolio_pin !~ '^\$2[aby]\$'
      and not exists (
        select 1 from private.portfolio_pin_backup_20261104 b where b.id = p.id
      )
  ) then
    raise exception 'Refusing to hash portfolio PINs that are not in the backup table.';
  end if;
end $$;

-- A 4-digit check would reject bcrypt. Widen and drop pin-length checks if any exist live.
alter table public.investor_portfolios alter column portfolio_pin type text;

do $$
declare r record;
begin
  for r in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public'
      and rel.relname = 'investor_portfolios'
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%portfolio_pin%'
  loop
    execute format('alter table public.investor_portfolios drop constraint %I', r.conname);
  end loop;
end $$;

create extension if not exists pgcrypto with schema extensions;

create or replace function public.hash_portfolio_pin()
returns trigger language plpgsql security definer set search_path = public, extensions as $$
begin
  if new.portfolio_pin is not null and new.portfolio_pin !~ '^\$2[aby]\$' then
    new.portfolio_pin := extensions.crypt(new.portfolio_pin, extensions.gen_salt('bf', 10));
  end if;
  return new;
end $$;

revoke all on function public.hash_portfolio_pin() from public, anon;
grant execute on function public.hash_portfolio_pin() to authenticated, service_role;

drop trigger if exists trg_hash_portfolio_pin on public.investor_portfolios;
create trigger trg_hash_portfolio_pin before insert or update of portfolio_pin on public.investor_portfolios
  for each row execute function public.hash_portfolio_pin();

-- Hash existing plaintext PINs. Hashes already stored are left unchanged.
update public.investor_portfolios
  set portfolio_pin = extensions.crypt(portfolio_pin, extensions.gen_salt('bf', 10))
  where portfolio_pin is not null and portfolio_pin !~ '^\$2[aby]\$';

-- Verify: the portfolio owner, or the server (service_role). Returns false for everyone else.
create or replace function public.verify_portfolio_pin(p_portfolio_id uuid, p_pin text)
returns boolean language plpgsql stable security definer set search_path = public, extensions as $$
declare v_hash text; v_owner uuid; v_role text;
begin
  select portfolio_pin, investor_id into v_hash, v_owner from public.investor_portfolios where id = p_portfolio_id;
  if v_hash is null or p_pin is null or p_pin !~ '^\d{4}$' then return false; end if;
  v_role := coalesce(current_setting('request.jwt.claim.role', true), '');
  if v_role <> 'service_role' and ((select auth.uid()) is null or (select auth.uid()) <> v_owner) then
    return false;
  end if;
  return extensions.crypt(p_pin, v_hash) = v_hash;
end $$;
revoke all on function public.verify_portfolio_pin(uuid, text) from public, anon;
grant execute on function public.verify_portfolio_pin(uuid, text) to authenticated, service_role;

-- Column privilege. After this migration the column holds only bcrypt hashes.
-- A column-level REVOKE only works after replacing the table-level SELECT grant, which would break
-- select('*') on investor_portfolios. Staff and the portfolio owner can still select the hash.
-- Phase 2, after those calls list columns:
--   revoke select on public.investor_portfolios from anon, authenticated;
--   grant select (<every column except portfolio_pin>) on public.investor_portfolios to authenticated;
