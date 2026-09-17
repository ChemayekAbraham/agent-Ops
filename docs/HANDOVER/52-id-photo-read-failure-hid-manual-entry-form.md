# 52 — A failed National ID scan hid the manual-entry fallback, stranding the person

**Read this before touching `readIdPhoto` in `IdentityPhotoCapture.tsx`, or `readNationalIdPhoto`/
`readNationalIdPhotoOriented` in `nationalIdOcr.ts` — or if someone reports being stuck on the
"Withdrawal & Identity" screen after "Could not read that photo automatically."**

**2026-09-17 update — the fix below was written but sat unpushed on the local `lovable` branch
for a while (commit `1b33ca67d`). In that window `origin/lovable` moved 13 commits ahead under a
separate change (Gemini's "Auto-rotated sideways ID photos" rewrite of this same file), which did
**not** carry the fallback — so Shakirah hit the identical dead end again on a later attempt, and
her `profiles` row still showed no photos at all (`has_id_front/has_id_back/has_selfie` all false,
`identity_photos_submitted_at` null). Merged the two histories (clean auto-merge, fix intact and
compatible with the new rotation logic), ran `guard:all` (all 7 pass), and pushed —
`aa112eebc..ef7398be3` on `origin/lovable`. Lesson: a local fix commit on this repo is not "done"
until `git log origin/lovable..HEAD` is empty for it — check that before telling anyone a fix is
live, this is the second time in this folder a real fix sat undeployed (see doc 47/48's identical
"fixed in code, not yet deployed" caveats).**

## What was reported

Josh forwarded WhatsApp screenshots of Shakirah Nakimbugwe (`34ed279b-f6cf-4291-ab0f-1339b8afe28c`,
+256746722190 no — +256770603906) working through Settings → Withdrawal & Identity: a selfie
(passed, with a cosmetic "not passport-style" advisory), a National ID front photo that came back
"Could not read that photo automatically," then two payout-number attempts six minutes apart — one
to a stranger's number (`0707556990`, "kayemba sharif"), one to her own (`0770603906`,
"Nakimbugwe Shakirah", matching her ID) with a code confirmed by SMS. Also forwarded: an older,
unrelated case (Nattu Sharifah, `cc3bacad-ad59-412d-ac4d-df99aee61cb0`) already resolved on
2026-09-16 (see below) — included for pattern-matching, not itself broken.

## What was found

Checked her live state:

```sql
select national_id_photo_path is not null as has_id_front,
       national_id_back_photo_path is not null as has_id_back,
       selfie_photo_path is not null as has_selfie,
       identity_photos_submitted_at
from profiles where id = '34ed279b-f6cf-4291-ab0f-1339b8afe28c';
-- all false / null
```

She has **no photos on file at all** despite the screenshots showing her take both. But
`payout_destination_verifications` shows she *did* get through `submit_national_id_details` at
2026-09-17 05:18 UTC (an earlier, successful attempt, before the screenshots) and *did* OTP-confirm
her real, name-matching number (`0770603906`) at 05:57 UTC — both destinations still sit in
`status = 'waiting'` because the photo-send step (`submit_identity_photos`) never completed.

The blocker: **`readIdPhoto()` in `IdentityPhotoCapture.tsx` only renders the manual six-field
entry form when `idReading` is non-null** (`{!reading && idReading && (...)}`, ~line 1199). A
transport failure — the `read-national-id` edge function call itself erroring, not just reading
the card poorly — hit this branch:

```ts
const res = await readNationalIdPhotoOriented(file);
if ('error' in res && res.error) {
  setReadError(res.error);   // only this — idReading was never set
  setReading(false);
  return;
}
```

`nationalIdOcr.ts`'s own docstring on `readNationalIdPhoto` says the point of returning
`{ error }` instead of throwing is "so the person can still type their details by hand" — but
nothing consumed that promise. `idReading` stayed `null`, so the entire manual-entry section
(the six `Input`s, the confirm step, everything) never rendered. She could see the error message
and a "Retake" button and nothing else. If a retake changed nothing (same weak light, same card),
she'd loop on that message forever with no way to type the fields in herself — exactly what
happened here between her 08:18 attempt (which must have read fine, since it got as far as
`submit_national_id_details`) and the 08:51 screenshot (a retake that failed outright).

This is a different, narrower case than an `incomplete` reading (the reader reached PassGate and
some fields came back unreadable) — that path already works and already shows the manual form.
Only the total-failure branch (network blip, PassGate timeout, edge function cold-start) was
affected.

## What was fixed

`readIdPhoto()` now treats a transport failure the same as an `incomplete` read: it synthesizes a
fallback `NationalIdReading` (`status: 'incomplete'`, all six fields in `missing`) and resets
`form` to empty, so the existing manual-entry UI — already built and tested for a genuinely
incomplete card read — renders and lets the person type every field by hand and confirm. The raw
`readError` message is kept alongside it (harmless, if slightly redundant with
`readingGuidance`'s "Almost nothing could be read on that card" line). No new UI was built; this
reuses the `incomplete` path that already existed.

## What to tell Shakirah Nakimbugwe right now

Her real, name-matching, OTP-confirmed number (`0770603906`) is one completed photo-submission away
from moving out of `waiting`. Ask her to reopen Settings → Withdrawal & Identity and send her ID
and selfie again — with the fix, a repeat automatic-read failure will no longer dead-end her; she
can type the six fields from her card by hand and continue. The stray attempt at `0707556990`
("kayemba sharif") is a different destination row and does not need to be touched — leave it; it
simply stays `waiting` until she resolves it herself (delete it, or a reviewer calls the actual
holder), same as [[feedback_account_name_vs_momo_name_differ]] says for any other mismatched
destination.

## What was checked and found already resolved (Nattu Sharifah, not this bug)

Her two destinations (`0781455293` "Luvumba sowedi", mismatch tokens `nattu/sharifah/sowedi/luvumba`;
`0781515171` "Sharifah Nattu", exact match) both show `status = 'verified'` now — the mismatched one
was manually verified by Financial Ops on 2026-09-16 11:15 ("name taken from the National ID"), and
the matching one auto-verified on 2026-09-14 via an unrelated "name re-verification bug fix"
already shipped. The "Get owner to confirm by SMS" self-service panel visible in her forwarded
screenshot (from 2026-09-15, before either fix landed) is the frontend piece
[`25-borrowed-identity-payout-consent.md`](./25-borrowed-identity-payout-consent.md) said was still
missing — it has since been built and is live; nothing to do here.

## What not to do

- Don't assume "Could not read that photo automatically" means the person is stuck for good — it
  isn't a hard block, but it *was* a dead end until this fix. Don't close a similar report without
  checking whether `identity_photos_submitted_at` is actually null (truly stuck) versus merely
  `payout_destination_verifications.status = 'waiting'` awaiting a Financial Ops call (working as
  designed).
- Don't touch the `kayemba sharif` / `0707556990` row — a stray or borrowed-number attempt sitting
  in `waiting` is normal, not a bug, and not evidence of fraud on its own.
