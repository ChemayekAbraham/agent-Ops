# Learn deposit numbers so the same person is never re-queued

Today, when Financial Ops manually routes an email deposit, or the matcher
identifies a depositor by name, the system remembers nothing. The same person's
next deposit from the same number lands back in the manual queue. This adds a
third, growing source of known deposit numbers per user, learned only from
positive identifications, plus a one-time SMS nudging depositors toward their
registered number.

## What changes for people

- Financial Ops routes an unrecognized deposit once. From then on, deposits from
  that number auto-credit.
- The depositor gets one SMS the first time a new number is linked, telling them
  it was credited, that the number is now linked, and to prefer their registered
  number for instant crediting. No SMS on later deposits from that number.
- If a number is already linked to a *different* user, nothing is overwritten —
  it is flagged for Financial Ops to review (SIM swap or earlier mistake).

## Technical plan

### 1. New table `public.user_deposit_numbers`

Columns exactly as specified: `id`, `user_id` → `profiles(id)`, `phone_last9`,
`source` (`manual_route` | `name_match_auto`), `linked_gmail_transaction_id` →
`gmail_transactions(id)`, `created_by`, `created_at`, `UNIQUE (user_id, phone_last9)`.
Plus an index on `phone_last9` for the lookup path.

GRANTs then RLS: read/write for `cfo`, `financial_ops`, `manager`, `super_admin`
via `has_role`; `service_role` full (edge functions write here). No anon.

A companion table `public.user_deposit_number_conflicts` records the guardrail
case: `phone_last9`, `attempted_user_id`, `existing_user_id`, `existing_source`
(`user_deposit_numbers` | `profiles.phone` | `profiles.mobile_money_number`),
`gmail_transaction_id`, `detected_via` (`manual_route` | `name_match_auto`),
`resolved_at`, `resolved_by`, `notes`. Same finance-role RLS.

### 2. One consolidated phone lookup

New SQL function `public.resolve_user_by_known_phone(p_last9 text)` returning
`(user_id uuid, full_name text, phone text, email text, source text, match_count int)`,
checking `profiles.phone`, `profiles.mobile_money_number`, and
`user_deposit_numbers.phone_last9` in a single query, with the existing
"exactly one user or no match" rule preserved (`match_count > 1` → caller skips,
same as today's ambiguity behavior).

`supabase/functions/gmail-poll-transactions/index.ts`: replace all three
duplicated `.or(phone.ilike…, mobile_money_number.ilike…)` queries (the
counterparty resolver near line 1247, the primary matcher near line 1813, and
the third call site near line 2448) with calls to this function. The
body-phone fallback's per-number probes also go through it, so a learned number
resolves at the cheapest first step and never falls through to the name branch.
Normalization is unchanged: strip non-digits, take the last 9.

### 3. Trigger point A — manual Financial Ops routing

- `RouteEmailDepositDialog.tsx` already carries `matched_phone` (and extracts a
  number from the email body) for display text — thread it into the
  `cfo-direct-credit` request body as `source_phone`, together with the existing
  `gmail_transaction_id`.
- `cfo-direct-credit/index.ts`: accept and validate `source_phone` (optional).
  After a successful `credit` to a user, normalize to last 9 and:
  - already known for this user → do nothing, no SMS;
  - known for a different user (any of the three sources) → insert a
    `user_deposit_number_conflicts` row, no link, no SMS;
  - otherwise → insert `user_deposit_numbers` with `source='manual_route'`,
    `linked_gmail_transaction_id`, `created_by` = operator, and send the
    first-time SMS via `_shared/sendSmsMultiProvider.ts` (own message, separate
    from `notify-email-routing`'s existing routed-to-wallet SMS).
  Insert uses `ON CONFLICT DO NOTHING` and the SMS fires only when a row was
  actually created, so re-runs never duplicate either.
  Linking failures are logged and never fail the credit.

### 4. Trigger point B — high-confidence name match

In `gmail-poll-transactions`, after a match resolves with `matchMethod === 'name'`
and `nameMatchAudit.confidence === 'high'` (exact-unique-name, or the
`only-profile-with-phone` tiebreaker only):

- Reuse the last-9 set already scanned from counterparty + subject + snippet +
  body by the body-phone fallback (hoist that set so it is available here). If
  exactly one candidate last9 is present, apply the same three-way decision as
  above with `source='name_match_auto'`, `created_by` null, no SMS.
- No phones found, several distinct candidate numbers, or confidence
  `medium`/`low` (`most-recent-active`, `first-candidate`) → record nothing, no
  error, no behavior change.

### 5. Financial Ops visibility

Add a small "Number link conflicts" section to
`src/components/financial-ops/EmailTransactionsPanel.tsx` listing open
`user_deposit_number_conflicts` rows (number tail, both users, how it was
detected) with a "Mark reviewed" action stamping `resolved_at` / `resolved_by`.
Unmatched-transaction stats, tiles, and the manual routing flow are untouched.

## Verification

- Route a deposit manually from an unregistered number, then re-run the matcher
  on a second email from that same number: it resolves at the phone step.
- Simulate a high-confidence name match with a phone in the body: row created;
  next deposit resolves by phone.
- Name match with no phone in the email, and medium/low confidence matches:
  no row, no error.
- Repeat both paths for an already-known number: no duplicate row, no second SMS.
- Point a number owned by another user at a new user: conflict row appears in the
  FinOps panel, existing link unchanged.
- Build and typecheck green; security linter clean for the new tables.
