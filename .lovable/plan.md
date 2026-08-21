# Step 25 — Settle evidenced own-money advances from the Step 24 report

Financial Ops can pay an agent exactly what the books evidence, row by row, and every shilling paid traces back to the payout that created it.

## What the screen does

On each expanded agent row of the settlement report:

```text
▾ Catherine M.                    we owe now  UGX 270,000   [ Settle selected (2) ]
  ☑ 12 Aug 14:02  WD-8f2a1c  UGX 180,000   own money  · ledger deficit −412,000  ✓ evidenced
  ☑ 14 Aug 09:41  WD-1b77e0  UGX  90,000   own money  · staff evidence MTN-77431 ✓ evidenced
  ☐ 15 Aug 11:20  WD-90ce4b  UGX 120,000   not selectable — desk float never went
                                            into deficit for this payout
  ☐ 16 Aug 08:02  telecom    UGX   4,200   not selectable — estimated telecom charge,
                                            no matched MTN/Airtel charge yet
```

- Only rows in `pending_reimbursement` that carry ledger deficit evidence (or a staff evidence reference from Step 13) get a checkbox.
- Unevidenced rows stay visible and disabled, with the exact reason printed on the row — never hidden.
- The settle dialog shows the selected rows, the total, a required payment reference (MoMo/bank transaction ID) and a required note of at least 10 characters. It re-reads each row fresh from the database before writing (no cached figures).
- After settling, the rows move to a "Reimbursed" section on the same report showing date, amount, reference and who settled them.

## How the reimbursement is recorded

One settlement action = one ledger transaction group per agent, plus one settlement record per advance row.

**1. Advance rows** (`merchant_out_of_pocket_advances`), only the selected IDs:
- `status` → `reimbursed`
- `reimbursed_at` = now, `reimbursed_by` = the Financial Ops user
- `evidence` gains `{ settlement_reference, settlement_group_id, settled_amount }`

**2. New trace table** `merchant_oop_settlements` — one row per advance settled, `UNIQUE (advance_id)` so a row can never be paid twice:

| column | meaning |
|---|---|
| `advance_id` | the exact own-money row settled |
| `withdrawal_id` | the payout that created it (copied from the advance) |
| `agent_id`, `amount` | who was paid, how much |
| `payment_reference` | the MoMo/bank reference typed by FinOps |
| `transaction_group_id` | links to the ledger legs below |
| `settled_by`, `settled_at`, `note` | audit |

**3. Ledger legs** — posted through `create_ledger_transaction`, one balanced pair per agent per settlement (amount = sum of selected rows):

| scope | leg | direction | category | recipient_type | bucket |
|---|---|---|---|---|---|
| wallet | agent's wallet | `cash_in` | `merchant_oop_reimbursement` | `user` | withdrawable |
| platform | company | `cash_out` | `merchant_oop_reimbursement` | — | — |

`merchant_oop_reimbursement` is added to the locked category allowlist (database validator + `src/lib/ledgerConstants.ts`) and listed as a CFO expense line, so this money shows up as a real company cost rather than being smuggled through `wallet_deposit` or a float category. `recipient_type = 'user'` is what routes it to the withdrawable bucket — the agent is being paid back their own cash, so it is withdrawable, never float. `description` and `reference_id` carry the payment reference and the withdrawal references behind it; `idempotency_key` is derived from the settlement group so a retry cannot double-post.

**4. Audit + notification**: an `audit_logs` entry (`action_type` `merchant_oop_settled`, the note as reason) and a `system_events` row, plus an SMS to the agent stating amount, reference and the payouts covered.

## Guards

The settle RPC rejects, per row, if: status is not `pending_reimbursement`, `reimbursed_at` is already set, the row has no ledger deficit or staff evidence, it is an unmatched estimated telecom row, or the caller is not financial ops / CFO / manager. A rejected row is reported back by ID with its reason; nothing partial is written — the whole settlement is one transaction.

## Technical notes

- New migration: `merchant_oop_settlements` table (with GRANTs + RLS to finance roles and service_role), category allowlist addition, and `settle_merchant_out_of_pocket(p_advance_ids uuid[], p_reference text, p_note text)` as `SECURITY DEFINER`, `SET search_path = public`.
- Frontend: selection state + `SettleEvidencedAdvancesDialog` inside the Step 24 report component, mutation hook in `src/hooks/useMerchantFloat.ts`, invalidating the report, debt and float queries.
- Wallet balances change only through the ledger legs above — no direct wallet writes.
