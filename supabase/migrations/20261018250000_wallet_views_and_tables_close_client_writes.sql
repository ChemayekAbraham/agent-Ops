-- 2026-10-18 (doc 247, step 20, stage 1 of wallets): signed-in users could WRITE wallets.
-- `public.wallets` is an owner-rights view over wallets_physical + wallet_balances_projection with INSTEAD OF INSERT/UPDATE triggers
-- (wallets_view_instead_of_insert/update, SECURITY DEFINER) and authenticated held INSERT/UPDATE/DELETE/TRUNCATE on it. The update trigger runs
-- `update wallets_physical set locked_balance = ..., currency = ... where user_id = OLD.user_id` as the owner, so ANY signed-in user could overwrite locked_balance
-- (a DISPLAYED figure: spendable balance is ledger-derived and ignores it; 42 wallets hold one) or currency on any wallet, an integrity problem not a funds release (see doc 247 correction),
-- bypassing the RLS on wallets_physical (which has no UPDATE policy). The browser never writes wallets (grep of src: none); every write is an edge function with the
-- service role (cfo-direct-credit, agent-deposit, approve-deposit, wallet-transfer, ...) or an owner-rights DB function; no caller-rights function writes these relations.
-- Revoked from anon: everything on the four relations. From authenticated: every write/maintenance privilege on wallets and v_user_wallet_strict (views) and on wallets_physical
-- (INSERT stays: RLS policy "Users can create own wallet") and wallet_balances_projection. SELECT for authenticated is unchanged here (read rule = stage 2).
-- service_role keeps full access. Already applied to production 2026-10-18.
revoke all on public.wallets from anon, public;
revoke insert, update, delete, truncate, references, trigger, maintain on public.wallets from authenticated;
revoke all on public.v_user_wallet_strict from anon, public;
revoke insert, update, delete, truncate, references, trigger, maintain on public.v_user_wallet_strict from authenticated;
revoke all on public.wallets_physical from anon, public;
revoke update, delete, truncate, references, trigger, maintain on public.wallets_physical from authenticated;
revoke all on public.wallet_balances_projection from anon, public;
revoke insert, update, delete, truncate, references, trigger, maintain on public.wallet_balances_projection from authenticated;
grant select, insert, update, delete on public.wallets, public.v_user_wallet_strict, public.wallets_physical, public.wallet_balances_projection to service_role;
