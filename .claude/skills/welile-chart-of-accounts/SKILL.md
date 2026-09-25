---
name: welile-chart-of-accounts
description: How Welile's money is recorded — the `general_ledger` posting model (three scopes, direction instead of debit/credit, wallet buckets), `ledger_account_map` as accounting policy, the `sofp_ledger_legs` resolver with its overrides and synthetic legs, the account catalogue A1–A19/L1–L9/E/R/X, and the controls that will block a bad posting. Use this before writing or changing anything that posts to the ledger, moves a wallet balance, adds a money flow, edits `ledger_account_map`, or reads a balance-sheet figure; and whenever anyone asks about cash position, treasury, commission expense, receivables, float, the balance sheet, a trial balance, or why two money figures disagree.
---

# Welile chart of accounts — the posting model

Built from the live production schema, **as at 2026-09-24**. Figures in this
skill are illustrations of shape. **Re-derive before quoting any of them.**

Related: `welile-expected-vs-collected` (the rent bill vs the receipt book),
`SYSTEM_CONTEXT.md`, `docs/FINANCIAL_SYSTEM_ARCHITECTURE.md`,
`docs/RENT_COLLECTION_MONEY_MOVEMENT.md`.

**Terminology in user-facing copy:** Rent Plan (never "loan"), Supporter /
Partner (never "lender"), Returns (never "ROI" or "interest"). Internal category
names still use the old words — do not propagate them into UI, SMS or email.

---

## Five things that surprise almost everyone

1. **The ledger stores `direction`, never debit/credit.** The side is derived at
   read time from a mapping row.
2. **`ledger_account_map` is not a lookup table — it is the accounting policy.**
   Changing one row re-states every historical leg that resolves through it.
3. **The balance sheet is not the sum of mapped legs.** A resolver applies
   shape-based overrides and injects synthetic legs that exist in no table.
4. **Only `wallet`-scope legs move money.** `platform` and `bridge` legs are
   accounting-only.
5. **Edge functions read `ledger_account_map` over PostgREST.** A database-only
   impact analysis will miss them and can block live money paths.

---

## The posting model

Everything posts to `general_ledger`. A row is a **leg**. Legs sharing a
`transaction_group_id` form a **group**, and the group is the unit that must
balance.

| `ledger_scope` | Meaning | Moves wallet balances? |
|---|---|---|
| `wallet` | an effect on a named user's wallet | **yes** |
| `platform` | the company-side counterpart | no |
| `bridge` | recognition / restatement — no cash, no wallet effect | no |

### Direction, not debit/credit

```
side = (leg.direction = mapping.debit_when) ? DEBIT : CREDIT
```

`debit_when` belongs to the **mapping row**, not the leg. So the same
`direction` means different things for different categories, and flipping
`debit_when` inverts every historical leg through that row.

### Wallet buckets

| Bucket | Meaning | Withdrawable? |
|---|---|---|
| `withdrawable` | spendable balance | yes |
| `float` | operating float held for trading | **no** — `submit_withdrawal_request` never reads it |
| `advance` | drawn against future earnings | no |
| `locked` | restricted | no |

### The only path to a balance change

```
INSERT general_ledger (ledger_scope='wallet', …)
  └─ trg general_ledger_route_buckets → tr_general_ledger_route_buckets()
       └─ returns immediately when ledger_scope <> 'wallet'
       └─ apply_wallet_movement(user_id, category, amount, direction[, recipient_type])
            ├─ wallets_physical           (locked_balance)
            └─ wallet_balances_projection (withdrawable / float / advance)
                 └─ wallets (VIEW over both)
```

`ledger_account_map` is **not** in this path. A mapping change can never move a
balance — but it can block a posting.

---

## How to post

```sql
create_ledger_transaction(
  entries            jsonb,                  -- array of leg objects
  idempotency_key    text    DEFAULT NULL,
  skip_balance_check boolean DEFAULT false
) RETURNS uuid                                -- the transaction_group_id
```

Variants: one that posts into an existing group
(`p_transaction_group_id, p_entries, p_idempotency_key, p_skip_balance_check`),
and `create_ledger_transaction_accrual_only(entries)` for no wallet effect.

```jsonc
{
  "ledger_scope":  "wallet",             // wallet | platform | bridge
  "direction":     "cash_in",            // cash_in | cash_out
  "amount":        20000,
  "category":      "agent_commission_earned",
  "user_id":       "…uuid…",             // REQUIRED on wallet scope
  "wallet_bucket": "withdrawable",       // REQUIRED on wallet scope
  "recipient_type":"user",               // user | operational_wallet
  "source_table":  "agent_collections",  // provenance — always set it
  "source_id":     "…uuid…",
  "reference_id":  "TID…",
  "description":   "Human-readable, states amounts and reason",
  "currency":      "UGX",
  "transaction_date": "2026-09-24T09:00:00Z"
}
```

**Non-negotiables**

- **Always pass an `idempotency_key`.** Retries are real; double-posting money is
  worse than failing.
- **Always set `source_table`.** Operator tools may leave `source_id` null (the
  description carries the narration), but a leg with neither is untraceable.
- **`skip_balance_check` is for legacy shapes.** Do not reach for it.
- **Never write `general_ledger` from the frontend.** Enforced at build time by
  `scripts/guard-frontend-ledger-writes.mjs`.
- **Never post to E4.** It is resolver-injected only.

### Two gates every category must pass

1. **`ledger_account_map`** — an unmapped non-wallet leg resolves to **A9** and
   disappears from meaningful reporting.
2. **`ledger_category_allowlist()`** — `trg_validate_ledger_category` raises on
   any category outside it while `treasury_controls.strict_mode` is on.

