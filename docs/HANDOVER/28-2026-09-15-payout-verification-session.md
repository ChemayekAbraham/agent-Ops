# 28 — 2026-09-15/16: payout verification hardening, bot fraud cleanup, and the identity-binding fast path

**Read this when:** touching anything in the payout-destination-verification pipeline,
`national_id_declarations`, `payout_destination_declarations`, the bot-referral-ring hunter,
`fraud_identity_blocks`, `user_identity_bindings`/`national_id_link_requests`, or the withdraw
flow's identity-block banners — or when trying to understand why several parallel identity/payout
verification mechanisms exist side by side. This was one long session; this doc is the index.
[`25-borrowed-identity-payout-consent.md`](./25-borrowed-identity-payout-consent.md) covers the
first two features below in more depth and is not repeated here.

## Migrations from this session — run manually in the SQL editor, in this order

None of these auto-applied on push (same known gotcha as always — verify live before trusting a
migration file). All confirmed live as of 2026-09-15/16:

| # | File | What it does |
|---|---|---|
| 1 | `20260915140000_national_id_declarations.sql` | Table for National-ID-borrowing consent at signup. |
| 2 | `20260915150000_payout_destination_declarations.sql` | Table for payout-destination-borrowing SMS consent. |
| 3 | `20260915160000_index_national_id_normalized_lookup.sql` | Three expression indexes fixing a live `57014` statement timeout. |
| 4 | `20260915170000_reject_and_notify_no_id_payout_destinations.sql` | `national_id_missing_notified_at` column + `candidates_missing_id_payout()` RPC + cron. |
| 5 | `20260915180000_block_deleted_bot_identifiers_from_resignup.sql` | Fixes `scan_and_quarantine_bot_referral_rings()` + backfills `fraud_identity_blocks`. |
| 6 | `20260915190000_national_id_link_otp_activates_immediately.sql` | Collapses the National-ID-link approval chain to one OTP. |

## 1–2. National ID borrowing at signup + payout destination SMS consent

See [`25-borrowed-identity-payout-consent.md`](./25-borrowed-identity-payout-consent.md) for the
full design. One-line summary: `register-tenant`/`tenant-self-onboarding` gate a name-mismatched
National ID behind an SMS code sent to the claimed owner (`national_id_declarations`); a mismatched
payout destination can be resolved the same way (`payout_destination_declarations`,
`payout-destination-consent` edge function) instead of only via a Financial Ops phone call.

**Follow-up fix in this session**: `payout-destination-consent`'s `request`/`confirm` actions
originally only worked on `status = 'waiting'`. The bulk reject in §5 below swept 574 destinations
to `status = 'rejected'` with a `decision_reason` telling the withdrawer to "use the
payout-destination consent flow" — which then refused to even start. Fixed
(`2c466b246`) to also accept `'rejected'`, **except** the two fraud-specific auto-rejects
(double submission, duplicate National ID) — those stay locked, since proving phone control
doesn't resolve either concern. Confirmed live case: Shafiq Senabulya's real MTN number,
registered to a family member ("sebunya yasin"), was stuck exactly this way.

## 3. `finops_payout_verification_queue` statement timeout (57014)

**Symptom**: the Financial Ops payout queue timed out loading (`57014 canceling statement due to
statement timeout`) whenever `p_status='waiting'`.

**Root cause**: `duplicate_national_id_owner()` does a normalized-national-ID lookup against
`public.profiles` (96,573 rows) with no matching expression index, so every call fell back to a
full sequential scan — and the queue function calls it **twice per row**, for every row on a page,
plus runs its own separately-normalized duplicate check inline (a syntactically different
expression needing its own index; Postgres expression indexes only match an identical expression
tree). Fix (`1de5b9145`): three expression indexes, purely additive, no function logic changed.

## 4. AI-vision ID photo enforcement + no-ID auto-reject sweep (`8fe6d14d8`)

