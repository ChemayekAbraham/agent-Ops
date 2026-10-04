# 3. Money Invariants — The Financial Contract

This is the part of the system where a mistake costs real money belonging to real people. If you
read only one document in this folder, read this one.

All figures verified against production on 2026-09-09: **460,457 ledger rows**, **215,482
transaction groups**, **62,098 auth users**.

---

## The five invariants

1. **`general_ledger` is the single source of truth.** Append-only, double-entry, grouped.
2. **Wallets are a cache.** Never authoritative, never directly updated.
3. **Every write goes through `create_ledger_transaction`.** Enforced by
   `trg_enforce_ledger_rpc_only` and `trg_guard_ledger_write`.
4. **Every transaction group balances.** `sum(cash_in) = sum(cash_out)` per
   `transaction_group_id`, enforced by `trg_enforce_ledger_group_balance`.
5. **Categories are allowlisted.** 120 of them, from `ledger_category_allowlist()`. An invented
   category raises rather than posting.

Corollary, and the reason the system is recoverable at all: **you fix money with a new balanced
entry, never by editing an old one.**

---

## Is the ledger healthy right now

Run this first in any financial incident.

```sql
-- Multi-leg groups that do not balance. This number must be ZERO.
WITH g AS (
  SELECT transaction_group_id, count(*) AS legs,
         SUM(CASE WHEN direction IN ('cash_in','credit') THEN amount ELSE -amount END) AS net
  FROM public.general_ledger
  WHERE classification = 'production'
    AND created_at >= now() - interval '30 days'
  GROUP BY transaction_group_id
)
SELECT count(*)                                        AS groups_30d,
       count(*) FILTER (WHERE abs(net) > 0.005 AND legs > 1) AS unbalanced_multileg,  -- must be 0
       count(*) FILTER (WHERE abs(net) > 0.005 AND legs = 1) AS single_leg_groups     -- expect some
FROM g;
```

**Baseline reading on 2026-09-09:** 32,734 groups in the last 30 days, **0 unbalanced multi-leg
groups**, 953 single-leg groups.

### How to read that result

- `unbalanced_multileg > 0` is a **real emergency**. The balance trigger has been bypassed or
  disabled. Stop writes (`maintenance_mode`), find the posting path, do not "fix" the rows.
- `single_leg_groups` is expected and is *not* by itself evidence of missing money. Historic and
  some current postings put the two sides of a movement under different `transaction_group_id`s.
  Over all time this produces ~10,298 single-leg groups netting about UGX −482M, dominated by
  pre-enforcement history (6,350 of them in February 2026 alone) plus `system_balance_correction`
  legs. A worked example: `wallet_deposit` cash_in (wallet scope) and `wallet_deposit` cash_out
  (platform scope) both total exactly UGX 205,782,392 — they *are* paired, just not grouped.
- Treat the all-time figure as a **data-quality backlog to reconcile with the CFO**, not as a
  live hole. The live signal is the 30-day multi-leg count.

Then check the purpose-built detectors, which are what Ops actually watches:

```sql
SELECT * FROM public.ledger_group_imbalance_alerts ORDER BY created_at DESC LIMIT 50;
SELECT * FROM public.phantom_wallet_drift          ORDER BY created_at DESC LIMIT 50;
SELECT * FROM public.wallet_routing_violations     ORDER BY created_at DESC LIMIT 50;
SELECT * FROM public.wallet_unrouted_movements     ORDER BY created_at DESC LIMIT 50;
SELECT * FROM public.wallet_overdraw_events        ORDER BY created_at DESC LIMIT 50;
```

---

## `create_ledger_transaction` — the only door

Signature: `create_ledger_transaction(entries jsonb, idempotency_key text, skip_balance_check boolean)`.
SECURITY DEFINER, `search_path = public`. Returns the `transaction_group_id`.

What it does, in order:

1. Rejects `entries` that is not a JSON array.
2. Sets `ledger.authorized = true` for the transaction — this is the session flag the ledger
   guard triggers check. **This is why you cannot insert into `general_ledger` directly.**
3. If an `idempotency_key` is supplied: takes `pg_advisory_xact_lock(hashtext(key))`, then returns
   the existing group id if that key was already used. **This is the replay protection for every
   cron job.**
4. Validates every entry: amount > 0, direction is `cash_in` or `cash_out`.
5. For advance-recovery categories (`agent_repayment`, `agent_advance_repayment`,
   `salary_advance_repayment`, `debt_recovery`) on a wallet leg, requires an explicit
   `recipient_type` and calls `assert_routing_compatible`. Violations are recorded in
   `wallet_routing_violations` before raising.
6. Resolves the effective bucket the same way the BEFORE INSERT trigger will: explicit
   `wallet_bucket` wins, else `operational_wallet` → float, `user` → withdrawable.
7. Runs the **solvency check** on withdrawable cash_out legs (unless `skip_balance_check`).
8. Rejects the whole call if `total_cash_in <> total_cash_out`.
9. Inserts every leg under one generated `transaction_group_id`.

### The solvency check, verbatim

