# 187 — Landlord OTP is now refused while landlord float withdrawals are paused

**Built 2026-10-02. Edge functions only, no migration. Not yet deployed.**

## What agents saw
With `landlord_float_withdrawals_paused` ON, an agent could still tap
"Withdraw float", the landlord still received an OTP SMS, and the agent could
still enter it ("Verification Complete"). Only then did
`landlord-payout-disburse` fail, because the pause was enforced solely by the
`enforce_landlord_payout_eligibility()` trigger on `landlord_payouts` INSERT
(doc: migration `20260917120000`). The failure showed as a brief toast; the
wizard then sat on "Final payout is being processed…" with a useless Retry.
Agents reasonably reported "we withdrew and got the OTP".

Evidence: challenges `6bc574d1…`, `dedd706a…`, `7dd678f8…` (Nyanzi Lydia Eseri,
landlord 0746700783, UGX 300,000) all `verified`, `resulting_payout_id` null,
event `disburse_failed: Landlord float withdrawals are currently paused…`.
No `landlord_payouts` row was created after the pause (12:26:52 UTC 2026-10-01).

## Change
- `issue-landlord-payout-otp`: checks `landlord_float_withdrawals_paused()`
  right after auth, before the resend path and before any SMS. HTTP 423,
  `code: landlord_float_withdrawals_paused`, "No OTP was sent".
- `verify-landlord-payout-otp`: same check before the code is compared, so a
  correct code is never consumed and no stranded `verified` challenge is left.
  Logs `failed / withdrawals_paused`.
- Both **fail closed**: if the flag cannot be read, treat as paused.

## Not changed / still open
- Wizard UI still shows "Final payout is being processed…" for already-stranded
  verified challenges; it should show the paused reason (UI/Gemini + a small
  handler change).
- `landlord_payouts_blocked` is a separate switch that only hides queue rows.
  Per-row `landlord_block_exempt_at` bypasses it: on 2026-10-02 06:59 UTC four
  pre-pause payouts (UGX 12.5M: Namere Babra, weyikilize Evalyn, Gloria
  Nakalekwa, kalinaki enerst) were exempted under the CEO account and paid by
  merchant desks 07:08–07:18 UTC. Settlement legs were still missing
  (`unsettled`) at 07:40.

## Deploy
Edge functions must be deployed (Lovable publish alone does not deploy them):
`issue-landlord-payout-otp`, `verify-landlord-payout-otp`.
