# 78 — Settings: upload an existing photo, not just camera capture, for National ID / selfie

**Fixed in code, not yet deployed (frontend).** Before touching `ShotTile` in
`IdentityPhotoCapture.tsx`, or if someone asks why the ID/selfie step forces a live camera shot
with no way to pick a photo already on the device.

## What was asked

In Settings' identity verification step, let the user upload a file/image of the National ID and
selfie, instead of only being able to take a new photo.

## What was found

Every capture path on this screen ended at either the in-page camera (`CardCameraCapture.tsx` for
the two ID shots, `SelfieCameraCapture.tsx` for the selfie — doc 54, doc 68) or, as a fallback for
camera-permission-denied/unsupported browsers, a native `<input type="file" capture=...>`. That
native input carries a `capture` attribute, which on most mobile browsers skips the normal file
chooser and jumps straight into the camera app — there was no path anywhere on this screen to pick
an existing photo (a scan already saved on the phone, a photo taken earlier, a picture received
over WhatsApp, etc.).

## What was changed

`ShotTile` (the shared tile used for all three shots — ID front, ID back, selfie) now renders two
buttons side by side instead of one:

- **Take photo** — unchanged: opens the in-page camera if `onCustomCapture` is wired (all three
  tiles have it), else falls back to the native camera-hinted input.
- **Upload** — new: a second hidden `<input type="file" accept="image/*">` with **no** `capture`
  attribute, so the browser shows its normal picker (gallery/Files/Downloads, not just the camera
  app). Same `MAX_BYTES` size check and the same `onPick` handler as every other capture path, so
  the OCR read, face check, and everything downstream treats an uploaded file identically to a
  freshly taken one — no new code path to keep in sync.

Extracted the shared "validate size, then hand off to `onPick`" logic into one `acceptPicked`
helper used by both inputs' `onChange`, instead of duplicating it. The `armAuthCriticalSection`
Android sign-out-suppression dance (doc 67) stays scoped to the camera-hinted input only — a plain
gallery/file picker doesn't hand the page off to another app the way the camera does, so there is
nothing here for it to protect against.

## Files

- `src/components/wallet/IdentityPhotoCapture.tsx` (`ShotTile` only — no other component changed)

## What not to do

- Don't add a third, separate upload flow for the selfie vs the two ID shots — `ShotTile` is
  already shared across all three, so this fix covers all three shots for free. A selfie-specific
  copy would drift from the ID shots' behavior over time.
- Don't add `capture` to the new upload input — that defeats the entire point of this change on the
  browsers where it matters most (Android Chrome).
- Don't assume this needs `armAuthCriticalSection` — that guard exists for the camera-app handoff
  specifically (doc 67); a plain file picker doesn't leave the page the same way.
