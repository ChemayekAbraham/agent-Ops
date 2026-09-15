# Borrowed-identity consent: National ID at signup + payout destinations (2026-09-15)

**Read this when:** a tenant registration or a withdrawal is blocked on a national-ID or
payout-destination name mismatch, before touching `national_id_declarations`,
`payout_destination_declarations`, `_shared/nationalIdDeclaration.ts`,
`_shared/payoutDestinationDeclaration.ts`, `register-tenant`, `tenant-self-onboarding`, or
`payout-destination-consent` — or before scoping further work on the
`payout_destination_verifications` backlog described in
[`10-impact-mandatory-payout-verification.md`](./10-impact-mandatory-payout-verification.md).

## Policy this implements

Josh's stated policy: **one account, one national ID, one phone number.** But in practice
someone sometimes registers, or receives a payout, using a phone number or National ID that is
genuinely registered to a different person (a relative's SIM, a relative's ID because they don't
have their own yet). Rather than hard-blocking that forever, the fix in both cases is the same
shape: **the real owner must confirm by SMS code before the account is allowed to use their
identity/number**, and the borrower is linked to the owner for audit purposes only — **the owner
never earns anything and is never charged anything** because of the borrower's activity.

Two independent features were built same-day, sharing the same consent-code/hash/TTL pattern and
the pre-existing `payout_name_match_report()` name-scorer:

| # | Feature | Commit | Live in production? |
|---|---|---|---|
| 1 | National ID borrowing at tenant signup | `9dd4de08b` | **Yes** — `national_id_declarations` confirmed to exist live, 2026-09-15 |
| 2 | Payout destination borrowing (mobile money / bank) | `d30c09955` | **Yes** — `payout_destination_declarations` confirmed to exist live, 2026-09-15 (run manually in the SQL editor, same day) |