Two gaps closed:

1. **`submit_identity_photos` never checked that the "National ID photo" was actually an ID.**
   The AI-vision check (`read-national-id`) only ran client-side as an optional autofill helper and
   could be skipped entirely — the RPC stored whatever was uploaded with no content check. New edge
   function `submit-identity-photos` runs that check server-side (same Lovable AI model/prompt),
   rejecting obvious non-ID/unreadable photos before they reach the RPC. **Fails open** if the AI
   gateway itself is unavailable, closed only when it confidently says the photo isn't an ID.
   `useSubmitIdentityPhotos` now routes through it instead of calling the RPC directly.
2. **New cron sweep** (`reject-unverified-payout-destinations`, every 15 min, batched 100/run):
   auto-rejects `payout_destination_verifications` rows stuck in `waiting` where the user has
   submitted **no identity photos at all** (1,887 users / 3,115 of the then-3,301 waiting rows,
   confirmed live 2026-09-15), and SMS's them once. Doesn't change whether they can withdraw
   (`waiting` and `rejected` both already blocked payout) — replaces an indefinite silent queue
   with a clear status and a one-time nudge.

## 5. Bot referral ring — real, but mostly already contained

Investigated after a claim that `QuickRegisterTenantDialog.tsx` was "where fraud enters from" — it
isn't; that dialog has **zero** rows ever in `signup_attempts`, meaning the actual fraud never went
through any in-app registration tool. It matches the exact fingerprint from
[`21`](./21-referral-bonus-bot-signup-fraud-ring.md)/[`23`](./23-automated-bot-referral-ring-hunter.md)/[`24`](./24-orphaned-bot-accounts-from-frozen-referrers.md):
direct calls to Supabase Auth's public signup API, bypassing the app entirely.

**Scale found**: 19 agent accounts each referred 100+ never-active tenant profiles within a 7-day
window, totaling 34,018 referred accounts — **34,008 (99.97%) were already soft-deleted** by the
existing `scan-bot-referral-rings` cron (runs every 30 min) by the time this was checked. All 19
referrers were already frozen. The real, already-working **blocking** mechanism is
`handle_new_user()`'s real-time trigger-level velocity guard (5/hour or 10/day per referrer,
hardened 2026-09-14) — confirmed **zero** referrer has exceeded that cap since 05:07 on 2026-09-14;
the 30-min cron is a secondary cleanup pass for softer patterns, not the primary defense.

**Real gap found and fixed** (`2de75fd99`): the purge/soft-delete never added the bot's original
email/phone/National ID to `fraud_identity_blocks` before scrubbing it — so a purged fraud
identifier was free to sign up again immediately, since `handle_new_user()`'s
`is_fraud_identifier_blocked()` check only blocks identifiers actually in that table. Fixed
`scan_and_quarantine_bot_referral_rings()` to block every bot's and referrer's identifiers *before*
the scrub overwrites them (order matters), and backfilled `fraud_identity_blocks` from
`deleted_accounts`' pre-scrub snapshot for every account purged historically, not just future ones.

**Not done**: permanent (hard) deletion of the already-soft-deleted rows. `profiles` is referenced
by 40+ other tables, most `NO ACTION`/`RESTRICT` not `CASCADE` — a blind hard-delete would fail with
FK violations the moment any dependent table (even a notification log) has a row for that account.
Scoped as separate future work, not attempted live. The PII is already scrubbed and these accounts
are already excluded from platform-user counts (`20260915090000_exclude_deleted_accounts_from_platform_users.sql`,
Gemini/Pius's work, not this session's), so the practical harm is already contained.

## 6. Bulk payout-destination cleanup — 91 accounts, 574 destinations

Started from one Financial Ops review screen ("Bukoma Peter", selfie matched his ID, but the
payout number was registered to "Mary" — a different person). Pushed back on the instinct to
auto-verify just because the *identity* photo matched: identity match and destination-ownership
match are different questions. Investigation found this was a real, common pattern, not a
one-off — his account alone had **11 different payout numbers under 11 different names**, no
merchant/cashout-agent role to justify it.

