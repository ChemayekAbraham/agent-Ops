# 59 — "Send my photos for verification" looked stuck/silent — the reason it was disabled was scrolled out of view

**Read this before touching the Send button, `sendError`, or the `blockers` panel in
`IdentityPhotoCapture.tsx`, or if someone reports the send button "does nothing" or "fails
silently" on Settings → Withdrawal & Identity.**

## What was reported

Following on from doc 58 (Moses Ssemanda's National ID unblocked): Josh reported the "Send my
photos for verification" button on Ssemanda's account "is not submitting his details, it is
failing silently" — no error, nothing visibly happens.

## What was found

Checked the account live (`9188db01-e54a-4f84-8de9-042e6b5b6bd6`): `national_id`/`national_id_name`
and the payout number's `ownership_code_confirmed_at` are all correctly saved. But
`national_id_photo_path` / `national_id_back_photo_path` / `selfie_photo_path` /
`identity_photos_submitted_at` were still all `null`, and there are **zero objects** in the
`identity-verification` storage bucket for this user — no upload has ever actually reached the
server, and `audit_logs` has no `submit_identity_photos`/`national_id_details_submitted` attempt
around the reported time either. So the click genuinely isn't reaching the network at all.

The Send button's `disabled` prop only checks three things:

```ts
disabled={saving || !hasVerifiedPayoutNumber || !confirmDone}
```

`confirmDone` requires the person to explicitly tap **"Yes, these are correct"** on the read-back
panel after taking a fresh ID photo (`needsConfirm = !!idPhoto && !!idReading && ...`) — that panel
render's its own state client-side only and is never persisted, so it resets on every page reload.
The *explanation* for why the button is disabled (the `blockers` list, including "Confirm the
details we read from your ID...") was rendered **above** `PayoutNumberVerification`, i.e. above the
"Confirm your payout number" panel visible in the screenshot Josh forwarded — anyone scrolled down
to the Send button at the bottom of the page would never see it. A disabled primary button with its
one explanatory sentence scrolled off-screen reads exactly like "failing silently," even though the
app was behaving as designed (nothing is sent until every step, including the explicit confirm tap,
is done in that session).

This is the second time this shape of bug has shown up in this component — doc 52 was the server
response leaving no path forward at all; this one is the button visibly present but its reason for
being disabled invisible at scroll position.

## What was fixed

Moved both the `sendError` alert and the `!sendError && blockers.length > 0` "Before you can send"
list from above `<PayoutNumberVerification>` to directly above the Send button itself (after it,
right before the button). Same conditions, same content — this is a reorder, not a rewrite. Now
whatever is blocking Send (missing photo, unconfirmed read-back, unverified payout number, a
mismatched name, anything) is the last thing rendered before the button a person is about to tap,
regardless of how far they've scrolled past everything above it.

Also folded the previously-standalone `{!hasVerifiedPayoutNumber && (...)}` hint into the same
`blockers` list it already duplicated (that exact sentence — "Confirm your payout number with the
code." — was already one of the `blockers` entries), so there's one blockers panel instead of two
overlapping messages in different places.

No backend/RPC change — this account's photos genuinely have never been submitted; there is no
server-side bug to fix for Ssemanda specifically. He (or whoever is guiding him) needs to: attach a
fresh front photo, wait for the read, tap "Yes, these are correct," attach the back photo, attach a
selfie, then tap Send — all in one sitting, since none of it persists across a reload until the
final send succeeds.

## What to check if this is reported again

- `identity_photos_submitted_at` and the three `*_photo_path` columns on `profiles`, plus
  `storage.objects` under `identity-verification/<user_id>/` — if all empty/null, the send call has
  never reached the server; don't look for a bug in `submit_identity_photos` or the upload path,
  look for why the button is disabled (screenshot the WHOLE page, from the ID front tile down).
- If photos genuinely ARE attached and confirmed and it still doesn't send, check `audit_logs` for
  `national_id_details_submitted` (should fire before the photo upload — `saveDetails()` runs
  first in `handleSave`) — if that's missing too, the button was still disabled, not "submitted and
  failed."

## What not to do

- Don't assume "failing silently" means a server/network bug before checking whether anything ever
  reached the server at all (storage objects, `identity_photos_submitted_at`, `audit_logs`) — a
  disabled button that gives no on-screen reason at the scroll position the person is looking at
  produces the exact same symptom.
