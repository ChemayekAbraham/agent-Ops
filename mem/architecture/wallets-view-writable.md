---
name: wallets view is writable via INSTEAD OF triggers
description: public.wallets is a view over wallets_physical + v_user_wallet_strict; INSTEAD OF INSERT/UPDATE triggers redirect writes to wallets_physical so legacy edge functions keep working
type: constraint
---
As of 2026-05-12, `public.wallets` is a VIEW (joins `wallets_physical` + `v_user_wallet_strict`). It would normally reject INSERT/UPDATE with `cannot insert into view "wallets"` (SQLSTATE 55000).

Two `INSTEAD OF` triggers make it writable safely:
- `wallets_view_instead_of_insert` → INSERTs go to `wallets_physical (user_id, locked_balance, currency)` with `ON CONFLICT (user_id) DO NOTHING`. Any `balance`/`withdrawable_balance`/`float_balance`/`advance_balance` value in the incoming row is **silently ignored** — those columns are computed from the strict ledger view, never written from cache.
- `wallets_view_instead_of_update` → UPDATEs only touch `locked_balance`, `currency`, `updated_at` on `wallets_physical`. Bucket fields are also ignored.

This preserves the WALLET SOLE WRITER rule (`apply_wallet_movement` is the only function that mutates bucket fields) while letting legacy code paths continue to call `INSERT INTO wallets (user_id, balance) VALUES (..., 0)` to ensure a wallet row exists.

Affected (now-working) call sites:
- `supabase/functions/agent-deposit/index.ts` — `ensureWalletExists`, plus the inline create-wallet branch (was breaking every "Pay rent from Operational Float" with toast `Failed to record agent payment audit trail`).
- `supabase/functions/cfo-direct-credit/index.ts` — first-time wallet creation on CFO direct credit/debit.
- `supabase/functions/import-partners/index.ts` — bulk partner import.
- `supabase/functions/register-proxy-funder/index.ts` — proxy funder registration.

Do NOT migrate these call sites to `wallets_physical` directly — keeping them on the view means future schema moves only need to update the triggers.

GRANTS: `SELECT, INSERT, UPDATE` on `public.wallets` to `authenticated, service_role, anon`. `SELECT, INSERT, UPDATE` on `wallets_physical` to `service_role`.
