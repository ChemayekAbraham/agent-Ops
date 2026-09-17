# 38 — 2026-09-16: rejected payout destination could never clear, even after Financial Ops approval

**Live as of 2026-09-16** (`20260916160000_fix_payout_destination_rejected_stuck_forever.sql`, run
manually against production since `CREATE OR REPLACE FUNCTION` writes are blocked from this
session's tooling — confirmed by re-querying the affected account, see below). Before touching
`ensure_payout_destination` or `payout_withdrawal_block_reasons`, or before assuming a "your details
did not meet the criteria" banner reflects the user's *current* destination state.

## Symptom

User-reported screenshot: "USER CANNOT WITHDRAW EVEN AFTER RESUBMITTING HIS DETAILS", showing the
`destination_rejected` banner for momo `0700212384` ("registered to OCHIENG CHARLES WILFRED... no
merchant/cashout-agent role").

Traced to **Grace Paul Ochieng** (`99890a2e-b842-4d44-8516-e2eafe0711ff`, live-verified against
production). She had done everything asked and more: switched her withdrawal number to her own MTN
line (`0787373498`, name "Ochieng Grace Paul", matches her National ID "OCHIENG GRACE PAUL" at a
1.00 name-match score), and Financial Ops had explicitly **approved** it (`decision_reason`:
"Withdrawal number change approved by Financial Ops: VERIFIES USER 101", verified 2026-09-16
08:35:06). The withdraw screen still showed the rejection banner for the old `0700212384` number.

## Two independent bugs, both confirmed live

1. **`payout_withdrawal_block_reasons()` ordering.** It picked the blocking destination with
   `ORDER BY (status = 'rejected') DESC, updated_at DESC` — any rejected `mobile_money` destination
   always outranks a newer verified/waiting one, no matter how stale. Grace has 11 old rejected
   destinations sitting in the table (other people's numbers she'd tried, plus what look like test
   entries — `0788888888`/"Grace", "Ndaula Thomas" appearing twice with no `momo_number` at all).
   The reject-first tiebreak picked one of those every single time, even though her real, approved
   destination was updated *more recently* (08:35 vs. the old reject's 2026-09-15 15:33). **Fix:**
   order by `updated_at DESC` alone — whichever destination was most recently touched (by the user
   or by Financial Ops) governs the block state.

2. **`ensure_payout_destination()` never re-opens a rejected row.** Its `UPDATE` branch's status
   `CASE` only handles `verified -> waiting` (identity drift) and `waiting -> verified` (partner
   exemption) — there is no branch for `rejected` at all, so a user who resubmits the exact same
   `destination_key` (re-confirms the same number via OTP, e.g. after the real owner grants
   consent) gets `account_name`/`name_match_score` refreshed but the `status` column never moves off
   `'rejected'` — permanently, regardless of what they submit. This directly contradicts the
   rejection text's own promise: "submit again and Financial Ops will look at it." **Fix:** add a
   `rejected -> waiting` branch. Safe to reopen unconditionally, because
   `finops_decide_payout_destination()` re-runs the double-submission and duplicate-National-ID
   auto-reject checks before it will ever accept `'verified'` again — a genuinely fraudulent
   resubmission still bounces back to `rejected` at decision time, it just gets a human look first
   instead of being silently frozen.

Bug 1 alone explains Grace's exact case (she'd moved past the problem entirely; the UI just couldn't
see it). Bug 2 is the more common failure mode for anyone who *doesn't* switch numbers — keeps the
same rejected momo number and tries to fix the name/photo mismatch in place.

## Confirmed live

Re-ran `select payout_withdrawal_block_reasons('99890a2e-b842-4d44-8516-e2eafe0711ff'::uuid)` against
production after the migration was applied: `{"blocked": false, "code": "ok", "status": "verified",
"reasons": []}`. Grace Paul Ochieng can withdraw.

## Not done

- Did not clean up Grace's 11 stale/junk rejected destination rows (test numbers, no-`momo_number`
  rows) — cosmetic now that the ordering bug is fixed, not touched.
- Did not audit other users for the same stuck-rejected pattern platform-wide; this doc only
  root-causes and fixes the mechanism, scoped to the one reported case.
