# 227 — Two repo migrations were never applied; applied by hand (2026-10-13)

**Status: APPLIED to production 2026-10-13 by hand (same SQL as the migration files). Verified by object, column and grant checks. The SMS balance watch is still not scheduled.**

## Finding
A production check of the migrations that reached `lovable` since 8 Oct found two whose objects did not exist. Lovable's migration tracker (`supabase_migrations.schema_migrations`) stopped at `20260911080102`, so it cannot answer this; check the objects instead (see doc 220 and the "repo migrations diverge from production" note).

| Migration | Objects created | Why it mattered |
|---|---|---|
| `20261008090000_sms_balance_runway_watch` (doc 205) | `sms_balance_alerts` (RLS on, no policies, service role only), `get_sms_balance_runway()` (service_role only) | The `sms-balance-watch` edge function calls the RPC. It could never work. |
| `20261013090000_coo_rent_request_actions` | `coo_approve_rent_request(uuid, text)`, `coo_return_rent_request(uuid, text)`: SECURITY DEFINER, COO or super_admin only, move `partner_ops_approved` to `coo_approved` or return it, both audited | The COO has no UPDATE policy on `rent_requests`, so a direct UPDATE changes zero rows without an error. Nothing in `src` or the edge functions calls the new RPCs yet. |

## Verified after applying
- Every column the COO functions write exists on `rent_requests`, `audit_logs` and `system_events` (plpgsql does not check this at create time).
- `authenticated` can run the COO functions, `anon` cannot; `authenticated` cannot run `get_sms_balance_runway`.
- The COO functions were not called (they change real rent plans and need a logged-in COO).
- `get_sms_balance_runway()` first reading: Yoola balance 0 credits at 14:21 EAT, 3,372 credits used in 24 h, runway 0 hours. Africa's Talking is covering the sends (rescued Yoola attempts are `failover`, doc 220).

## Still open
- **No cron job calls `sms-balance-watch`** (no `cron.job` row mentions it), so no warning email is sent. Schedule it, then check `sms_balance_alerts` fills.
- The Yoola account is empty. Top it up if it should be the primary again.
- Wire the COO RPCs into the COO approval UI (Gemini's lane); until then the COO stage still does the direct UPDATE.
