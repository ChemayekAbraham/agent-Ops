# 64 — "Not in the Financial Ops verification list but can't withdraw" — she's correctly under a different tab, and the block-reason RPC was crashing

**Read this before touching `payout_withdrawal_block_reasons`, or before assuming someone missing
from the Financial Ops payout-verification queue's default ("Waiting") tab has fallen through a
gap. Live as of 2026-09-17.**

## What was reported

Josh: "Asiimwe Winfred (256787157289) is not part of the verification list on Financial Ops but
cannot withdraw."

## What was found

Two separate, unrelated things, both checked against live data (`a9258d45-3e27-4827-af71-64344e76fb4f`):

**1. She isn't missing from the queue — she's correctly under a different filter tab.**
`finops_payout_verification_queue`'s "Waiting" bucket (the default tab
`PayoutVerificationPanel.tsx` opens on) only includes rows where BOTH the National ID photo and the
selfie are already on file (`p.national_id_photo_path IS NOT NULL AND p.selfie_photo_path IS NOT
NULL`) — rows without both photos go to the **"No ID"** tab instead:

```sql
OR (v_status = 'no_id' AND d.status = 'waiting' AND f.user_id IS NULL AND x.user_id IS NULL
    AND NOT (p.national_id_photo_path IS NOT NULL AND p.selfie_photo_path IS NOT NULL))
```

Asiimwe Winfred has two `payout_destination_verifications` rows, both `status = 'waiting'`
(`0787157289` — her real, name-matching number, `name_match_score` 1.00; `0786963421` — a different
name, "MOREEN KOBUSINGE"), but has **submitted no ID/selfie photos at all**
(`national_id_photo_path`/`selfie_photo_path` both null) and never OTP-confirmed either number
(`ownership_code_confirmed_at` null on both). She's exactly where the queue design puts her: "No
ID," not "Waiting." Not a bug — check the "No ID" tab before concluding someone is invisible to
the queue.

**2. `payout_withdrawal_block_reasons()` genuinely crashes for her — and for anyone else in her
exact situation (no `user_identity_bindings` row yet).**

```
ERROR: 55000: record "v_dest" is not assigned yet
DETAIL: The tuple structure of a not-yet-assigned record is indeterminate.
CONTEXT: SQL expression "v_dest.id IS NULL"
PL/pgSQL function payout_withdrawal_block_reasons(uuid) line 49 at IF
```

`v_dest` was declared as an untyped `record`, only ever assigned inside
`IF v_binding.id IS NOT NULL THEN SELECT * INTO v_dest ... END IF;`. For a user with no identity
binding yet (`v_binding.id IS NULL` — the normal starting state, and exactly the population this
function's `identity_not_submitted` branch exists to describe), that `SELECT INTO` never runs at
all — not even a zero-row one — so `v_dest` is never assigned this call. The very next line,
`IF v_dest.id IS NULL THEN`, then crashes: an untyped `record` has no tuple structure at all until
its first assignment, unlike a `SELECT INTO` that ran and matched zero rows (which DOES leave a
valid all-NULL structure). This is the classic PL/pgSQL "unassigned record" gotcha.

Practically: this function is called from the withdraw flow to explain why someone can't withdraw
yet. For anyone who hasn't finished identity capture — i.e. most people the first time they try to
withdraw — it was throwing a raw Postgres exception instead of returning the friendly
"Your withdrawal details are not complete yet" guidance with the specific missing steps.

## What was fixed

`supabase/migrations/20260917160000_fix_payout_withdrawal_block_reasons_unassigned_record.sql` —
`CREATE OR REPLACE FUNCTION`, identical body, only change: `v_dest record;` →
`v_dest public.payout_destination_verifications%ROWTYPE;`. A `%ROWTYPE`-declared variable has a
fixed structure from declaration, so a skipped branch leaves it correctly all-NULL instead of
"never assigned." **Applied directly and verified live** — re-running
`payout_withdrawal_block_reasons('a9258d45-3e27-4827-af71-64344e76fb4f')` now returns:

```json
{"blocked": true, "code": "identity_not_submitted",
 "headline": "Oops! Your withdrawal details are not complete yet.",
 "reasons": ["Take a photo of the front of your National ID.",
             "Take a selfie with your whole face visible."]}
```

`npm run guard:all` passes (7/7).

## What to tell Asiimwe Winfred

She needs to finish Settings → Withdrawal & Identity: take a front ID photo and a selfie (the back
photo isn't flagged as missing by this check, but is required elsewhere — send all three), then the
withdraw screen will explain what's left instead of erroring. Her real number (`0787157289`,
name-matching, `name_match_score` 1.00) is the one to use — the `0786963421` destination
("MOREEN KOBUSINGE") is a different name and shouldn't be confirmed as hers without checking whose
it actually is first, same caution as
[[feedback_account_name_vs_momo_name_differ]] but in the other direction — a mismatch on an
UNconfirmed row is worth a second look, unlike an already-explained concentration pattern.

## What not to do

- Don't treat "missing from the Waiting tab" as a queue bug by itself — check "No ID" first; it's a
  deliberate, correctly-implemented separate bucket for exactly this case.
- Don't add a try/catch or a defensive null-check band-aid around every call site instead of fixing
  the actual variable declaration — the same "untyped `record` accessed via `.field` before any
  branch assigns it" shape can recur anywhere else in this codebase that declares a bare `record`
  and only assigns it conditionally; `%ROWTYPE` (or initializing with a real `SELECT INTO` before
  the conditional) is the correct fix, not a null guard at the call site.
