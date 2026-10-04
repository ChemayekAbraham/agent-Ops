# 58 — Cleared a National ID wrongly recorded on Kalule Sharif's account, freeing it for its real owner (Ssemanda Moses)

**Read this before touching `duplicate_national_id_owner`, `national_id_holder_hint`, or
`submit_national_id_details`, or if someone reports "This National ID is already on
[somebody]'s Welile account" for a person who can show you the physical card.**

## What was reported

Josh forwarded a screenshot of the National ID link/consent screen for Moses Ssemanda
(`9188db01-e54a-4f84-8de9-042e6b5b6bd6`, "SSEMANDA MOSES"): his NIN `CM030521139F5D` was already
recorded on a Welile account under the name "Kalule," offering to add Ssemanda under Kalule's ID
pending Kalule's consent. Josh had already seen photographs of Ssemanda's actual physical National
ID card (forwarded separately, see the camera-scanner work earlier this session) confirming the
name, photo and NIN match his own account — so Kalule is not the real holder, and asked for the ID
to be unlinked from wherever it was sitting so Ssemanda could register it himself.

## What was found

`CM030521139F5D` was on `profiles.national_id` for **Kalule Sharif**
(`3f87c1f3-6564-478d-a08d-43da24614c80`, `sharifkc264@gmail.com`, created 2026-03-25), but with
**no supporting evidence whatsoever**:

- Zero rows in `national_id_readings` — this NIN never went through the actual scan/confirm flow
  on this account at all (that table only exists since 2026-09-15; this profile's `national_id`
  was set earlier, almost certainly by an older code path or a data import, not by the person
  photographing a card).
- `national_id_name` was `null` — inconsistent with `submit_national_id_details`, which always
  sets both together.
- No ID photo, no back photo, no selfie (`national_id_photo_path`/`..._back_photo_path`/
  `selfie_photo_path`/`identity_photos_submitted_at` all null).
- Phone blank (`''`/`null` depending on which column) — meaning the one open
  `national_id_link_requests` row for this NIN (`002276d1-...`, `status: awaiting_owner`) could
  never actually proceed either; there was nowhere to send the holder a consent code.
- Zero rows in `payout_destination_verifications` for this account — the NIN was never used to
  attempt a withdrawal, so `duplicate_national_id_owner`'s second check (verified destinations)
  was never in play either.

Meanwhile Ssemanda's own destination (`49a8421a-...`, `0752760263`, `account_name`/
`national_id_name` both "SSEMANDA MOSES") sat in `status = 'waiting'`, blocked purely because
`duplicate_national_id_owner()` — called from both `submit_national_id_details` and the live
`national_id_holder_hint` typing check — matched his NIN against Kalule Sharif's `profiles` row
via `normalize_national_id_fuzzy`.

## What was fixed

Confirmed with Josh before writing (the query tool runs writes against production immediately,
no dry-run), then, scoped to Kalule Sharif's account only:

```sql
UPDATE public.profiles SET national_id = NULL, national_id_name = NULL
 WHERE id = '3f87c1f3-6564-478d-a08d-43da24614c80';
```

plus an `audit_logs` row (`action_type = 'manual_national_id_unlink'`) recording the reasoning and
old/new values. Verified after: `duplicate_national_id_owner('9188db01-...', 'CM030521139F5D')`
now returns `NULL` — Ssemanda's own submission is no longer blocked. Nothing else on Kalule
Sharif's account (roles, wallet, other fields) was touched.

No code or migration change — this was a one-off production data correction, same shape as
[`50-manual-unlink-denis-tushabe-from-ian-muhwezi.md`](./50-manual-unlink-denis-tushabe-from-ian-muhwezi.md).

## What to tell Ssemanda Moses right now

Ask him to reopen Settings → Withdrawal & Identity and resubmit his National ID details (or just
retry if he's still on that screen) — the "already registered to Kalule" block and the consent
flow are both gone now; his NIN will save straight to his own account and his already-confirmed
payout number (`0752760263`) can move out of `waiting` once his ID/selfie photos are sent.

## What was not touched, and why

- The open `national_id_link_requests` row (`002276d1-...`) was left as-is. It's now moot — once
  Ssemanda resubmits, `duplicate_national_id_owner` won't route him through the link/consent flow
  at all, so this stale row is simply orphaned, and it auto-expires on its own (2026-09-24, per the
  screen's own copy) with no action needed.
- Kalule Sharif's account itself (roles, wallet, login) was not otherwise touched or disabled. If
  this NIN really is theirs and they re-enter it correctly with photos later, nothing here prevents
  that — this correction only removed an unevidenced claim, it didn't ban the value.

## What not to do

- Don't treat "This National ID is already on [X]'s account" as settled just because a row exists.
  Check the same three things checked here before assuming the existing holder is legitimate:
  `national_id_readings` (was it ever actually scanned?), the photo path columns (was anything
  submitted?), and `payout_destination_verifications.status` (was it ever used for a real
  withdrawal?). A bare `profiles.national_id` value with none of those behind it is weak evidence
  against someone holding the physical card.
- Don't assume a `national_id_link_requests` row must be explicitly cancelled once the underlying
  duplicate is cleared — it isn't consulted by the live duplicate check, and it expires on its own.
