-- Private backup of investor_portfolios.portfolio_pin BEFORE any hashing.
-- Apply this migration, and confirm the backup table has a row per plaintext PIN,
-- before applying 20261104242000_hash_portfolio_pin.sql.
-- Bcrypt is one-way. This table is the only rollback copy.
-- Readable by the database owner in the SQL editor. Not granted to anon, authenticated, or service_role.
-- Rollback after a successful hash is: restore from this table, then drop the backup when the CTO says so.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table if not exists private.portfolio_pin_backup_20261104 (
  id uuid primary key,
  portfolio_pin text not null,
  backed_up_at timestamptz not null default now()
);

insert into private.portfolio_pin_backup_20261104 (id, portfolio_pin)
select p.id, p.portfolio_pin
from public.investor_portfolios p
where p.portfolio_pin is not null
  and p.portfolio_pin !~ '^\$2[aby]\$'
on conflict (id) do nothing;

revoke all on table private.portfolio_pin_backup_20261104 from public, anon, authenticated, service_role;
alter table private.portfolio_pin_backup_20261104 enable row level security;
