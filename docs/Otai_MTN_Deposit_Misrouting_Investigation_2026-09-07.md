# Otai MTN Deposit Misrouting — Investigation & Fixes (2026-09-07)

## Trigger

Tenant Abraham Samwuel Otai is registered in the app with an Airtel number
but pays rent via a different MTN number. A screenshot of his MTN "you have
paid" confirmation (UGX 256,000, TID `43337003074`, till `090777`) prompted
an investigation into whether the payment matched his account correctly.

## What was found

1. **The payment did not match Otai's account.** Live production data
   (`gmail_transactions`, `deposit_requests`, `user_deposit_names`) showed
   the deposit auto-approved and credited as `operational_float` to an
   unrelated profile, "sir ian martin" (`3d78f1f8-f690-4fe8-bb2e-202f3ef2ecb0`).

2. **Root cause: a stale `user_deposit_names` mapping.** A `manual_route`
   row created 2026-08-26 mapped the normalized payer name
   `"ABRAHAM SAMWUEL OTAI"` → Sir Ian Martin's profile, with
   `contested: false`. The MTN auto-credit matcher trusts such mappings
   permanently once created, with no expiry or re-verification.

3. **Sir Ian Martin's account had become a general dumping ground.**
   Fifteen-plus unrelated payer names were routed there via the same
   `manual_route` mechanism, including obvious parser artifacts —
   `"YOU HAVE RECEIVED"` and `"RECEIVED."` — that had been mis-extracted
   as if they were sender names (see root cause #2 in the parser bug below).

4. **Historical impact for Otai specifically:** across 8 MTN payments since
   2026-05-29 (total UGX 2,592,000), none had ever landed in Otai's own
   profile — 2 went to a different unrelated profile (Mukhaye Lydia), 5
   never auto-matched at all, and 1 (today's) went to Sir Ian Martin.

5. **Two duplicate "Otai Abraham" profiles exist.** Only
   `aad13004-b80d-4611-b982-bac335c9dc9e` has real rent activity — a
   completed 800,000 rent plan and a second 800,000 plan currently
   `repaying` (512,000 of 800,000 repaid, 288,000 outstanding). The other
   profile (`9d5b1a58-...`, tenant_status `active`) has zero rent history
   and is a dead duplicate; it was mistakenly used in the first pass at
   this fix before being corrected.

6. **Deeper root cause — the MTN parser itself was broken.** MTN's actual
   "received" credit template is:
   `"You have received UGX X from (NAME) 256XXXXXXXXX..."`
   The sender's phone number IS present in the message (contrary to the
   code's prior assumption), but the parser's name-capture regex required
   the character right after `"from "` to be `[A-Z]`. Here it's `"("`, so
   the regex silently matched nothing — neither name nor phone was
   captured. This affects **~108 MTN inbound receipts in the last 30 days**
   alone (confirmed against live `gmail_transactions` data), not just
   Otai's case. It is also the likely origin of the "YOU HAVE RECEIVED" /
   "RECEIVED." garbage entries in `user_deposit_names` (#3 above).

## Fixes applied

### Database (live, via direct SQL against production)

- Marked the bad mapping (`"ABRAHAM SAMWUEL OTAI"` → Sir Ian Martin) as
  `contested: true`.
- Added the correct mapping: `"ABRAHAM SAMWUEL OTAI"` →
  `aad13004-b80d-4611-b982-bac335c9dc9e` (the profile with the actual
  repaying rent plan).
- Captured as migrations:
  `supabase/migrations/20260907185000_otai_deposit_name_correction.sql`
  `supabase/migrations/20260907185700_otai_deposit_name_correction_v2.sql`

### Code

- `supabase/functions/gmail-poll-transactions/index.ts`:
  - `parseTransaction` now recognizes the `"from (NAME) 256XXXXXXXXX"`
    shape, capturing the phone into `counterparty` (the field the exact
    phone-match pipeline keys on) and the name into a new
    `counterparty_name` field (used only as a fallback signal).
  - The MTN name-match fallback in `_tryAutoCreditOperationalFloat` now
    prefers `counterparty_name` when present, instead of re-deriving a
    "name" from `counterparty` (which now correctly holds a phone for this
    shape).
  - Verified against real message text for both the phone-bearing shape
    (Mary Nandudu, 20+ affected historical transactions) and the
    genuinely phone-less shape (Otai's own message) — both parse
    correctly.
  - **Not yet deployed** — this is a code change to a live edge function;
    deployment was intentionally left for explicit sign-off given it
    changes live wallet-crediting behavior.

## Still outstanding / needs a decision

1. **Deploy the parser fix** to `gmail-poll-transactions`.
2. **Backfill historical rows**: ~108+ MTN receipts (last 30 days) sitting
   with `counterparty = null` because of the parser bug won't self-correct
   after deployment — the existing `reparse` mode only targets rows with
   `parsed=false OR amount IS NULL`, which these aren't. A widened backfill
   pass (or one-off script) is needed to re-run `parseTransaction` over
   their stored `raw_body` and update `counterparty`/`counterparty_name`.
3. **Reverse today's wrong credit**: UGX 256,000 currently sitting in Sir
   Ian Martin's operational float needs to move to Otai's outstanding
   288,000 balance — this is a real money movement and should go through
   an appropriate RPC / Financial Ops process, not a raw SQL edit.
4. **~UGX 1.8M in earlier unmatched Otai payments** (5 transactions,
   2026-05-29 through 2026-08-31) never landed anywhere and should be
   reconciled against his outstanding balance.
5. **Duplicate profile cleanup**: the dead-duplicate Otai profile
   (`9d5b1a58-...`) and likely other similar duplicates elsewhere should be
   flagged/merged — duplicate names are what make name-based matching
   fragile in the first place.
6. Consider whether `Sir Ian Martin`'s legitimate personal deposits
   (currently flagged in `agent_misrouted_deposits_preview` for
   `personal_deposit` → `operational_float` reclassification) are a
   separate, unrelated issue that also needs attention.
