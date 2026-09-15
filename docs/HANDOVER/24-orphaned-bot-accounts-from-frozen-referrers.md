# 24 — Orphaned bot accounts from already-frozen referrers

**Read this before assuming the bot cleanup from `21` is complete, or before extending
`scan_and_quarantine_bot_referral_rings()`.**

## What was found

A colleague-supplied screenshot of the Fake Account Radar's "Same name as several
unconfirmed accounts" signal showed 8 active "Carol Musa" accounts (classic
keyboard-mash-shrinking email pattern:
`frfbbsjdhhfjfbhfhjfkfbfjf@gmail.com` → … → `frfbbsjdhh@gmail.com`, all created within
3 minutes on 2026-09-11) that had survived every cleanup pass in `21`.

Their `profiles.referrer_id` was `NULL` — which is why every prior referrer_id-keyed
sweep found nothing to group them under. But their original signup metadata
(`auth.users.raw_user_meta_data->>'referrer_id'`) still named
`fa5835e4-32f2-42cd-97f4-caa4717a9a78` — one of the 24 referrers already frozen the
day before.

**Root cause**: `handle_new_user()` validates the referrer at signup time and drops
`referrer_id` to `NULL` if the named referrer is frozen (`COALESCE(p.is_frozen, FALSE)
= FALSE` fails). That's the *correct* behavior for stopping the fraud — no `referrals`
row forms, so no bonus is possible. But it has a side effect: the bot account itself
still gets created (nothing blocks account creation itself, only the referral link),
and it now looks like an ordinary referrer-less signup to every referrer_id-based
detector, including the scheduled hunter from `23`.

## What was fixed

1. One-time purge of the 8 orphaned "Carol Musa" accounts.
2. `scan_and_quarantine_bot_referral_rings()` extended with a permanent second sweep:
   any active, unconfirmed-email account whose *original signup metadata* names a
   referrer that is *currently frozen* — regardless of what `profiles.referrer_id`
   ended up being — gets purged too. A bot ring that keeps hammering an
   already-frozen referrer no longer leaves invisible debris behind.

## Why this matters for the bigger picture

This is direct proof the same bot operator(s) kept running their script *after* being
frozen, exactly like the `fc7837ea` case documented in `21`. Freezing the referrer
stops the money; it does not stop the script. The `handle_new_user()` velocity guard
(`20260914170000`) is what actually has to stop the account creation itself going
forward — and per the note in `22`, that guard cannot help at all if the ring stops
sending a `referrer_id` in the first place.

## On "how did this happen — was it one of our engineers"

Investigated directly, not assumed:

- **`signup_attempts` has zero rows for any of these accounts.** That table is where
  every signup that goes through the app's own client-side telemetry
  (`preflightSignup()`) or the agent-assisted server-side guard
  (`record_agent_assisted_signup`) gets logged — including internal/staff-assisted
  registrations. Its complete absence here means these accounts were **not** created
  through any of Welile's own registration screens or tools, staff or otherwise — they
  were created by calling Supabase Auth's public signup API directly, bypassing the
  app entirely. This is the same external-script mechanism already fixed in `21`/`22`,
  not an internal tool being misused.
- **Checked `origin/lovable`'s git history** for any seed/test-data script or migration
  that could account for this. Nothing found. This is expected: creating a user
  account is a runtime action against the live database, not a code change — it will
  never appear as a git commit regardless of who or what did it. Git commit
  authorship (which the Lovable/Gemini sync pipeline does preserve per the session's
  own working agreement) can tell you who changed the *code*; it cannot tell you who
  ran a script against production, because doing so requires no code change at all —
  only a valid Supabase Auth publishable key, which is not a secret.
- If there is a suspicion that a specific person (internal or external) is running
  this script, the only way to get there is external to this database: who has had
  access to a valid referral link for one of the 24 frozen accounts, or — if Supabase
  project logs / API request logs are retained — the calling IP for the `/auth/v1/signup`
  requests around the timestamps in `bot_referral_ring_detections` and
  `deleted_accounts`. Neither of those is queryable from inside Postgres; both would
  need direct Supabase Dashboard/project-log access.

## Other names in the same screenshot, checked and NOT flagged as fraud

- **Bwire Rashid** — 10 accounts total. Several share the same referrer
  (`864b1df4...`, the large *legitimate* agent already validated in `21`/`23`) with the
  exact same name repeated across different phone numbers on 2026-07-23. Worth a
  closer look at that specific agent's data-entry habits (possibly placeholder/test
  names used while training on the registration form), but does not match the fraud
  signature on its own — real, varied phone numbers, no incrementing email pattern,
  and the referring account is not otherwise implicated.
- **John Bosco** — 2 accounts, one created via real Google OAuth (`Mahoro Richard`,
  later renamed), one via plain email a day later with a similar but distinct email.
  Reads as one real person with two accounts (or two real people who share this
  extremely common Ugandan name), not a bot signature — no shared referrer, no burst,
  no synthetic naming.
- **waswa shafik** — 3 accounts, two sharing one referrer (`e55fac57...`) and similar
  emails, 3 minutes apart. Small enough (6 total lifetime signups under that referrer,
  spread over 16 days) that it didn't meet any burst/volume threshold. Ambiguous;
  not acted on.
- **Mulungi** — flagged for a different signal ("name looks made up" — single word,
  no surname), not for duplication. Not part of this investigation.

## Verify this is still fixed

```sql
select count(*) from public.profiles where full_name = 'Carol Musa' and deleted_at is null; -- should be 0

select public.scan_and_quarantine_bot_referral_rings(); -- orphaned_bots_purged should stay 0 going forward
```

## What not to do

- Don't treat "profiles.referrer_id is NULL" as proof an account has no connection to
  a fraud ring — check `auth.users.raw_user_meta_data->>'referrer_id'` too, which
  survives even after the trigger strips the working column.
- Don't expect git history to explain who created a specific user account. It never
  will, for any account, regardless of suspicion — account creation is not a code
  change.
