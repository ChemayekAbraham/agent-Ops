# 2. Danger Zones — Operations That Destroy Money or Data

Read this before running anything that writes to production. Everything here is either
irreversible or has already caused a real incident.

The ordering principle: **a wrong balance is recoverable, a lost record is not.** Prefer the
operation that adds a compensating entry over the one that edits or removes history, every time.

---

## Kill switches — `treasury_controls`

This table is the master control panel and it is barely documented anywhere else. Each row is a
`control_key` with an `enabled` boolean and an optional `value`. Check it **first** in any
incident: a platform that looks broken may simply be paused.

Live state as at 2026-09-09:

| `control_key` | Enabled | What it does |
|---|---|---|
| `maintenance_mode` | `false` | Locks all user actions and shows `maintenance_message`. **This is the big red button.** |
| `maintenance_message` | `true` | The banner text shown while `maintenance_mode` is on |
| `maintenance_until` | `false` | Optional auto-expiry for maintenance |
| `withdrawals_paused` | `false` | Stops all user withdrawals |
| `advance_withdrawals_paused` | **`true`** | Subtracts advance-locked funds from every available balance — see below |
| `credits_paused` | `false` | Stops crediting wallets |
| `payouts_ui_enabled` | `true` | Gates the payout UI; enforced server-side by `enforce_payouts_ui_flag_on_withdrawals` |
| `strict_mode` | `true` | Global strict financial enforcement |
| `enforce_wallet_lock` | `true` | Blocks direct wallet writes |
| `enforce_cash_guard` | `true` | Solvency guard on cash movements |
| `enforce_roi_coverage` | `true` | Blocks Returns payouts not covered by capital |
| `auto_roi` | `false` | Automatic Returns processing — **currently off** |
| `auto_advances` | `false` | Automatic advance issuance — off |
| `auto_commissions` | `true` | Automatic agent commission posting |
| `auto_salaries` | `false` | Automatic payroll — off |
| `landlord_payout_priority` | `false` | Prioritises landlord payouts in the queue |
| `proxy_payout_priority` | `false` | Prioritises proxy payouts |
| `merchant_float_anchor_date` | `true`, value `2026-08-01` | Cut-off date for merchant float reconciliation |
| `merchant_out_of_pocket_headroom` | `true` | Merchant OOP allowance |

### Rules for touching these

- **`advance_withdrawals_paused = true` is load-bearing right now.** It makes
  `get_user_available_balance` subtract `get_advance_locked_withdrawable(user)`. Turning it off
  immediately raises every affected user's withdrawable balance and lets them withdraw money
  earmarked against an outstanding advance. Do not flip it without the CFO.
- Several `enabled` flags are really "is this setting configured", not "is this feature on" —
  `maintenance_message`, `merchant_float_anchor_date` and `merchant_out_of_pocket_headroom` carry
  their meaning in `value`. Read the consuming code before inferring intent from the boolean.
- Every change is a financial control change. Record who and why.

```sql
-- Always read the current state before changing anything
SELECT control_key, enabled, value, updated_at, updated_by
FROM public.treasury_controls ORDER BY control_key;
```

To pause the platform in an emergency, set `maintenance_mode.enabled = true`. That is the
correct first move when money is moving wrongly and you do not yet know why. **Stopping the
bleeding beats diagnosing while it bleeds.**

---

## Never do these

### 1. Never `UPDATE` or `DELETE` `general_ledger`

Blocked by `trg_prevent_ledger_update` and `trg_prevent_ledger_delete`, and it must stay that
way. 460,457 rows of financial history as at 2026-09-09. Reversals are posted as new rows and
recorded in `voided_ledger_entries` via `void_ledger_entry(p_ledger_id, p_reason)`.

If you find yourself wanting to edit a ledger row, what you actually want is a balanced
correction pair — see [`03-money-invariants.md`](./03-money-invariants.md).

### 2. Never `UPDATE wallets` (or `wallets_physical`)

`wallets` is a **view** over `wallets_physical` and `v_user_wallet_strict`, writable only through
`INSTEAD OF` triggers. `enforce_wallet_ledger_only` blocks direct writes unless the sanctioned
path has set `wallet.sync_authorized`. `apply_wallet_movement` is the sole legitimate writer.

Patching a cache to make a number look right hides the real defect and the drift detectors will
fight you. Fix the ledger; the cache follows.

### 3. Never deploy all edge functions at once

`supabase functions deploy` with no argument deploys **all 342**. Repository state is known to
differ from deployed state — `approve-deposit` once ran defective code for a day while the revert
sat unnoticed in git. A bulk deploy pushes hundreds of unreviewed functions to production in one
action.

`.github/workflows/deploy-edge-function.yml` exists specifically to prevent this: manual trigger
only, one function per run, chosen from a fixed list, with a typed `DEPLOY` confirmation. Extend
its `options` list rather than bypassing it.

### 4. Never run absolute "set float to X" operations

Setting an agent float to an absolute figure **re-credits float that has already been spent**.
Sky Bubbles was over-credited UGX 10,202,000 this way on 2026-08-25 and it has not been corrected.
Use delta/"add" operations unless you have just confirmed the current spent amount.

### 5. Never force sender ID `WELILE` on SMS

It is unregistered; carriers drop the message silently. Omit the sender field so Yoola uses its
registered default.

### 6. Never reintroduce a service worker or client cache-recovery machinery

Deliberately removed. No service worker, no `version.json`, no forced-update system. Chunk load
failures recover with a plain `window.location.reload()`. Re-adding this has broken deploys before.

