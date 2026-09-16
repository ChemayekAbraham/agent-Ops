# 40 — 2026-09-16: doc 38's fix was silently reverted hours later, blocking a second agent

**Migration written, NOT yet deployed** (`20260916180000_reapply_block_reasons_recency_ordering_after_revert.sql`
— run it manually in the SQL editor, same as doc 38 required). Before touching
`payout_withdrawal_block_reasons` again, read this AND doc 38 — the function has now regressed
once already within the same day.

## What happened

Doc 38 fixed `payout_withdrawal_block_reasons()` to order candidate destinations by `updated_at`
alone instead of `(status = 'rejected') DESC, updated_at DESC`. Confirmed live at the time.

A separate, legitimate fix landed a few hours later
(`20260916170000_exempt_pure_partner_from_withdrawal_block_reasons.sql`, adding a
`user_is_pure_partner` short-circuit for Nankambo Sharimah) — but it was authored from a **stale
copy of the function body** (from before doc 38's change) and its `CREATE OR REPLACE FUNCTION`
silently put the old `(status = 'rejected') DESC` ordering back. This is the exact
"fix gets silently reverted, no migration records it" failure mode described in
[`17-critical-function-drift-detection.md`](./17-critical-function-drift-detection.md) and
[`18-email-queue-dispatch-self-cancel-regression.md`](./18-email-queue-dispatch-self-cancel-regression.md)
— except this time via a normal migration file, not a direct prod edit, because whoever wrote it
never re-fetched the current function before editing it.

## Impact

**Kirunda Ivan** (`36b19095-b437-4b4f-afa5-18ca6f9ea6d2`, agent, momo `0756404789`) reported the
same "resubmitting doesn't work" symptom as doc 38, via WhatsApp screenshots. Confirmed live: his
own number is `status = 'verified'` (`updated_at` 2026-09-16 13:33:33, Financial-Ops-approved,
"Number correct"). Sitting alongside it are 9 unrelated `rejected` destinations (fake numbers under
other people's names — `matiya waiswa`, `kwegemya kasifa`, etc. — not numbers he plausibly tried
himself; likely leftover synthetic/test rows) all sharing an identical `updated_at` of
2026-09-16 11:02:55. With the reverted ordering back in place, `payout_withdrawal_block_reasons`
picked one of those 9 (arbitrarily, since they tie on the tiebreak column too) and blocked him,
even though his real destination is verified and more recent than all of them.

`select payout_withdrawal_block_reasons('36b19095-b437-4b4f-afa5-18ca6f9ea6d2'::uuid)` currently
returns `blocked: true` — confirmed still broken as of writing this doc.

## Fix

Re-applies doc 38's `ORDER BY updated_at DESC NULLS LAST` (dropping the reject-priority tiebreak)
on top of the current function body, so the pure-partner exemption from `170000` is kept intact.
No new logic — this is a straight re-application of an already-reviewed fix.

## Open follow-up, not done here

- Consider adding `payout_withdrawal_block_reasons` to the `critical_function_baselines` drift
  watchlist (doc 17) given it has now regressed once already in a matter of hours purely from a
  same-day edit race, not malice.
- Did not investigate why Kirunda has 9 rejected destinations under other people's names with an
  identical timestamp — looks like synthetic/test data, not something he actually submitted, but
  not root-caused here. Doesn't block the fix.
- Same as doc 38: after this migration runs, re-verify Kirunda Ivan's account directly.
