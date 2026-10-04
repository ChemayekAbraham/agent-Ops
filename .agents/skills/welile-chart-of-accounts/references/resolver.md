# The resolution pipeline

`public.sofp_ledger_legs(as_at)` is canonical.
`get_statement_of_financial_position()` is built on it.

**The balance sheet is not the sum of mapped legs.** Between the raw leg and the
published figure there are three transformations, and two of them invent or
rewrite data.

---

## The six stages

```
1. FILTER      classification IN ('production','legacy_real')
               OR (admin_correction AND source_table='merchant_float_reconciliations')

2. BASE MAP    COALESCE(bucket-specific row, bucket-agnostic row, fallback)
                 fallback: wallet+float   → A2
                           wallet+advance → A4
                           wallet         → L1
                           else           → A9

3. SHAPE       per-group counts: n_wallet, n_a2, n_l1, n_plat, n_repay, n_custody, …

4. OVERRIDES   account AND direction rewritten by group shape

5. SYNTHETICS  legs injected that exist in no table

6. E4          one-sided groups receive a balancing counterpart
```

**Stage 3 is the key idea.** Overrides are keyed on the *shape of the group* —
how many wallet legs, how many resolve to A2, how many to L1 — and **not on your
category**. A new flow can be captured by an override written for something else
entirely.

---

## Which accounts base mapping can speak for

| | Accounts |
|---|---|
| **Safe** — base mapping equals the resolver | A5, A6, A7, A11, A16–A19, L2, L3, L5, L6, L7, L9 |
| **Unsafe** — overrides and/or synthetics apply | A1, A2, A3, A4, A8, A10, A12–A15, L1, L4, E3, X4, X6 |

Computing an **unsafe** account from `ledger_account_map` has produced wrong
conclusions twice.

**The one sanctioned exception:** `get_treasury_cash_position()` computes A1 and
A5 from base mapping deliberately, and is authoritative for those two.

---

## Account overrides

| Condition | Resolves to |
|---|---|
| platform `system_balance_correction`, `n_a2 > 0`, src `merchant_float_reconciliations` | **A8** |
| platform `system_balance_correction`, `n_a2 > 0` | **X6** |
| platform `system_balance_correction` | **E3** |
| platform `agent_float_cash_offset`, src `agent_collections`, `cash_out` | **A3** |
| platform `rent_disbursement`, src `agent_advance_requests` | **A10** |
| `agent_repayment` / `advance_repayment`, by source table | **A10 · A12 · A13 · A14 · A15** |
| platform `wallet_deduction%`, `n_a2 > 0`, `n_l1 = 0` | **A1** |
| platform `wallet_deduction%`, `n_l1 > 0` | **E3** |
| platform `wallet_withdrawal`, `n_wallet > 0`, `n_l1 = 0` | **L1** |
| wallet leg at L1, not a bucket-move category, shape 2w / 1×A2 / 1×L1, no non-SBC platform legs | **A8** |
| platform `agent_float_cash_offset`, `n_custody > 0`, `n_wallet > 0`, `n_a2 = 0` | **L1** |

### Direction overrides

Direction overrides mirror the account ones. **The most important one** flips
`tenant_repayment*` / `rent_repayment` / `landlord_receivable_collected` when a
float leg is present in the group — so a collection **reduces** A3 instead of
increasing it.

That single flip is why the tenant-collection journal looks the way it does.

---

## Synthetic legs

Legs the resolver invents. They exist in no table and cannot be queried
directly.

| Name | Fires on | Emits |
|---|---|---|
| `float_backed_collection_counterpart` | platform `tenant_repayment*` / `rent_repayment` **with a float leg in the group** | **DR A5 + DR L4** |
| `bucket_reclass_counterpart` | wallet L1 leg with `bucket_reclass_in/out/wallet_transfer` in a gated 2-leg shape | **2 × X4** ⚠ see `open-defects.md` |

The first is what makes the tenant-collection journal balance: the agent's float
funds the tenant's rent, so the company simultaneously recognises cash in the
agent's custody (A5) and an obligation onward to the landlord (L4).

---

## E4 and its blind spot

Groups where `abs(raw_net) > 0.5` **and** DR ≠ CR receive a balancing E4 leg.

> **The control gap.** `raw_net` is raw `cash_in − cash_out`, computed on raw
> directions, ignoring mapping entirely. A group with equal and opposite
> directions has `raw_net = 0` and is **exempt from E4 even when DR ≠ CR after
> mapping**.
>
> Every defect in `open-defects.md` is of exactly this kind.
> **E4 being nil is not evidence that the books balance.**

**Never post to E4 to force a balance.** Fix the entry.

---

## Reading a figure correctly

| Question | How to answer it |
|---|---|
| Cash position | `get_treasury_cash_position()` — A1 + A5. Authoritative |
| Any balance-sheet line | `get_statement_of_financial_position(now())` |
| A single account, ad hoc | only if it is in the **safe** list; otherwise go through the resolver |
| Did my group balance? | compute it **raw** and **resolved** — both, separately |

`get_statement_of_financial_position` requires `cfo` / `ceo` / `coo` / `manager`
/ `financial_ops` / `super_admin` / `cto`, and raises *"Not authorised"* when
`auth.uid()` is NULL — **which it is on a direct postgres connection.**

A full `sofp_ledger_legs(now())` pass exceeds the MCP gateway timeout.
Hash-partition four ways:

```sql
HAVING abs(hashtext(COALESCE(gl.transaction_group_id, gl.id)::text)) % 4 = <0..3>
```
