# 91 — Re-baselined the four pre-existing withdrawal-destination drift alerts (legitimate, unrecorded drift)

**Doc 88 flagged these as not-yet-investigated. Detection-hygiene only — no function logic
touched, no money-movement behavior changed.**

Doc 66 already noted "the other 4 pre-existing watched critical-function baselines have legitimate
but never-recorded drift — flagged, not auto-rebaselined." These are that same set:
`submit_withdrawal_request`, `ensure_payout_destination`, `enforce_withdrawal_destination_verified`,
`enforce_withdrawal_payout_account_lock`. All four were baselined once, at
`critical_function_drift_detection`'s creation (2026-09-13 22:54:42 UTC), then legitimately
modified by later same-week fixes without a re-baseline in the same migration — exactly the mistake
doc 84 warned against, just from before that warning was written down.

Read each live body via `pg_get_functiondef` and confirmed each contains the fix it should:

- `submit_withdrawal_request` / `enforce_withdrawal_destination_verified` — both carry the
  `id_verification_exceptions` bypass from doc 75.
- `ensure_payout_destination` — carries doc 74's `is_partner_not_agent` switch and the
  subset-tolerant `payout_name_match_report` call from migration `20260919171500`.
- `enforce_withdrawal_payout_account_lock` — unchanged in substance from its original intent
  (locked-number enforcement on wallet withdrawals); no unexpected content.

No unexpected or unexplained code in any of the four — this is the "known good, just never
fingerprinted" case, not a silent revert. Re-baselined all four (`expected_sha256` updated to the
current live body, `critical_function_baselines.note` appended rather than replaced) and resolved
their `critical_function_drift_alerts` rows in the same pass. `critical_function_drift_alerts` now
has zero open rows.

## Verify this is still working

```sql
select function_signature, detected_at from critical_function_drift_alerts where resolved_at is null;
-- expect zero rows
```

## What not to do

- Don't treat this as an excuse to re-baseline on sight going forward — always read the live body
  first and confirm it matches an already-shipped, intentional fix (as done here) before clearing
  an alert. A future alert on any of these four is a *new* event, not noise.