### 7. Never trust `supabase/migrations/` as a description of production

3,203 migration files that do **not** faithfully reflect the live schema. Verify every column,
function and RPC against the real catalog before relying on it. Branch from `origin/lovable`.

### 8. Never write ledger or wallet state from the frontend

Enforced at build time by `scripts/guard-frontend-ledger-writes.mjs`. Do not work around the
guard. All money movement goes through a SECURITY DEFINER RPC or an edge function.

---

## Destructive RPCs — the loaded weapons

These exist in production and will do exactly what their names say. Confirm the blast radius
before calling any of them, and prefer a dry run where one is offered.

### Account destruction

| RPC | Risk |
|---|---|
| `admin_purge_user_dependencies(p_user_id)` | Removes the user's dependent rows across the schema. **Irreversible.** |
| `admin_purge_table_refs(p_parent_table, p_parent_pk_values[])` | Bulk reference purge. Extremely blunt. |
| `admin_mark_account_purged(p_user_id, p_reason)` | Marks an account purged |
| `admin_soft_delete_account` / `admin_restore_soft_deleted_account` | **Prefer these.** Soft delete is reversible |

Soft delete first, always. Use `/admin/archived-accounts` and `restore-archived-account` to
recover. Hard purge only when a soft delete genuinely cannot satisfy the requirement.

### Wallet cache surgery

| RPC | Risk |
|---|---|
| `admin_reseed_wallet_cache(p_user_id, p_withdrawable, p_balance)` | **Writes absolute figures into the cache.** Same class of bug as "set float to X" |
| `reseed_wallets_to_cached_balance(p_dry_run, p_max_users)` | Mass reseed. **Always run with `p_dry_run => true` first** |
| `reseed_anchored_withdrawable(p_user_id, p_reason)` | Repairs phantom drift (cache above ledger) |
| `reseed_anchored_balance(p_user_id, p_reason)` | Repairs under-cache |
| `rebuild_wallet_projection(p_user_id)` | Rebuilds `wallet_balances_projection` for one user |
| `reconcile_wallet_from_ledger(p_user_id, p_reason)` | The safe default — recomputes from the ledger |

`reconcile_wallet_from_ledger` derives the answer from the ledger. The `reseed_*` and
`admin_reseed_*` functions assert an answer. Reach for the former.

### Money write-downs

| RPC | Risk |
|---|---|
| `apply_layer_a_writedown(p_user_id, p_dry_run)` | Books a loss as `platform_loss_writeoff`. **Has a dry run — use it** |
| `writedown_historical_drift(p_review_id, p_amount, p_reason)` | Writes off drift |
| `post_merchant_evidenced_writedown(...)` / `finops_post_merchant_evidenced_writedown(...)` | Merchant float write-down; requires an evidence note |
| `force_approve_rejected_rent_request(p_request_id, p_reason, p_payout_ref)` | **Overrides a rejection and disburses.** Bypasses the normal approval chain |
| `void_ledger_entry(p_ledger_id, p_reason)` | The correct way to reverse a ledger entry |

### Bulk deletion

`bulk_delete_promissory_notes`, `partner_ops_bulk_delete_proxy_agents`,
`delete_agent_product_holdings`, `delete_welile_home_subscription`,
`agent_delete_rejected_rent_request`, `purge-rejected-listings` (runs daily at `15 2 * * *`).

### Cron-driven pruning — already deleting data on a schedule

These run automatically. If you need historical data for an investigation, **pull it before the
window closes**; retention is roughly 7 days under the lean-DB policy.

`prune-cron-job-run-details`, `prune-net-http-response`, `prune-sms-delivery-log`,
`prune-withdrawal-notification-log`, `prune-client-error-reports`, `prune-deposit-decision-audit`,
`purge_login_phase_events`, `purge_geo_coverage_cache`, `cleanup_expired_otps`,
`cleanup_old_otps`, `cleanup_mcp_public_rate_limits`.

---

## The build guards — do not disable them

`npm run guard:all` runs seven guards via `scripts/run-guards.mjs`; any failure blocks the build.
Each one encodes an incident that already happened.

| Guard | Prevents |
|---|---|
| `check-runtime-env.mjs` | Shipping a bundle with missing environment variables |
| `guard-schema-types.mjs` | Un-reviewed schema drift reaching the client |
| `guard-frontend-ledger-writes.mjs` | The browser writing `wallets` / `general_ledger` |
| `guard-deposit-purpose.mjs` | Raw/empty `deposit_purpose` writes bypassing `safeDepositPurpose(...)` |
| `guard-legacy-domain.mjs` | Shipping a reference to a dead domain |
| `guard-location-freetext.mjs` | Free-text Ugandan admin locations instead of the dataset pickers |
| `guard-canonical-tags.mjs` | Missing/incorrect `<link rel="canonical">` on public routes |

`guard-persona-routes.mjs` is a standalone check (`npm run guard:persona-routes`) and is **not**
part of `guard:all`, despite what `README.md` says. There is no `guard-mcp-deploy.mjs` in
`scripts/` either — that README row is stale.

If a guard blocks you, fix the violation. Do not delete the guard.

---

## Regulatory language — a compliance control, not a style preference

Mandatory in all user-facing copy, including SMS, email and edge-function strings:

| Use | Never use |
|---|---|
| **Rent Plan** | loan, lending |
| **Supporter** | lender, investor |
| **Returns** | ROI, interest, yield, APR |

Welile is not a bank, lender, deposit-taker or SACCO. Getting this wrong is a regulatory
exposure with BOU/CMA, not a copy nit.
