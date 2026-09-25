# Controls and the verification runbook

Four things can refuse a posting. Three of them live in the database and one
does not — and the one that does not is the one that bites.

---

## 1. Mapped-balance enforcement

`trg_enforce_ledger_group_mapped_balance` on `general_ledger`, **per ROW**.

- Judges only groups whose first leg is at or after
  `ledger_integrity_config.enforce_from` (**2026-07-23 19:30 UTC**)
- Computes DR/CR on **base mapping only** — no overrides, no synthetics
- `mapped_balance_mode = 'log'` → writes `ledger_mapped_balance_violations`
- **Raises regardless of mode** if the group contains a treasury category:
  `treasury_fee_recognised`, `treasury_allocated`, `fee_receivable_created`,
  `partner_reward_accrued`, `agent_commission_accrued`, `treasury_net_revenue`

**Two consequences.** Because it ignores resolver stages 4–6, it yields false
positives against the published balance sheet. And it **never clears a resolved
violation** — the table has no `resolved_at` column, unlike
`critical_function_drift_alerts`. A violation row is not proof that something is
still wrong.

---

## 2. Category allowlist

`ledger_category_allowlist()` + `trg_validate_ledger_category`, active while
`treasury_controls.strict_mode` is on (since 2026-04-09).

> Mapped but not allowlisted → **fails at insert.**
> Allowlisted but not mapped → **posts and silently resolves to A9.**

The function is **replaced, not appended to** — reproduce every existing entry
verbatim when adding one.

---

## 3. `assertLedgerGroupBalanced` — the one that bites

`supabase/functions/_shared/balancedLedgerPost.ts` prices legs against
`ledger_account_map` **over PostgREST** and refuses to write an unbalanced group.
*Assert-then-post: nothing is written when the assertion fails.*

Callers — all cross-bucket money paths:

| Function | Traffic |
|---|---|
| `agent-convert-withdrawable-to-float` | ~165 legs/week |
| `finops-wallet-move` | high |
| `admin-withdrawable-to-float` | low |
| `admin-float-to-withdrawable` | low |

**A `pg_proc` scan cannot see these.** On 2026-09-24 a mapping change passed
every database-side check and would have rejected all four paths; it was caught
and rolled back 30 minutes later.

> **Always** `grep -rn "<category>" supabase/functions/` before touching a
> mapping row.

---

## 4. Drift and invariants

| Control | Purpose |
|---|---|
| `assert_money_path_intact()` | 17 invariants over the collection/allocation path |
| `critical_function_baselines` + `scan_critical_function_drift()` | sha256 per critical function; cron every 5 min |
| `npm run guard:all` | frontend ledger writes, deposit purpose, canonical tags, schema types, persona routes |

---

## Verification runbook

### Cash position

```sql
select public.get_treasury_cash_position();   -- A1 + A5, authoritative
```

`get_treasury_snapshot` is **superseded** and can show malformed negatives that
look like a deficit but are not.

### Balance sheet

```sql
select public.get_statement_of_financial_position(now());
```

Requires `cfo` / `ceo` / `coo` / `manager` / `financial_ops` / `super_admin` /
`cto`. Raises *"Not authorised"* when `auth.uid()` is NULL — **which it is on a
direct postgres connection.**

### Trial balance

A full `sofp_ledger_legs(now())` pass exceeds the MCP gateway timeout.
Hash-partition four ways and run each separately:

```sql
HAVING abs(hashtext(COALESCE(gl.transaction_group_id, gl.id)::text)) % 4 = 0   -- then 1, 2, 3
```

### Subledger ties

| Account | Subledger |
|---|---|
| **A7** | `promissory_notes` where `status='activated'` — ties exactly, **the best canary** |
| A10 | `agent_advances.outstanding_balance` |
| A12 / A13 | `merchandise_recovery_plans.outstanding_balance` |
| A14 | `credit_access_draws.outstanding_balance` |
| L2 | `investor_portfolios.investment_amount` |
| L1 | `wallets` withdrawable + locked |

---

## Checklists

### Adding a new money flow

1. **Name the economic event.** What does the company own or owe afterwards that
   it did not before? If nothing, it is a reclassification and must be
   balance-sheet neutral.
2. **Pick accounts for both sides.** Reuse existing codes. A new code needs a
   `ledger_account_catalog` row with `section`, `nature`, `sort_order`.
3. **Add the mapping row(s)** — scope, category, bucket (null = bucket-agnostic),
   account, `debit_when`.
4. **Add the category to `ledger_category_allowlist()`**, verbatim.
5. **Check the resolver.** Will any shape override capture your group? Shape
   rules do not look at your category.
6. **Check `balancedLedgerPost.ts`.** If your flow runs through one of its four
   callers, the group must balance on base mapping alone, with no synthetics.
7. **Check the enforcement trigger.** Treasury category → it raises, not logs.
8. **Post through `create_ledger_transaction`** with an idempotency key.
9. **Verify** — balances raw *and* resolved; `assert_money_path_intact()` 17/17;
   no new `ledger_mapped_balance_violations`.

### Before changing any mapping row

1. Is the account resolver-affected?
2. `grep -rn "<category>" supabase/functions/`
3. Will the group still balance on base mapping alone?
4. Does any affected group carry a treasury category?
5. Re-run the four-partition trial balance afterwards.

### Acceptance tests for a money change

**Do not use "the balance sheet balances" as a test** — it currently does not,
for reasons unrelated to your change. Test per group:

- the group balances on **raw** directions
- the group balances **after the resolver**
- `assert_money_path_intact()` still returns 17/17
- no new rows in `ledger_mapped_balance_violations` attributable to your change
- the relevant **subledger tie** still holds
