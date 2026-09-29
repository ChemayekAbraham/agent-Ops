# 161. Reversed float-gate duplicates removed from 31 Rent Plan balances; the check now measures evidence (2026-09-29)

**Status:** LIVE 2026-09-29. Applied to production. Migrations:
`20260929180000_remove_reversed_duplicates_from_plan_balances.sql` (data correction),
`20260929181000_plan_balance_holds_reversed_uses_evidence.sql` (monitor check).
**This is issue #5** from the Agent Collections Monitor pass (docs 158–160). Decision: Josh Wanda, "Correct all 31".

## What was wrong

The incident report ([`docs/2026-09-15-float-gate-collection-incident.md`](../2026-09-15-float-gate-collection-incident.md) §4)
says duplicates never reached `rent_requests.amount_repaid`. **That's true only before the 2026-09-16 06:03
guard fix.** Re-taps after it (plus a smaller set on 10 and 14 Sep) did raise `amount_repaid`: each one has a
`rent_amount_change_log` row whose delta equals the collection amount within 5 seconds. The remediation reversed
them in `agent_collections` and contra'd them in `general_ledger`, but on **31 plans it never took them off the
plan balance**:

- **UGX 7,447,034** counted as paid that the tenants did not pay.
- **14 plans** read `completed` only because of it (e.g. Nabulya Benna and Babirye sarah, 360,000 each on
  552,000 plans; KAKOOZA MUZAFALU 1,365,000 on 2,680,000).
- Agents and dashboards treated these tenants as paid up, so nobody chased the money.

## The correction

Per plan: the reversed collections that provably landed, minus **every** `amount_repaid` decrease logged after
the first reversal. Any decrease counts as a take-back, so this is the conservative figure.

- `amount_repaid` was reduced by that amount, and plans reopened `completed → repaying` where the corrected
  balance is below `total_repayment`. The update only applied where the balance hadn't moved since
  the snapshot; all 31 matched.
- **No ledger posting.** The ledger already carries the contra (`20260916220000`). Same shape as
  `20260916200000`.
- Every status trigger was checked before applying. None moves money or messages anyone on
  `completed → repaying`; the repaying gate returns early when `OLD.status = 'completed'`;
  `try_credit_qualified_referrals` is idempotent per referral.
- Evidence and before/after for each plan: `public.plan_balance_duplicate_correction_20260929` (RLS on, no
  client grants). There are 31 `audit_logs` rows with `action_type = 'plan_balance_duplicate_correction'`, and
  `rent_amount_change_log` recorded each change.

Verified: 31/31 plans at their target balance and status, with 14 reopened.

## The check was also wrong

The old `plan_balance_holds_reversed` fired whenever a plan had *any* reversal and `amount_repaid > live
collections`. After the correction, all 11 plans it still flagged were false positives:

- 10 Sep inversion reversals that *were* taken back, then the balance was raised in one manual jump (e.g. James
  Katongole setting twesige agnes 164,477 → 3,345,000). That's `plan_balance_unbacked`'s territory.
- Josh's 21 Sep "No deposit/momo evidence" voids, which *did* reduce the balance, followed by **genuine new
  float-backed collections** by Ian Muhwezi. Those are not the void coming back.

It now uses the same evidence as the correction, through a shared helper,
`plan_reversed_money_still_held(since)`, so the check, its drill-down and any future fix can't drift. A hit now
means real reversed money still counted as paid. Reads **0** after the correction.

## Not done / open

- `plan_balance_unbacked` (info, 193 plans) still holds the manual "mark as paid" jumps above. That's a separate
  question: were they genuine off-system settlements?
- The incident report's §4 claim is annotated to point here.