Both migrations (`20260915140000_national_id_declarations.sql` and
`20260915150000_payout_destination_declarations.sql`) were run manually in the SQL editor on
2026-09-15 — this was **not** an automatic migration-on-push; re-verify with the query below
before assuming any *future* migration file in this repo is live without checking. Both edge
functions (`register-tenant` / `tenant-self-onboarding`'s gate, and `payout-destination-consent`)
are safe to call now — the tables they write to exist. Verify with:

```sql
select table_name from information_schema.tables
where table_schema='public'
  and table_name in ('national_id_declarations','payout_destination_declarations');
```

## Feature 1: National ID borrowing at signup

**Files:** `supabase/migrations/20260915140000_national_id_declarations.sql`,
`supabase/functions/_shared/nationalIdDeclaration.ts`, gate wired into
`supabase/functions/register-tenant/index.ts` and
`supabase/functions/tenant-self-onboarding/index.ts`.

**How it works:** both signup functions already validate `national_id`. They now also accept an
optional `national_id_name` (the name printed on the ID). When it's supplied and doesn't token-match
the registrant's `full_name` (`payout_name_match_report()` score < 0.34), the function returns
HTTP 409 with `code: "id_owner_consent_required"` instead of completing registration:

- `stage: "awaiting_owner_phone"` — client must collect the ID owner's phone and resubmit with
  `id_owner_phone`.
- `stage: "awaiting_code"` — a code was SMSed to that phone; client resubmits with the same
  `consent_declaration_id` plus `consent_code`.

On a correct code, the borrower's profile is linked to `national_id_declarations.id_owner_profile_id`
(if the owner already has an account) and registration proceeds normally.

**This is a no-op today.** No signup UI currently sends `national_id_name`, `id_owner_phone`, or
`consent_code` — confirmed by the same evidence `10-impact-mandatory-payout-verification.md`
already found (`profiles.national_id_name` was 0 rows as of 2026-09-13/14; re-check before
assuming this has changed). **The frontend wiring (the actual form fields and the two-step
"enter owner's phone → enter code" UX) has not been built** — that's the next piece of work,
and is UI work (Gemini's lane per `CLAUDE.md`), not a backend gap.

**Deliberately isolated from commission.** `national_id_declarations` is never read by any
commission/referral code. Confirmed by tracing agent commission attribution: it runs off
`rent_requests.agent_id` (stamped once at rent-request creation) and `profiles.referrer_id`
(referral tree) — neither is written or read by this table. The ID owner cannot end up earning
anything from the borrower's account through this mechanism.

**Existing mismatches were deliberately left alone.** A production check on 2026-09-15 found 6
accounts already registered with a `national_id_name` that doesn't match their own `full_name`
(e.g. account "Fahad Matovu" holding an ID for "Ntwasi Derrick"). Per Josh's explicit decision,
these were **not** retroactively frozen or backfilled with a declaration — only new registrations
going forward are gated. Re-run this if you need the current list:

```sql
select id, full_name, national_id_name, national_id, phone, created_at
from profiles
where national_id_name is not null and btrim(national_id_name) <> ''
and similarity(lower(btrim(full_name)), lower(btrim(national_id_name))) < 0.4
order by created_at desc;
```

## Feature 2: Payout destination borrowing (mobile money / bank)

**Files:** `supabase/migrations/20260915150000_payout_destination_declarations.sql` (**not yet
run — see above**), `supabase/functions/_shared/payoutDestinationDeclaration.ts`, new edge
function `supabase/functions/payout-destination-consent/index.ts` (actions `request` / `confirm`).

**Why this exists:** `payout_destination_verifications.status = 'waiting'` genuinely blocks a
withdrawal — confirmed via `10-impact-mandatory-payout-verification.md`'s investigation and a
fresh read of the enforcement code: the gate is checked in three places (`submit_withdrawal_request`
RPC, the `enforce_withdrawal_destination_verified()` insert trigger, and `approve-withdrawal`'s
`withdrawal_destination_gate()` call at approval time). As of 2026-09-15 there are **3,301 rows
stuck in `waiting`** (2,699 mobile money, 602 bank; only 48 verified, 11 rejected) — close to but
not identical to doc 10's 3,346 measured a day earlier; re-run before trusting either number:

```sql
select status, count(*),
  count(*) filter (where destination_type='mobile_money') as momo,
  count(*) filter (where destination_type='bank_transfer') as bank
from payout_destination_verifications group by status;
```

The only existing way to clear a `waiting` row is a Financial Ops staffer manually phoning the
destination owner and calling `finops_decide_payout_destination` (requires a ≥10-character call
summary — see `PayoutVerificationPanel.tsx`). This feature adds a **second, self-service path**:
the withdrawing user asks the real destination owner to confirm by SMS code.

- **Mobile money:** the code is SMSed straight to the destination's own `momo_number` — no extra
  input needed. A correct code proves control of that SIM, which is what the manual phone call was
  already trying to establish.
- **Bank transfer:** there's no phone number inherent to a bank account, so the withdrawer must
  supply the owner's phone (`owner_phone` in the `request` call) — same shape as the National ID
  flow.
- On a correct code, `confirmPayoutDestinationConsent()` flips `payout_destination_verifications`
  straight to `status = 'verified'`, `call_outcome = 'sms_consent'`, `decided_by = null` — **this
  is Josh's explicit decision: SMS owner-consent auto-verifies and bypasses Financial Ops
  entirely**, treated as equivalent to a phone-call confirmation. It does **not** touch the
  existing 3-layer gate logic (`payout_destination_is_verified`, `withdrawal_destination_gate`) —
  it only adds a way to *satisfy* that gate. The update is guarded with
  `.eq("status", "waiting")` so it can never clobber a decision Ops already made.

**Built to reach the existing backlog, not just new destinations.** Any `waiting` row — old or
new — can be resolved this way once a UI exists to trigger it; there's no batch/retroactive
migration needed because nothing about the mechanism is time-scoped.

**Relationship to doc 10's open question.** `10-impact-mandatory-payout-verification.md` asked
"why isn't the 3,346-row backlog draining, and any name-match rule needs a human-override path,
not a hard auto-reject" before anyone adds more scope on top of it. This feature is exactly that:
it doesn't add a new block, it adds a second way to *drain* the existing one, and it never
hard-rejects a mismatch — the user just gets an extra path to resolve it themselves instead of
waiting on Ops capacity.

**Not yet done, both UI (Gemini's lane):**
1. A "Verify this destination" action somewhere a user currently sees "Waiting for verification —
   Financial Ops will call you" (`WithdrawFlow.tsx`, `DestinationVerificationTimeline.tsx`) that
   calls `payout-destination-consent` with `action: "request"`, then a code-entry step calling
   `action: "confirm"`.
2. The client already has read access to its own `payout_destination_verifications` rows (RLS
   policy "Owner reads own payout destinations"), so it can fetch `destination_verification_id`
   directly — no new read endpoint needed.

## If you touch this again

- Both new tables are RLS-enabled with **no policies granted** — they're readable/writable only
  by edge functions using the service role. Don't add an `authenticated` policy without thinking
  through whether a user should be able to read another user's declaration row.
- The name-mismatch threshold (`payout_name_match_report()` score < 0.34) is a judgment call, not
  a validated fraud signal — see [[feedback_account_name_vs_momo_name_differ]]: legitimate account
  name / payout name mismatches are common and must never be auto-treated as fraud. This mechanism
  is designed around that reality (self-service resolution, not auto-reject) — don't tighten it
  into a hard block without re-reading that finding.
- Before deploying any *new* migration in this repo, confirm it has actually been run against
  production — the guard suite (`npm run guard:all`) does not check live schema, only static
  code, and (per `docs/HANDOVER/07-tribal-knowledge.md` / `06-live-state-verification.md`)
  migrations in this repo do not reliably auto-apply on push. Both migrations here needed a
  manual run in the SQL editor before their edge functions would work.
- If you generalize these two tables into one shared `identity_declarations` table later, check
  every place that currently hardcodes `national_id_declarations` / `payout_destination_declarations`
  column names in `_shared/nationalIdDeclaration.ts` and `_shared/payoutDestinationDeclaration.ts`
  — they are two independent tables today, not a shared abstraction, by design (kept simple over
  DRY since this was new, not yet proven-out code).
