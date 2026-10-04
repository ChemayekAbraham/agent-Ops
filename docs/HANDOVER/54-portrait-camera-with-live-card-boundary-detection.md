# 54 — National ID scan forced landscape phone rotation; replaced with an in-page portrait camera + live edge detection

**Read this before touching `IdentityPhotoCapture.tsx`'s `ShotTile`/camera wiring, or
`CardCameraCapture.tsx` / `cardEdgeDetection.ts` — or if someone reports the ID-scan step is
awkward to hold, or that the scanner isn't auto-detecting the card.**

## What was reported

Josh forwarded two screenshots (Moses Ssemanda's National ID) showing the Settings → Withdrawal &
Identity flow: the phone's own native camera app open in landscape (with the phone physically
rotated 90°), and the resulting photo — visibly sideways relative to the phone's natural grip —
sitting in the "National ID — FRONT" tile above the hint text "Turn your phone sideways." The ask:
the phone should not need to be rotated to landscape at all (portrait by default), and the camera
should show a real boundary box that detects the card's edges as it scans, rather than just
telling the person to hold it a certain way.

## What was found

`ShotTile` used a plain `<input type="file" accept="image/*" capture="environment">`. On mobile,
`capture` hands the shot off to the **phone's own camera app** — a separate app we don't control
the layout, chrome, or orientation of. The hint text ("Turn your phone sideways...") existed
because `classifyIdPhotoOrientation` in `nationalIdOcr.ts` treats `width > height` as the
best-case "landscape" orientation, and the surest way to get a landscape-dimensioned photo out of
a phone's native camera app is to physically turn the phone. That's the actual cause of the
awkward two-handed landscape framing in the screenshots — it's a property of the native camera
intent, not something fixable by CSS or copy changes alone.

Worth noting: `readNationalIdPhotoOriented` (`nationalIdOcr.ts`) already retries a photo rotated
0/90/180/270° and keeps whichever reads best (`isSidewaysIdRotation`, `rotateImageFile`), so a
portrait-shaped file was never actually a hard failure for OCR — the landscape instruction was a
UX nudge for best odds, not a technical requirement. That meant the fix didn't need to touch the
reading/rotation pipeline at all.

## What was fixed

Two new files, `src/lib/cardEdgeDetection.ts` (pure edge-detection logic) and
`src/components/wallet/CardCameraCapture.tsx` (the in-page camera UI), replace the native
`<input capture>` flow for the two National ID tiles only (front and back — the selfie tile is
untouched, still uses the native picker, out of scope for this report):

- **Portrait by default.** `CardCameraCapture` opens the camera itself via
  `getUserMedia({ video: { facingMode: 'environment', ... } })` and renders it in a portrait,
  full-screen, in-page view (`object-fit: contain`) — never handing off to the phone's own camera
  app, so there's nothing pushing the person to rotate their phone. A landscape-shaped guide box
  (ISO/IEC 7810 ID-1 ratio, 1.586:1) sits centered inside the portrait frame — the same layout
  banking apps use to scan a card without turning the phone.
- **Live boundary detection.** Every ~130ms, the current frame is downscaled and run through
  `detectCardBoundary` (`cardEdgeDetection.ts`): grayscale → Sobel gradient magnitude → a search
  band around each of the guide box's four edges, picking the strongest edge line per side (a
  peak-to-mean gradient scan, not a fixed box). A width/height ratio sanity check
  (1.2–2.3, ISO card ≈ 1.586) rejects false detections. The result is drawn live as a colored
  boundary — white dashed = still looking, amber = found but not yet stable, green = stable —
  over the video.
- **Auto-capture, with a manual fallback.** Once the same boundary is found for 5 consecutive
  scans (`boundariesAgree`, ~650ms of a held-still card), it auto-captures, cropping to the
  *detected* edges (padded 4%) rather than the phone's whole frame or the static guide box — so
  the resulting file is landscape-dimensioned (matches `classifyIdPhotoOrientation`'s expectation)
  even though the phone stayed upright the whole time. A capture button is always available too,
  for poor lighting / glossy cards where detection doesn't stabilize — it falls back to the last
  detected box, or the static guide box if nothing was ever detected.
- **Graceful degradation.** `getUserMedia` failure (permission denied, no camera, unsupported
  browser — chiefly a desktop concern) shows an error state with a "Use file picker instead"
  button that falls back to the original native `<input capture>` flow via a
  `ShotTile.openFilePicker()` ref handle — nothing was removed, only bypassed by default.
- Updated `ID_POSITION_TIPS` / `ID_BACK_TIPS` and the two `ShotTile` hint strings in
  `nationalIdOcr.ts` / `IdentityPhotoCapture.tsx` to stop telling people to turn the phone
  sideways.

No changes to the reading/rotation pipeline, the edge functions, or any RPC — this is a
capture-mechanism swap on the frontend only. `npm run guard:all` passes (7/7); the schema-types
fingerprint advisory it prints is pre-existing and unrelated.

## What to verify before calling this done

- **Not yet tested on a real device** — build this locally and test on an actual Android/iOS phone
  over HTTPS (camera access requires a secure context; `localhost` is exempt for dev). Confirm:
  camera opens in portrait without prompting rotation, the boundary box tracks a real ID card
  under normal indoor lighting, auto-capture fires within ~1–2s of holding the card still, and the
  captured file reads correctly through the existing OCR flow end to end.
- Confirm behavior on an older/low-end Android WebView and on iOS Safari specifically —
  `getUserMedia` and `screen.orientation.lock` support varies, and `screen.orientation.lock` is
  expected to silently no-op outside a fullscreen/installed context (wrapped in try/catch on
  purpose — the in-page video is the real fix, the lock call is a bonus, not load-bearing).
- Desktop (no `environment` camera, or camera denied) should land cleanly on the file-picker
  fallback — click through it once to confirm the fallback button actually opens the native
  picker via the ref handle.

## What not to do

- Don't reintroduce `<input capture>` as the *primary* path for the two ID tiles — that's the
  mechanism that caused the original landscape-rotation problem; it now exists only as the
  explicit fallback.
- Don't add OpenCV.js/WASM or another CV dependency for this — `cardEdgeDetection.ts` is a
  small, dependency-free Sobel-based edge scan that's already good enough for a card held over a
  contrasting background; it's deliberately not a general-purpose quadrilateral/perspective
  detector.
- Don't touch the selfie `ShotTile` to route through `CardCameraCapture` — it wasn't part of what
  was reported, still opens the native front camera via `<input capture facing="user">`, and this
  report doesn't say whether Gemini has UI plans for that tile.
