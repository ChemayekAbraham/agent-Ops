-- Partial expression index for the "already credited" TID check in
-- public.auto_create_deposits_from_gmail_impl(integer).
--
-- The live predicate (unchanged; this migration alters no function) is:
--   gl.category in ('wallet_deposit', 'partner_funding', 'agent_float_deposit')
--   and public.normalize_momo_tid(gl.sub_category) = v_norm_tid
-- public.normalize_momo_tid(text) is IMMUTABLE, so the expression is indexable.
-- The WHERE list is the same three literals, in the same order, as that predicate,
-- so the planner can use this partial index.
--
-- Version 20261105130001. 20261105100000 collided with
-- agent_profile_360_funded_plans_only, and 20261105130000 is already
-- assistant_partner_hide_corrections on lovable. This prefix is unused on
-- this branch, on lovable, and in schema_migrations (latest live version
-- 20261105122554).
--
-- LIVE APPLY: do not run this file's statement on production inside a migration
-- transaction. general_ledger is 1.3 GB / 826k rows. Apply as a single
-- CREATE INDEX CONCURRENTLY outside a transaction (not apply_migration):
--
--   create index concurrently if not exists idx_general_ledger_deposit_momo_tid_norm
--     on public.general_ledger (public.normalize_momo_tid(sub_category))
--     where category in ('wallet_deposit','partner_funding','agent_float_deposit');
--
-- The partial index covers only those three categories (~27.5k rows).
-- CONCURRENTLY cannot run inside a transaction; this file is the repo record
-- and therefore uses plain CREATE INDEX IF NOT EXISTS.

create index if not exists idx_general_ledger_deposit_momo_tid_norm
  on public.general_ledger (public.normalize_momo_tid(sub_category))
  where category in ('wallet_deposit','partner_funding','agent_float_deposit');