Widened the check platform-wide: **91 accounts, 574 destinations**, every single one scoring
`< 0.5` on the name-match with no merchant role justifying a third-party destination. All 574
rejected with an auto-generated per-destination reason, and 79 unique affected users SMS'd (three
message-wording iterations, the last landing on: point to `welileapp.com/settings`, mention
**both** National ID and mobile money number as things to fix). Same rejection reason text is what
made §2's `payout-destination-consent` fix (accepting `'rejected'`, not just `'waiting'`)
necessary — this bulk action would otherwise have dead-ended the exact recovery path it told people
to use.

## 7. Withdraw-flow UX fixes

Three separate, unrelated bugs found via real user screenshots, all in `WithdrawFlow.tsx`:

1. **`bf26353c3`**: `NationalIdRejectedReminder`'s `onResubmit={() => setCurrentStep(0)}` was a
   no-op — the banner already renders on step 0 ("Select Source"), so clicking "Resubmit National
   ID" while already there changed nothing, and passing `onResubmit` at all suppressed the
   banner's own working inline form. Fixed by removing the prop.
2. **`bf26353c3`** (same commit): two *separate* mechanisms were both rendering a "your ID/payout
   was rejected" banner on the same screen — `NationalIdRejectedReminder` (raw
   `payout_destination_verifications` rows) and a newer inline block driven by
   `payout_withdrawal_block_reasons` (headline + checklist + `IdentityPhotoCapture`, part of Pius's
   identity-binding work, §8). They pull from *different* destinations when a user has more than
   one rejected, so the two banners could cite two different people's names for the same account.
   Suppressed the older banner whenever the newer, more complete one is active.
3. **`18a75a1f8`**: Gemini's "Add My Details Now" button (added per a brief from this session, for
   a real case where a user read the block checklist but had no actionable button and just tapped
   "Continue") originally scrolled to the inline identity-capture form on the same step. Changed to
   navigate straight to `/settings?section=account&tab=verification` instead, per direct
   instruction — removed the now-redundant "Or complete in Settings" link and the dead
   `handleScrollToIdentity` function it used.

## 8. National ID Group Linking + the identity-binding fast path

**This is Pius's system, not built in this session** — discovered mid-session via a 124-commit
pull. Two parts:

- **`national_id_link_requests`** (`request_national_id_link`, `NationalIdLinkFlow`,
  `national-id-link-otp` edge function): lets someone link their account to a National ID number
  already on file for a different account. Originally a 3-step chain: OTP to the holder's number →
  holder taps "Yes" in a non-dismissible in-app dialog → staff confirms with a reason. Only the
  staff-confirm step wrote `profiles.linked_national_id`.
- **`user_identity_bindings`** (`complete_identity_binding()`, `resolve_withdrawal_destination()`):
  a newer, more permissive system — once National ID + both photos + a phone-ownership-confirmed
  payout number are captured, Financial Ops review is bypassed entirely and the destination
  auto-flips to `verified`. This is very likely the substance behind an internal "withdrawals are
  now instant" announcement that prompted a fact-check this session (see below).

**Real problem found**: 3,127 sub-agents have neither their own National ID nor a linked one; 624
of them have a withdrawable balance, ~UGX 3.1M stuck. `request_national_id_link()` already worked
for this — it only needs a valid-shaped NIN already on file for *someone*, no photo submission
required from the requester — but the UI only ever surfaced it after a duplicate-photo-detection
trigger, so someone with **no ID card to photograph** never saw the option existed. (Separately
briefed to Gemini: add a standalone "I don't have my own National ID — link to a guarantor's"
entry point, not gated on that trigger. Recommended guarantor: the sub-agent's **parent agent**,
not whoever a distant relative's registered mobile money number happens to name — reachable in
person, unlike e.g. a relative in Gulu while the sub-agent is in Entebbe.)