> Mapped but not allowlisted → **fails at insert.**
> Allowlisted but not mapped → **posts and silently vanishes into A9.**

---

## The accounts you will meet most

| Code | Name | Note |
|---|---|---|
| **A1** | Cash and Bank Balances | spendable now |
| **A2** | Cash at Hand — Float with Agents | ⚠ conflates company and user money |
| **A3** | Rent Access Receivables (Tenants) | the Rent Plan book |
| **A5** | Cash in Transit — Received, Not Yet Banked | |
| **A8** | Agent and Merchant Float Cycle Control | float clearing |
| **A9** | Suspense — Unresolved (debit) | where unmapped legs go to die |
| **L1** | Wallet Custody Payable | customer money |
| **L4** | Landlord Rent Payable | |
| **L7** | Platform Treasury Control — Landlord Flow | deferred fee liability |
| **R1** | Platform Revenue | |
| **X1** | Operating Expenses | includes `marketing_expense` |
| **X3** | Agent Commission Expense | |

Full catalogue with subledger ties: `references/account-catalogue.md`.
Complete category → account map: `references/category-map.md`.

**Total company cash = A1 + A2 + A5. Treasury cash = A1 + A5**, read via
`get_treasury_cash_position()` — A2 is cash physically held by agents.

---

## The resolver — why you cannot read the balance sheet off the map

`public.sofp_ledger_legs(as_at)` is canonical.
`get_statement_of_financial_position()` is built on it.

```
1. FILTER      production / legacy_real (+ one admin_correction case)
2. BASE MAP    bucket-specific → bucket-agnostic → fallback
                 fallback: wallet+float→A2 · wallet+advance→A4 · wallet→L1 · else→A9
3. SHAPE       per-group counts: n_wallet, n_a2, n_l1, n_plat, n_repay, n_custody…
4. OVERRIDES   account and direction rewritten by group shape
5. SYNTHETICS  legs injected that exist in no table
6. E4          one-sided groups receive a balancing counterpart
```

| | Accounts |
|---|---|
| **Safe** — base mapping equals resolver | A5, A6, A7, A11, A16–A19, L2, L3, L5, L6, L7, L9 |
| **Unsafe** — overrides/synthetics apply | A1, A2, A3, A4, A8, A10, A12–A15, L1, L4, E3, X4, X6 |

> Computing an **unsafe** account from `ledger_account_map` has produced wrong
> conclusions twice. `get_treasury_cash_position()` is the one sanctioned
> exception — it computes A1 and A5 from base mapping deliberately.

Overrides, synthetics and the E4 blind spot: `references/resolver.md`.

---

## Adding a new money flow

1. **Name the economic event.** What does the company own or owe afterwards that
   it did not before? If nothing, it is a reclassification and must be
   balance-sheet neutral.
2. **Pick accounts for both sides.** Reuse existing codes.
3. **Add the mapping row(s)** — scope, category, bucket (null = bucket-agnostic),
   account, `debit_when`. Bucket-specific beats bucket-agnostic.
4. **Add the category to `ledger_category_allowlist()`** — reproduce existing
   entries verbatim; the function is *replaced*, not appended to.
5. **Check the resolver.** Will any shape override capture your group? Shape
   rules do not look at your category.
6. **Check `balancedLedgerPost.ts`.** If your flow runs through one of its four
   callers, the group must balance on **base mapping alone**, no synthetics.
7. **Check the enforcement trigger.** A treasury category makes it **raise**, not
   log.
8. **Post through `create_ledger_transaction`** with an idempotency key.
9. **Verify** — group balances raw and resolved; `assert_money_path_intact()`
   still 17/17; no new `ledger_mapped_balance_violations`.

### Before changing any mapping row

1. Is the account resolver-affected? (safe/unsafe table above)
2. `grep -rn "<category>" supabase/functions/` — **this is the one that bites**
3. Will the group still balance on base mapping alone?
4. Does any affected group carry a treasury category?
5. Re-run the four-partition trial balance afterwards.

Controls, the verification runbook and subledger ties:
`references/controls-and-verification.md`.

---

## Common mistakes

| Mistake | Consequence |
|---|---|
| Computing a resolver-affected account from `ledger_account_map` | wrong balances, wrong conclusions |
| Changing `debit_when` to make a group balance | re-states all history through that row |
| Assuming a balanced ledger means correct accounting | a group can balance and still misclassify |
| Trusting E4 or `ledger_mapped_balance_violations` as proof of integrity | both have blind spots |
| Impact-analysing a mapping change with SQL only | misses `balancedLedgerPost.ts` |
| Mapping a category without allowlisting it | insert fails under strict mode |
| Allowlisting without mapping | leg posts and silently resolves to A9 |
| Posting to E4 to force a balance | forbidden — fix the entry instead |
| Omitting `idempotency_key` | retries double-post money |

---

## Known-broken, so do not use these as tests

The books do **not** currently balance, and several accounts are contaminated.
**"Did the balance sheet balance after my change" is not a usable acceptance
test** — test per group instead.

See `references/open-defects.md` for the list, the figures and the dates,
including defects derived after the blueprint was written.

---

## Reading order

| You are doing | Read |
|---|---|
| Posting a new flow, or changing one | this file, then `references/worked-examples.md` |
| Picking a category or an account | `references/category-map.md`, `references/account-catalogue.md` |
| Reading or explaining a balance-sheet figure | `references/resolver.md` first |
| Verifying, or tying to a subledger | `references/controls-and-verification.md` |
| Wondering whether a number is wrong | `references/open-defects.md` |
