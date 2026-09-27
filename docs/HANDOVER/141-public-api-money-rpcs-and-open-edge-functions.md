# 141 — Security: internal money RPCs and open edge functions were callable by anyone

**Status (2026-09-27): committed, NOT applied.** Needs migration
`20260927180000_lock_down_internal_money_rpcs.sql` applied **together with** a frontend
deploy (four components switch RPC names), plus a deploy of six edge functions:
`send-push-notification`, `viewing-confirmation-sms`, `process-monthly-rewards`,
`check-repayment-status`, `payment-reminder`, `process-investment-interest`.

## The question (Josh, 2026-09-27)
"An attack on the codebase: what will it cause in production? I want to be secure."

## What was exposed (verified against production, read-only, 2026-09-27)
The web bundle ships the public anon key, so "needs the anon key" means "anyone on the internet".

### 1. Critical: minting wallet money over the REST API
`ALTER DEFAULT PRIVILEGES` grants EXECUTE on every new `public` function to `anon` and
`authenticated`. 1,689 SECURITY DEFINER functions are executable by `anon`. About 50 of them
move money and have no `auth.uid()`/`has_role()` check. Examples:

| Function | What an anonymous caller could do |
|---|---|
| `create_ledger_transaction(entries, key, skip_balance_check)` | Post a balanced `platform cash_out` / `wallet cash_in` pair to their own wallet, which **mints withdrawable balance**. The `trg_enforce_ledger_rpc_only` guard doesn't help, because this function is what sets `ledger.authorized`. |
| `credit_agent_event_bonus(agent, 'service_centre_setup', _, <new id>)` | UGX 25,000 to any agent, repeatable with fresh source ids |
| `welile_home_record_collection(sub, amt, 'tenant_wallet')` | Debit any Welile Homes tenant's wallet |
| `welile_home_run_landlord_payouts`, `pay_partner_self_cycles`, `auto_dispatch_withdrawals`, `merge_paidout_topups`, `restate_*_receivables` | Run payout, dispatch or restatement batches on demand, out of schedule |
| `credit_agent_rent_commission`, `credit_proxy_approval`, `credit_recruiter_override`, `post_instalment_waterfall`, `apply_portfolio_redemption`… | Credit commissions or redeem/renew portfolios for arbitrary ids |

`scripts/guard-frontend-ledger-writes.mjs` only checks frontend code. It can't see database grants.

### 2. High: open messaging endpoints (`verify_jwt = false`, no check in code)
* `send-push-notification`: `{ all: true, payload: { title, body, url } }` pushed any text and
  **any external link** to every Welile device. That's a ready-made phishing channel ("Your wallet is
  locked, tap to verify").
* `viewing-confirmation-sms`: sent "… - Welile" SMS with attacker-chosen text to any phone
  number at Welile's cost. That's an SMS phishing relay and a cost-drain.
* `payment-reminder`, `check-repayment-status`: SMS/push every active tenant on demand.

### 3. Medium: cron-driven edge functions are anonymously triggerable
~95 `cron.job` rows call their edge function with the **anon** JWT, so the scheduler and an attacker
look identical. `verify_jwt = true` doesn't help, because the anon key is a valid JWT. Money jobs in
that list (`process-supporter-roi`, `process-agent-advance-deductions`, `auto-charge-wallets`,
`pay-landlord-rent`, `process-scheduled-payouts`, `lending-auto-deduct`, `redispatch-withdrawals`, …)
can be run early or repeatedly. The damage depends on each job's idempotency. Concurrent runs of a
check-then-pay job can double-pay. **Not fixed here.** See "Next step" below.

### What was fine
RLS is enabled on every `public` table except `tenant_ops_weekly_metrics` (no anon/auth grants).
`USING (true)` policies are all on reference data or insert-only telemetry. No real secrets are
committed. The only JWT in the repo is the anon key.

## What changed
**Migration `20260927180000`**
* `REVOKE EXECUTE … FROM PUBLIC, anon, authenticated` on ~50 internal ledger/wallet/payout
  signatures, with an explicit `GRANT … TO service_role`. Edge functions all call these with the
  service-role client, all 198 cron jobs run as `postgres`, and nested calls from SECURITY DEFINER
  functions run as the owner, so none of them are affected.
* `mature_bonus_by_subject` and `mature_referral_bonuses_for_invitee`: revoked from `anon` only. They're
  called by SECURITY INVOKER triggers on writes made by signed-in users.
* Four role-gated wrappers for the only frontend callers:

| Wrapper | Allowed | Frontend |
|---|---|---|
| `staff_create_ledger_transaction(entries, key)` | coo, ceo, cfo, cto, manager, super_admin, partner_ops. Balance check can't be skipped | `COOPartnersPage.tsx` (3 call sites) |
| `staff_credit_agent_event_bonus(...)` | cfo, coo, ceo, cto, super_admin, manager, financial_ops, agent_ops | `ServiceCentrePayoutApproval.tsx` |
| `staff_welile_home_run_landlord_payouts(p_as_of)` | tenant/landlord ops, operations, execs. `p_as_of` clamped to today | `WelileHomesAdminPanel.tsx` |
| `agent_welile_home_record_collection(...)` | the subscription's own `agent_id`, or ops/exec staff | `AgentWelileHomesSheet.tsx` |

* `guard:function-grants` now protects 25 more function names from being re-granted or silently
  re-opened by a `DROP FUNCTION` + `CREATE`.

**Edge functions** (new `_shared/callerAuth.ts`: exact service-key match with timing-safe
compare, and Supabase-Auth-verified user + enabled roles)
* `send-push-notification`: service key or a signed-in user. `all: true` is staff-only. Non-staff callers
  are limited to 50 recipients. `url` must be an in-app path or `https://*.welile.com` /
  `https://*.welileapp.com`, otherwise it's replaced with `/`.
* `viewing-confirmation-sms`: staff only.
* `process-monthly-rewards`: service key or staff (Manager Access trigger keeps working).
* `check-repayment-status`, `payment-reminder`, `process-investment-interest`: service key only
  (no scheduler or UI calls them. `investment_accounts` no longer exists, so the last one only errors).

## Verification done
* Migration applied twice (idempotent) to a scratch Postgres 16 with production-shaped stubs:
  anon/authenticated denied on every internal function, service_role keeps EXECUTE, COO passes
  `staff_create_ledger_transaction`, agent/disabled-CFO refused, owning agent passes
  `agent_welile_home_record_collection` and other users are refused, and `authenticated` can still reach
  `mature_bonus_by_subject` through the trigger path.
* `callerAuth.ts` unit-checked (service key, anon key, prefix, missing header, role resolution).
* `npm run guard:all` passes.

## After applying, confirm in production
```sql
select p.oid::regprocedure from pg_proc p
where p.pronamespace = 'public'::regnamespace
  and p.proname in ('create_ledger_transaction','credit_agent_event_bonus','welile_home_record_collection')
  and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE'));
-- expect 0 rows
```

## Next step (not done): authenticate the cron → edge-function calls
1. Store a random secret in Vault (`cron_secret`) **and** as the edge secret `CRON_SECRET`.
2. Rewrite the ~95 `cron.job` commands to send `x-cron-secret` read from Vault.
3. Make the cron-only money functions require `isServiceRoleRequest(req)` or a matching
   `x-cron-secret`. Enforce only after step 2 is live, or the schedule breaks.

Also still open: the five DB triggers that call `send-push-notification`
(`notify_new_chat_message`, `notify_withdrawal_status_change`, …) build their URL and key from
`app.settings.supabase_url` / `app.settings.service_role_key`, which aren't set in production, so
those pushes never send (before and after this change).