This is the calculation that decides whether a debit is allowed. It must stay in lockstep with
`get_user_available_balance` — **if they diverge, credits become phantom.**

```sql
v_user_balance := GREATEST(0,
  LEAST(COALESCE(v_cached_withdrawable, 0), GREATEST(0, COALESCE(v_user_balance, 0)))
);

IF v_user_balance < (v_entry->>'amount')::numeric THEN
  RAISE EXCEPTION 'Insufficient ledger balance for user %. Available: %, Required: %',
    v_entry->>'user_id', v_user_balance, v_entry->>'amount';
END IF;
```

The ledger-side net is computed from `general_ledger` since the user's
`wallet_fresh_start_anchors.anchor_at`, splitting rows into category-routed
(`wallet_route_for_category`, where `wallet_bucket IS NULL`) and explicitly-bucketed. The cache
can only ever **reduce** the answer, never raise it.

### Calling it from an edge function

```ts
// entries MUST be a raw JSON array. Never JSON.stringify it.
const { data: groupId, error } = await adminClient.rpc('create_ledger_transaction', {
  entries: [
    { user_id: userId, category: 'roi_wallet_credit', amount: 50000,
      direction: 'cash_in', ledger_scope: 'wallet', recipient_type: 'user',
      description: 'Returns for cycle 2026-09' },
    { category: 'roi_expense', amount: 50000,
      direction: 'cash_out', ledger_scope: 'platform', recipient_type: 'operational_wallet',
      description: 'Returns expense for cycle 2026-09' },
  ],
  idempotency_key: `roi:${portfolioId}:2026-09`,   // ALWAYS set this in a cron job
});
```

Rules that bite:

- **`entries` is a raw array, never `JSON.stringify(...)`.** Stringifying produces a jsonb string,
  not an array, and the function raises.
- **Always pass an `idempotency_key` from any scheduled or retryable path.** Without it a retry
  double-pays. This is how duplicate Returns credits happen.
- **Only allowlisted categories.** `SELECT public.ledger_category_allowlist();`
- **`skip_balance_check` is not a convenience flag.** It disables the solvency guard. Use it only
  where the movement is provably funded, and say why in the description.

---

## `get_user_available_balance` — what a user may withdraw

This is the live definition, and it **differs from what `SYSTEM_CONTEXT.md` §5.3 describes.**

```sql
CREATE OR REPLACE FUNCTION public.get_user_available_balance(p_user_id uuid)
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT GREATEST(
    0::numeric,
    COALESCE((
      SELECT withdrawable FROM public.wallet_balances_projection WHERE user_id = p_user_id
    ), 0::numeric)
    - public.funder_pending_hold(p_user_id)
    - CASE
        WHEN COALESCE((
          SELECT enabled FROM public.treasury_controls
          WHERE control_key = 'advance_withdrawals_paused'
        ), false)
        THEN public.get_advance_locked_withdrawable(p_user_id)
        ELSE 0::numeric
      END
  );
$function$
```

Three things follow:

1. The read is from **`wallet_balances_projection`** (a real table, trigger-maintained), not from
   the `v_user_wallet_strict` view. Repair it with `rebuild_wallet_projection(p_user_id)`.
