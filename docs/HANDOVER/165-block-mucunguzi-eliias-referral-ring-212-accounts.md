# 165 — Blocked the Mucunguzi / Eliias referral-bonus ring (212 accounts)

**Date:** 2026-09-29 · **Status:** LIVE. Data-only change via the existing `fraud_block_user_identifiers` RPC. No code or migration.

## Finding

Owner asked for the "215 accounts that have MUCU". `profiles` matches 214 on `full_name ILIKE '%mucu%'` (none by email/previous name beyond those); the 215th was not found (purged, renamed or another field).

- 210 were created 15-19 Aug 2026 (20/54/85/45/6 per day), 207 of the 214 have synthetic `@noapp.welile.user` emails, names are the "Mucunguzi <gibberish> Eliias" pattern, 210 have a referrer and there are only 8 referrers.
- Referrer fan-out: `7731d6bb…` "Mucunguzi Eliias Mucu" 151, `df0ae6a4…` "Tumusime Kato" 39, `4464afa4…` "Mucunguzi Eliias" 15, plus four singletons ("Muhamed Juma", "Eliza Happy", "Wum Fmu", "Nduhura").
- All 214 had a confirmed email, which is why `scan_and_quarantine_bot_referral_rings` (unconfirmed-only) never purged them. Only 19 were frozen, none were in `fraud_identity_blocks`.
- Money: wallets total UGX 6,800; 11 withdrawal requests, UGX 52,800 paid out.

## What was done

1. The 210 accounts created 15-19 Aug: `fraud_block_user_identifiers(id, reason, null)` in a loop. 210/210 frozen, 210 active `user_id` blocks (which also block email, phone, mobile-money number, national id, name and payout-history numbers).
2. On the owner's call, also `Uim Fum Mucu` (`6ac3b341…`, +256783113844) and `Eliias Mucungu` (`6d6ebc14…`, eliiasmucungu@gmail.com; already frozen 09-05, had 10 rent requests and UGX 1,000 withdrawable, untouched).
3. **Not blocked, deliberately:** `MUCUNGUZI FRANCIS` (`c3acefac…`, +256780251426, created 29 Jan, no referrer) and `Mucunguzi` (`8aa5ffc2…`, +256752368974, created 13 Jul, referred by "Nduhura"). They look genuine. Blocking the single-word name would also stop any real "Mucunguzi" from signing up.

Total frozen with "mucu" in the name: 211 of 214 (Eliias Mucungu was already frozen).

Enforcement is as in doc 153: signup refused by `handle_new_user`; sign-in check is client-side in `useAuth` on `profiles.is_frozen`; `auth.users.banned_until` is not set.

## Open items

- The UGX 6,800 in these wallets and the UGX 52,800 already paid out are untouched; no clawback attempted.
- Referrers "Eliza Happy" (`ca2f743b…`) and "Nduhura" (`9bed6c71…`) are not frozen and were not reviewed.
- `scan_and_quarantine_bot_referral_rings` skips accounts with a confirmed email; this ring used confirmed emails. Consider whether the hunter should also catch the pattern (noapp email + gibberish name + tiny referrer set).
- The 215th account was not identified.
