# 67 — Selfie upload signs users out mid-capture — native camera handoff had no sign-out suppression

**Fixed in code, not yet deployed (frontend). Before touching `ShotTile` in `IdentityPhotoCapture.tsx`,
or if someone reports being signed out while taking ID/selfie photos.**

## What was reported

2026-09-18, Asiimwe Winfred (256787157289) — same account as doc 64, different bug: "WHEN THEY
UPLOAD THEIR IMAGES THEY ARE SIGNED OUT AND SO THE IMAGES ARE NOT UPLOADED ESPECIALLY THE SELFIE."

## What was found

`src/lib/staleSessionDetector.ts` already has a mechanism for exactly this: `armAuthCriticalSection()`
suppresses a forced sign-out for a bounded window, meant to be called the instant a native
camera/file picker is about to take over the screen — Android in particular can discard the page
while the camera app is in the foreground and resume it with a momentarily stale access token, which
the stale-session detector would otherwise treat as a dead session and sign out. `WithdrawalPayoutCard.tsx`
and `ProoflessPayoutBlocker.tsx` already wire this into their proof-photo `<input type="file">`
elements (`onClick` arms, `onChange` disarms).

`IdentityPhotoCapture.tsx`'s `ShotTile` — the component behind National ID front/back **and the
selfie** — was never wired up. The two ID shots have a fallback in practice (`onCustomCapture` opens
`CardCameraCapture`, an in-page `getUserMedia` camera per doc 54, which never backgrounds the page).
The selfie has no such fallback (doc 54 explicitly left it out of scope) — it always goes through
`ShotTile`'s plain hidden `<input capture="user">`, i.e. always hands off to the phone's real camera
app. That's the one shot with no protection at all, matching "especially the selfie" exactly.

## What was fixed

`ShotTile`'s hidden file input now calls `armAuthCriticalSection(180_000)` in `onClick` (before the
camera/picker opens) and `disarmAuthCriticalSection()` in every `onChange` branch (file picked, too
large, or cancelled). This covers the ID shots too when they fall back to the native picker (e.g. the
in-page camera failing/being declined), at no cost since arming twice is harmless.

## What not to do

- Don't assume the in-page `CardCameraCapture` camera (doc 54) makes this class of bug impossible
  everywhere — it only protects the two ID shots it's wired into. Any capture path that still hands
  off to the OS camera app (the selfie, or either ID shot's explicit fallback) needs its own
  arm/disarm around that handoff.
- Don't wire `armAuthCriticalSection` only around the upload call — the window that actually needs
  covering is between opening the native picker and the page resuming, which can be *before*
  `onChange` ever fires (the page may be torn down and rebuilt from scratch). Arm on `onClick`, not
  inside the async upload logic that runs after a file is already picked.