2. `funder_pending_hold` always reduces the figure.
3. **`advance_withdrawals_paused` is currently `true`**, so advance-locked funds are being
   subtracted platform-wide. Turning that switch off raises everyone's withdrawable balance at
   once. See [`02-danger-zones.md`](./02-danger-zones.md#kill-switches--treasury_controls).

This function gates `approve-withdrawal`, `useAgentBalances`, the wallet cards and `WithdrawFlow`.

---

## Buckets and routing

| Bucket | Meaning | Withdrawable? |
|---|---|---|
| `withdrawable_balance` | The user's own money — commissions, Returns, released deposits | Yes |
| `float_balance` | Company money in an agent's custody | **Never** |
| `advance_balance` | A liability, auto-recovered from incoming earnings | N/A |

**Routing is by `recipient_type`, not by role:** `user` → withdrawable,
`operational_wallet` → float. Set by `trg_set_wallet_bucket_from_recipient_type` and checked by
`assert_routing_compatible`.

A new earning category with no bucket route does not error — it lands silently in
`wallet_unrouted_movements`. **Whenever you add a category, add its route in
`apply_wallet_movement` in the same change**, then check that view.

---

## The 38 triggers on `general_ledger`

Live list as at 2026-09-09. They are the fortress; do not drop one to make a write succeed.

```
general_ledger_route_buckets            trg_enforce_tid_deposit_uniqueness
recover_partner_arrears                 trg_enforce_wallet_correction_evidence
trg_apply_bonus_restriction             trg_ensure_depositor_profile_on_credit
trg_assert_wallet_routing               trg_general_ledger_supporter_capital
trg_attach_cfo_correction_subcategory   trg_guard_ledger_write
trg_auto_ledger_scope                   trg_ledger_pivot_apply
trg_block_legacy_wallet_deduction       trg_ledger_running_balance
trg_block_merchant_agent_auto_debit     trg_log_ledger_wallet_transfer
trg_block_proxy_custody_writes          trg_notify_agent_commission_paid
trg_block_retired_instant_house_reward  trg_prevent_ledger_delete
trg_enforce_correction_classification   trg_prevent_ledger_update
trg_enforce_ledger_group_balance        trg_recover_advance_arrears_on_earning
trg_enforce_ledger_group_mapped_balance trg_set_wallet_bucket_from_recipient_type
trg_enforce_ledger_rpc_only             trg_sync_wallet_from_ledger  (permanent no-op)
trg_enforce_managed_proxy_roi_routing   trg_validate_ledger_category
trg_enforce_no_fraud_wallet_earnings    trg_verify_advance_disbursement
trg_enforce_no_negative_wallet_ledger   trg_wallet_projection_ledger
trg_enforce_production_april_cutoff     trg_wallet_projection_maturity
trg_enforce_single_rent_disbursement    zz_enforce_wallet_scope_requires_user
```

`zz_` is named to sort last so it fires after routing has been resolved. Keep the prefix.

---

## Classification

`production`, `legacy_real` (pre-April-2026 real history), `test_dev`, `admin_correction`.
`trg_enforce_production_april_cutoff` forces every row dated on/after 2026-04-01 to `production`;
only `admin_correction` stays distinct.

**End-user surfaces must exclude corrections.** Any raw `general_ledger` read shown to a user must
chain:

```ts
.neq('classification', 'admin_correction')
.neq('category', 'system_balance_correction')
```

Operator dashboards (CFO, FinOps, CEO, COO, CTO, HR, Manager) may read the `wallets` cache.
`scripts/guard-frontend-ledger-writes.mjs` enforces the boundary at build time.

---

## How to correct a wrong balance — the only sanctioned procedure

CFO or `super_admin` only. Reason must be at least 10 characters.

1. Establish the truth from the ledger, not the cache. Use `/cfo/money-flow-trace` and
   `/cfo/ledger/:id`.
2. Post a **balanced pair** through `create_ledger_transaction`:
   - wallet leg `system_balance_correction`
   - platform leg `phantom_writedown_clearing` or `balance_correction`
   - `classification: 'admin_correction'`
3. Let the cache follow. If it does not, run `reconcile_wallet_from_ledger(p_user_id, p_reason)`.
4. Confirm in `audit_logs`.

Never `UPDATE wallets`. Never edit the original row. `trg_enforce_wallet_correction_evidence` and
`trg_enforce_correction_classification` will stop most attempts, but they are a backstop, not the
procedure.

**Drift found 2026-09-11, and it's a dangerous one — verify against the live `wallet_strict_for_user`
before following step 2 above.** As written, "wallet leg `system_balance_correction` ...
`classification: 'admin_correction'`" describes a **credit** (`cash_in`) to fix an under-cached
balance. Live behaviour does not honour that. `wallet_strict_for_user` only counts an
`admin_correction`-classified leg when `category IN ('system_balance_correction',
'merchant_float_correction_writedown')` **and** `direction IN ('debit','cash_out')`. A `cash_in`
leg in that classification is excluded **regardless of category** — it inserts cleanly, passes
`trg_enforce_ledger_group_balance`, shows up in `general_ledger`, and changes the recipient's
balance by exactly zero. There is no error. See
[`07-tribal-knowledge.md` §6](./07-tribal-knowledge.md#6-a-bad-agent_subagents-row-can-silently-skim-an-agents-commission--and-hundreds-of-agents-can-share-the-same-bad-row)
for the incident this was caught on.

Until this is reconciled with whoever owns `wallet_strict_for_user`: use
`classification='admin_correction'` + `category='system_balance_correction'` +
`direction='cash_out'` only for the **debiting** leg (clawing back an erroneous credit from
whoever wrongly received it). To **credit** a user to fix an under-cache, use
`classification='production'` with a real earning/adjustment category from
`ledger_category_allowlist()` and an explicit `wallet_bucket`, balanced against a `platform`-scope
leg on the same user — indistinguishable from an organic entry, which is the only way
`wallet_strict_for_user` currently counts a credit at all.

---

## The rent formula — keep TypeScript and SQL in step

`compute_rent_repayment(p_rent_amount, p_duration_days)` in the database is authoritative and is
force-applied by `trg_enforce_rent_request_formula`, which **overwrites any client-supplied fee
fields**. `src/lib/rentCalculations.ts` mirrors it for display only.

```
access fee   = max( rent x (1.33 ^ (days/30) - 1),  BD-4 floor )
BD-4 floor   = ceil( [ rent x (0.005 x days + 0.10) + 0.10 x registration ] / 0.90 )
registration = UGX 10,000 if rent <= 200,000 else UGX 20,000
total        = rent + access fee + registration
daily        = ceil(total / days)
```

The floor exists because below roughly 24 days the compounding curve does not cover the 10% agent
commission plus the 15% partner reward. Duration is 7–120 days.

**If you change one side, change the other in the same commit.** Drift is recorded as
`rent_request_formula_drift`.
