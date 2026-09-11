# Diagnosis — Joshua Wanda's UGX 41,000 shows payable but settlement skips both claims

Read-only. Nothing was edited in code or data.

## What the books actually hold

Joshua Wanda (agent `cb798acb…`) has four unreimbursed claims, all `pending_reimbursement`:

| claim | kind | amount | float position at payout | evidenced | estimate |
|---|---|---|---|---|---|
| `53e63e04…` | payout | 1,000 | −3,732,710 | yes | no |
| `aad10e80…` | payout | 40,000 | −3,732,710 | yes | no |
| `c0be48d4…` | telecom | 100 | −3,732,710 | yes | yes |
| `30587449…` | telecom | 500 | −3,732,710 | yes | yes |

The two payout claims sum to exactly the UGX 41,000 on screen, and both are fully
evidenced (`evidenced_amount = shortfall_amount`), so neither the status test, the
estimate test nor the evidence test in the settlement function can reject them.

## Root cause

**Joshua Wanda is both the merchant agent being paid and a CFO-role holder.**
`user_roles` for `cb798acb…` includes `cfo` (plus `financial_ops`-equivalent staff
roles), and the claims belong to that same user id.

`settle_merchant_out_of_pocket` opens with a separation-of-duties block: for every
distinct `agent_id` in the batch, if `v_agent = v_actor` (`auth.uid()`), every row for
that agent is pushed to `skipped` with reason `MERCHANT_OOP_SETTLEMENT_SELF_BLOCKED`
and the agent is skipped entirely — no ledger posting, no `merchant_oop_settlements`
row, no audit entry. That yields exactly two skipped claims for the two selected
payable lines. Consistent with the evidence: `merchant_oop_settlements` has no row for
any of the four ids and `audit_logs` has no `merchant_oop_settled` entry after 12:41.

The dialog then reports every skip with one generic sentence — "already paid or not yet
confirmed" — which is why a self-settlement block reads as a payment/confirmation
problem.

## Mismatched predicates

Payable in the UI (`src/hooks/useMerchantFloat.ts`, `useMerchantSettlementDebts`,
feeding `src/components/financial-ops/MerchantDebtSettlementDialog.tsx`):

- `status IN ('pending_reimbursement','needs_review')` and `reimbursed_at IS NULL`
- payable line requires `status = 'pending_reimbursement' AND is_evidenced AND NOT is_estimate`

Settleable in `public.settle_merchant_out_of_pocket(p_advance_ids uuid[], p_note text)`:

- actor holds `cfo` / `financial_ops` / `super_admin`
- **`agent_id <> auth.uid()`** — no counterpart anywhere in the UI
- `status = 'pending_reimbursement'` (else `already_reimbursed` / `not_confirmed_yet`)
- not an estimated telecom charge
- `is_evidenced` AND `evidenced_amount >= shortfall_amount` (else
  `not_evidenced_by_books` / `partially_evidenced_only`)
- no existing `merchant_oop_settlements` row for the claim (else `already_reimbursed`)

Two gaps, in order of impact:

1. **Self-settlement**: the server refuses `agent_id = auth.uid()`; the UI has no such
   filter, so a staff member who is also a merchant desk always sees their own claims as
   payable and can never settle them. This is Joshua's case.
2. **Partial evidence**: the UI counts `evidenced_amount` (a partial figure is still
   listed as payable); the server requires full evidence and skips
   `partially_evidenced_only`. Not triggered for Joshua, but it produces the same
   symptom for other desks.

Secondary: the toast collapses every distinct `skipped.reason` into one message, so
none of the above is distinguishable on screen.

## Files and functions involved

- `src/components/financial-ops/MerchantDebtSettlementDialog.tsx` — selection, `sendToWallet`, generic skip toast
- `src/hooks/useMerchantFloat.ts` — `useMerchantSettlementDebts` (payable rule), `useSettleMerchantOutOfPocket`
- `public.settle_merchant_out_of_pocket` — self-block, status/estimate/evidence gates, skip reasons
- `public.v_merchant_oop_evidence`, `public.merchant_float_position_at` — evidence source
- `public.classify_merchant_payout_funding` — raises/refreshes the claims (10-minute reclassification)

## Not the cause

Claim ids are stable (`ON CONFLICT (withdrawal_id, kind) DO UPDATE`), the four rows are
untouched by settlement, evidence is well past the amounts (desk was UGX 3.7M negative
at both payout timestamps), and no float leg was posted after 10 Sep, so no evidence
race is involved.

## If you want a fix next

No change proposed yet — say the word and I will plan one of: surface the real skip
reason per claim, exclude the actor's own desk from the payable list with an explanatory
note, and/or route a staff member's own desk claims to a second approver.
