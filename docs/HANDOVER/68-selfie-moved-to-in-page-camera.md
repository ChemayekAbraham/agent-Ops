# 68 — Selfie capture moved to an in-page camera, same as the National ID shots

**Fixed in code, not yet deployed (frontend). Follows directly from doc 67 — read that first.**

## What was asked

After doc 67 shipped (suppressing forced sign-out around the selfie's native-camera handoff), Josh
asked for the selfie to use the in-page camera the same way the National ID front/back shots already
do, rather than relying on the sign-out suppression window around a handoff to the phone's camera app.

## What was done

Added `SelfieCameraCapture.tsx`, a front-facing (`facingMode: 'user'`) `getUserMedia` camera modeled
on `CardCameraCapture.tsx` (doc 54) — live preview, an oval framing guide, manual tap-to-capture (no
auto-detection: there's no card-edge-style boundary to look for in a face, so unlike the ID scanner
this never auto-fires). The preview is mirrored (`scaleX(-1)`) for a natural "look in a mirror" feel;
the captured frame itself is drawn unmirrored, so the archived original matches what the camera
actually saw, which is what Financial Ops needs.

`IdentityPhotoCapture.tsx`: the selfie's `ShotTile` now passes `onCustomCapture={() =>
setCameraTarget('selfie')}` (the same wiring the two ID shots already use), and `cameraTarget`'s type
grew a `'selfie'` member alongside `'front' | 'back'`. The inline `onPick` body that used to live on
the `ShotTile` was pulled out into a named `handleSelfiePick`, so both the "Take photo" native-input
fallback and the new in-page camera's `onCapture` call the exact same code path (mirrors how
`handleFrontPick`/`handleBackPick` are already shared between the ID shots' two capture paths).

The native `<input capture="user">` path (doc 67's `armAuthCriticalSection` fix) stays wired up as
`onFallback` — same pattern as the ID shots — for camera-permission-denied or unsupported-browser
cases. It is now the fallback, not the primary path, so doc 67's suppression window matters far less
often but is not redundant: it's still what protects that fallback route.

## What not to do

- Don't add card-style auto-capture (edge detection / a stability streak) to the selfie camera — a
  face has no rectangular boundary to detect, and forcing that model on here would either never fire
  or fire on garbage. Manual capture is the correct shape for this shot, not a shortcut.
- Don't mirror the captured file, only the live `<video>` preview. The verification original must
  show the face as the camera saw it; only the on-screen preview should feel like a mirror.
- If the selfie is reported as signing people out again after this ships, check whether they hit the
  `onFallback` native-picker path (permission denied / old browser) before assuming doc 67's fix
  regressed — that's the one remaining path this doc didn't remove.
