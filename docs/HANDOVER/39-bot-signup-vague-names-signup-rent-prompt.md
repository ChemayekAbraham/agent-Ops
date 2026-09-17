# 39 — "Vague name" tenant SMS traced to two separate bot-referral bursts

**Read this before trusting `profiles.full_name` for any tenant-facing SMS audience, before
touching the 2026-08-18 signup burst or referrer `OKIROR ANDREW` (`67d9e313-1bfb-4535-88f7-a19fef811689`),
and before assuming `scan_and_quarantine_bot_referral_rings` (doc 23) catches every bot ring.**

## What was reported

Josh noticed tenant SMS like `"Hi Fzhdh, you can now request rent from Welile..."` — a real
send from `notify-new-signup-rent-prompt` (invites every new sign-up with a phone number to
request a Rent Plan; see that function's header comment) where the greeting name is obviously
not a real person.

## Finding 1 — the 2026-08-18 16:50-17:30 UTC signup burst (what "Fzhdh" belongs to)

70 accounts created in a 40-minute window. 62 share just 5 referrers:

| Referrer | Referred (this burst) | Frozen already? |
|---|---|---|
| Frank Walu | 11 | yes (2026-08-24) |
| Mucunguzi Eliias Mucu | 10 | yes (2026-08-19) |
| Ampire Tobbi | 6 | yes (2026-08-24) |
| Nakiyimba fairuzi | 1 | no |
| *(referrer_id present, no matching profile — orphaned/deleted)* | 1 | n/a |

**Why the existing hunter (doc 23) never purged these:** `scan_and_quarantine_bot_referral_rings`
only scans `profiles.created_at > now() - interval '48 hours'`. Three of the five referrers above
*were* eventually frozen by that hunter — for bursts closer to their freeze dates — but by the
time each freeze fired, this particular 2026-08-18 batch was already more than 48 hours old and
fell outside the "recent" window the hunter re-scans. The hunter freezes the referrer and purges
only the bots that are still inside its 48h window at scan time; anything older survives
indefinitely. This is a different mechanism than doc 24's "orphaned bots from frozen referrers"
gap (that one is about `referrer_id` getting stripped at signup time) — same family of bug,
different cause.

**Classified all 70, verified against `general_ledger` and `rent_requests`:**

- **46 confirmed bots** — unambiguous gibberish or sentence-fragment names: `Th Ehf Eh`,
  `Ny Sb Sh`, `Vj Vm`, `Enb Ey Wy`, `Wicked The Maple`, `Michael This Field`, `First`, `Facrt`,
  `Sacah`, `Twanty`, etc. (full list in the migration's git history / this session's transcript).
- **15 ambiguous** — single common first names (`Bruce`, `Alice`, `Jackson`, `Muhumuza`, `Bright`,
  `Angel`, `Zuhaiba`, `Shukuran`, `Alaika`, `Kerebu`, `Young`, `Naba`, `Kapyima`, `Alian`, `Naka`)
  that a real Ugandan tenant could plausibly use when a form only asks for a first name. No text
  signal distinguishes these from the confirmed group; **Josh chose to include them** in the purge
  (same burst, same referrers, same zero-activity fingerprint as the confirmed 46).
- **9 protected — real people, do not touch**: `Polly Steven Wangudi`, `Isooba James`,
  `Emmanuel Byamukama`, `Mirembe Jalia`, `Akantorana Banex` (an actual `@welile.agent` agent
  account), `Kawuma Allen` and `Kivumbi Kato` (both real Proton Mail addresses, each already paid
  a legitimate UGX 100 referral bonus), `Mukaga Rashid`, `EVA NNABWAMI` — all real Gmail/Proton
  addresses caught in the same 40-minute window by coincidence.

**Verified before purging:** all 61 (confirmed + ambiguous) have **zero** `general_ledger` rows;
any `rent_requests` row among them is permanently stuck at `service_center_review` (never funded,
never disbursed) — no real money or tenancy is affected by removing them.

**Action:** `supabase/migrations/20260916140000_purge_signup_rent_prompt_bot_burst.sql` soft-deletes
exactly these 61 (asserts the count is 61 before doing anything, aborts otherwise), using the same
mechanism doc 23's hunter uses — `deleted_accounts` insert, PII scrub, `is_frozen = true`,
`audit_logs` row — not a hard `DELETE`. The direct write was refused by the auto-mode classifier
(`[Unverifiable Deletion Scope]`), same as the cron migration in doc 33, so Josh ran it by hand via
the Supabase SQL editor.

**Resolved 2026-09-16.** Verified directly against production, not just the migration's own
`raise notice`:

```
profiles with deletion_reason ilike '%Manual review, 2026-09-16%'  -> 61 (all is_frozen = true)
deleted_accounts rows with matching reason                          -> 61
audit_logs rows with metadata->>'session' = 'manual-review-2026-09-16' -> 61
protected accounts (the 9 real people) accidentally touched         -> 0
```

All 61 confirmed/likely-bot accounts from the burst are purged; the 9 real people are untouched.

## Finding 2 — OKIROR ANDREW: a second, larger, currently-undetected ring

While tracing referrers, one showed an extreme signature the SMS burst didn't have: multiple
sub-hour windows with referred_count in the dozens and only 1-6 distinct names. Referrer
`OKIROR ANDREW` (`67d9e313-1bfb-4535-88f7-a19fef811689`) is **not frozen**, still fully active.

- **709 total referred accounts**, all created 2026-07-21 17:00 → 2026-07-23 08:03 UTC (39 hours).
- Every single name is literal chat/test text, not an attempt at a real name: `"morning"` (166
  times), `"morning too"` (61), `"know"`, `"please"`, `"qwerty keyboard"`, `"zoom meeting"`,
  `"hello kitty"`, `"don't know"`, `"sorry babe"`, `"good morning"`, plus ~320 `"User NNNN"`
  placeholder-style names.
- **Zero** `general_ledger` rows and **zero** `rent_requests` across all 709 — nobody in this tree
  ever did anything real on the platform.
- Emails are `@welile.agent` (agent signups), not the usual `@noapp.welile.user` tenant
  placeholder pattern.
- **OKIROR ANDREW profited**: 1,274 `general_ledger` rows with `description ilike '%referral%'`
  totaling **UGX 382,200**, dated exactly 2026-07-21 → 2026-07-23 — the same window as the junk
  signups. Also 12 withdrawals totaling UGX 191,000 in the days right after, though this account
  has substantial unrelated legitimate agent activity too, so "was the fraudulent UGX 382,200
  specifically what got withdrawn" cannot be cleanly separated from ledger rows alone — needs a
  human FinOps read, not an automated split.

**Why doc 23's hunter has never caught this:** its detection query requires
`synthetic_email_count::numeric / referred_count < 0.5` — it treats a *high* ratio of
`@welile.agent`/`@welile.user`/`@noapp.welile.user` emails as evidence of ordinary phone-only mass
signup (which is legitimate and common), not fraud. This ring is ~100% synthetic-email, so it
passes cleanly through the side of that gate meant to protect real users. **This is a real,
unaddressed inversion in the hunter's own logic, not just an unlucky miss** — worth revisiting
before trusting doc 23 as complete coverage a third time (doc 31 already found one hunter-evading
ring via the opposite property, high name diversity).

**Decided, not yet built:** Josh asked to freeze OKIROR ANDREW's *referral ability only*, leaving
the rest of his (apparently real, ongoing) agent account active. **This capability does not exist
in the schema.** `profiles.is_frozen` (set by `fraud_block_user_identifiers`, the function doc
23's hunter calls) is account-wide — it also blocks every one of the account's phone/mobile-money
identifiers from ever registering a NEW account, per that function's definition. There is no
`referral_disabled`-style column, and `try_credit_qualified_referrals` (doc 21) does not check one.
Building a narrower gate means: a new boolean column, a check added into the referral-crediting
path, and (probably) into `get_referral_progress`'s eligibility read — real schema + function work,
not a one-line toggle. Not attempted here; flagged back to Josh rather than faked with a
workaround. The 709 junk referred accounts themselves were not purged either, pending that
decision (purging the referred accounts doesn't require solving the referrer question first, but
was held so both pieces of this ring get resolved together rather than in two separate passes).

## Open items

1. ~~Run `20260916140000_purge_signup_rent_prompt_bot_burst.sql`~~ — done, verified 2026-09-16.
2. Decide + build the OKIROR ANDREW referral-only-freeze mechanism, or fall back to a full account
   freeze / hold-for-manual-review — see "Decided, not yet built" above.
3. Purge OKIROR ANDREW's 709 junk referred accounts once the referrer question is settled.
4. Consider whether `scan_and_quarantine_bot_referral_rings`'s `synthetic_email_count < 0.5` gate
   needs a second branch for the ~100%-synthetic case, so a ring shaped like OKIROR ANDREW's
   doesn't require a manual trace to find again.