**Fix shipped** (`14f13d360`, explicit decision by Josh): `national_id_link_mark_code_verified()`
now activates the link (`status='active'`, writes `profiles.linked_national_id`) the instant the
OTP verifies, instead of waiting on the separate in-app holder tap and staff confirmation. Relaying
the code is treated as full consent — same standard already used for payout-destination consent.
Staff confirmation moves from a blocking gate to an audit step: every OTP-activated link is stamped
with a distinctive `decision_reason` so it stays visible and revocable after the fact. Does not
touch `national_id_link_staff_confirm()` or the owner-approve-in-app path — left in place for any
other entry point still using the original 3-step flow.

**Remaining gap, not solved**: `complete_identity_binding()` still requires the sub-agent's *own*
`national_id_photo_path` and `selfie_photo_path` — linking the NIN number alone isn't enough, they
still need a photo of *some* ID (e.g. the guarantor's physical card) plus their own selfie. A
sub-agent with zero access to any physical ID at all is still stuck. Open question, not decided.

**Also found and fixed by the other session working this same area** (not this session's work, but
worth knowing): `6557ab8f0` — the 2026-09-15 `user_identity_bindings` backfill (migration `0118`)
had a tiebreak bug picking an arbitrary `payout_destination_verifications` row per user when
several shared an identical `created_at`; 10 of 31 backfilled bindings were locked to a completely
unrelated person's payout number (one case: a tenant's withdrawal identity was locked to her
landlord's mobile money number). Revoked; no money was actually misdirected before the fix landed.

## 9. Settings "Identity verification" section

Built by Gemini from a brief this session (`4b33043ad`, `3f59f7b4c`): a `NationalIdCard.tsx` (NIN +
name entry, `useSubmitNationalId`) and a reused `IdentityPhotoCapture` inside a renamed "Withdrawal
& Identity" Settings tab, with `?tab=verification` / `?tab=identity` deep-link aliases. Lets users
complete verification proactively instead of only inside the withdraw flow. No new backend needed
— pure composition of existing hooks/RPCs.

## Fact-check performed, not a code change

An internal broadcast ("withdrawals are now open to everyone, no queue, verified right away,
without limits...") was checked against live data. Findings: "clear rejection reasons" was
accurate; "no queue"/"right away"/"without limits" were not — 2,713 destinations were still
`waiting` at the time, `enforce_cash_guard` and `advance_withdrawals_paused` were both ON, and
instant auto-verify only covers a narrow ≥90%-match case (measured: 1 immediately-eligible
destination, 17 more pending only a photo upload, out of the full waiting queue). "Cannot be
changed after confirmed" is also overstated — there's a legitimate Financial-Ops-approved
`payout_number_change_requests` process. No corrective message was sent as part of this session;
this was research to inform Josh's own reply.

## If you touch this area again

- Check `docs/HANDOVER/10-impact-mandatory-payout-verification.md` first — its central warning
  (never auto-reject a name mismatch outright; legitimate name/payout differences are common,
  [[feedback_account_name_vs_momo_name_differ]]) is why every gate built this session is
  self-service-recoverable, not a hard wall.
- `national_id_declarations` / `payout_destination_declarations` (this session) and
  `national_id_link_requests` / `user_identity_bindings` (Pius, discovered mid-session) are four
  **separate, non-integrated** systems solving overlapping problems. Don't assume fixing one fixes
  another — confirmed twice this session (the `payout-destination-consent` 'rejected' gap, the
  duplicate withdraw-flow banner) that they silently diverge.
- Before trusting any "X is now live/instant/unlimited" claim about this area from any source,
  re-run the verification queries in this doc and in doc 10 — the true state changes fast and this
  session found real gaps between announced behavior and actual behavior twice.
