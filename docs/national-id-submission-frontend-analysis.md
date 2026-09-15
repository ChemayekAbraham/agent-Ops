# National ID submission — frontend analysis (phase 1)

Scope narrowed as agreed: **the screens where the user submits**, not the FinOps
vetting queue, which is already built. Verified against the code on
`origin/lovable`, 15 September 2026.

---

## Where submission actually happens

There are **two** surfaces, shown one after the other at the withdraw gate in
[`WithdrawFlow.tsx:1204-1207`](../src/components/payments/WithdrawFlow.tsx#L1204):

```tsx
{needsNationalId && <NationalIdPrompt blocking … />}
{!needsNationalId && needsIdentityPhotos && <IdentityPhotoCapture compact />}
```

| Order | Component | What it does |
| --- | --- | --- |
| 1st | [`NationalIdPrompt.tsx`](../src/components/wallet/NationalIdPrompt.tsx) (159 lines) | **Two typed text boxes** — NIN number and the name printed on the card. No camera, no OCR. Hard stop until filled. |
| 2nd | [`IdentityPhotoCapture.tsx`](../src/components/wallet/IdentityPhotoCapture.tsx) (556 lines) | ID photo + selfie, local quality check, OCR read, selfie crop, submit. |

**This ordering is backwards for what you want.** Today the person types the NIN
from memory *before* the card is ever photographed, then the photo is read
afterwards and compared. Your flow is photo → read → prefill → correct → confirm.
Phase 2 has to merge these two screens into one, or `NationalIdPrompt` becomes
dead weight that asks for something the camera is about to supply.

---

## Step 1 — Photograph the ID and read it

### Already built

- Capture tile with preview, retake and clear — `ShotTile`, lines 36-108.
- **Local photo quality check before upload** — [`src/lib/imageQuality.ts`](../src/lib/imageQuality.ts).
  Pure canvas, no network: variance-of-Laplacian sharpness, share of near-white
  pixels for glare, brightness standard deviation for contrast. Thresholds
  `SHARPNESS_MIN 55`, `GLARE_MAX 0.11`, `CONTRAST_MIN 26`. A failed photo is
  named and blocks send. This is good work and should stay.
- **OCR read on pick** — `readIdPhoto()` → `readNationalIdPhoto()` →
  `read-national-id` edge function.
- A "What we read on your ID" card showing the names and ID number, plus a
  name-match verdict against the account name.
- A "Use these details" button that writes via `submit_national_id`.

### Gaps against your spec

| # | Gap | Where |
| --- | --- | --- |
| 1 | **The read-back is display-only.** Names and number are rendered as text. There is no way to correct a misread. | lines 415-425 |
| 2 | **Date of birth is never shown** — the function already returns it, the UI drops it. | — |
| 3 | **Sex and card number are not extracted at all.** | `read-national-id` prompt |
| 4 | **"Use these details" sends only two fields** — `nationalId` and `idName`. `submit_national_id(p_national_id, p_id_name)` accepts nothing else, so DOB, sex and card number have nowhere to go even once extracted. | `saveDetectedDetails()`, line 243 |
| 5 | No single **Confirm** that commits the whole reviewed set and starts the background checks. Today "Use these details" saves immediately and separately from the photo submit. | — |

### The question I need answered before phase 2

You said you have extended the API for National ID OCR. **Today the OCR is not
PassGate** — `read-national-id` posts the photo to `google/gemini-3.8-flash`
through the Lovable AI gateway, with a hand-written JSON prompt:

```
{"full_name","surname","given_names","id_number","date_of_birth",
 "is_national_id","readable"}
```

So there are two possible meanings of "I extended the API", and they lead to
different work:

- **You extended PassGate** (`verify.weliledev.com`) to read IDs → then
  `read-national-id` should be repointed at it, and I need the endpoint path,
  the request shape and the exact response field names.
- **You mean the Gemini prompt should be extended** → then it is a small change
  in `read-national-id/index.ts` and I can do it today.

Send me the endpoint and a sample response and phase 2 starts on the right foot.
Either way the storage columns are needed first — see Blockers.

---

## Step 2 — Live selfie

### Already built

- Selfie tile, crop dialog and profile-picture preview
  (`SelfieCropDialog`, `SelfieProfilePreviewDialog`).
- The same local blur/glare/contrast check runs on the selfie.
- The original uncropped selfie is archived for verification while the crop
  becomes the avatar — a good separation, already correct.

### Gaps

**1. The selfie uses the rear camera.** `ShotTile` has a single hard-coded
input at [line 62-64](../src/components/wallet/IdentityPhotoCapture.tsx#L62):

```tsx
<input type="file" accept="image/*" capture="environment" … />
```

`environment` is the back camera. The same tile is reused for the selfie, whose
own hint reads *"Face the camera in good light."* Right now the phone opens the
rear camera for a selfie. This is a small bug worth fixing whatever else happens.

**2. There is no live capture, and "no upload" cannot be enforced with this
input.** A file input with `capture` is a hint, not a constraint — Android
browsers still offer the gallery and desktop shows a file picker. Real live-only
capture needs `getUserMedia` → video → canvas grab, which **does not exist
anywhere in this codebase** (zero occurrences in `src/`).

**3. The selfie is never checked for a face.** This is the biggest correctness
gap on the screen. `verify-passport-photo` — the PassGate face check — is
already live and already used in tenant onboarding and the agent rent-request
flow, wrapped in [`src/lib/passportFaceCheck.ts`](../src/lib/passportFaceCheck.ts)
with `runPassportFaceCheck()` and `faceCheckBlocker()`.

It is **not called here**, on the one screen whose entire purpose is identity.
The selfie gets a blur check and nothing more. Someone can photograph a wall and
it will pass, as long as the wall is sharp and well lit.

That one is a few lines — the library already exists and already reports both
ways, exactly as your spec asks.

---

## Step 3 — Confirm, and what happens next

### Already built

- `handleSave()` → `submit_identity_photos` → auto-verification if the names
  match at 0.90+.
- Rate-limit handling, a persistent (not toast) error panel, and a spelled-out
  "Before you can send" blockers list. The error mapping in
  `sendFailureMessage()` is thorough.

### Gaps

**1. The duplicate-NIN path is currently a dead end, by design.** When the NIN
is already on another account, `submit_national_id` refuses and the UI says:

> *"This National ID is already used by another account. One ID can verify one
> account only."*

Under your FIFO rule that sentence becomes wrong, and this is the exact spot the
linking request would be raised instead. It is a small edit on screen and a
large policy change underneath — the detail is in the earlier gap analysis.

**2. The component hides itself once done.** It returns `null` when both photos
are on file or the account is already verified (lines 265-268). A linking
request raised later would have no screen to live on. Phase 2 needs an entry
point that is not the withdraw gate.

**3. Nothing for the FIFO outcomes.** No "this ID already belongs to someone —
request to link?" state, no pending-request state, no result state.

---

## Summary

| Capability | Status |
| --- | --- |
| Photograph the ID | **Built** |
| Blur / glare / darkness check before upload | **Built and good** |
| OCR read of names + NIN | **Built** |
| Extract date of birth | Returned by the API, **not shown** |
| Extract sex, card number | **Missing** |
| Show the details for the user to **correct** | **Missing — read-only** |
| Store DOB / sex / card number | **Missing — no columns, no RPC arguments** |
| Selfie capture + crop + archive original | **Built** |
| Selfie uses the **front** camera | **Bug — uses `capture="environment"`** |
| Live-only capture, no gallery | **Missing — no `getUserMedia` in the codebase** |
| **Face check on the selfie** | **Missing — the function exists, it is simply not called here** |
| Single Confirm that commits the reviewed set | **Missing** |
| Duplicate NIN → linking request | **Missing — currently a hard refusal** |

---

## Blockers for phase 2, in order

1. **The OCR contract.** Endpoint, request shape, response field names for your
   extended API — or confirmation that you mean the Gemini prompt.
2. **Storage columns.** `date_of_birth`, `sex`, `card_number`, `surname`,
   `given_names`, and a place to keep *what the OCR read* separately from *what
   the user confirmed*. Nothing above can be saved until these exist.
3. **An RPC that accepts them.** `submit_national_id` takes two arguments; it
   needs a successor that takes the full reviewed set in one call.

## What I can do immediately, with no decisions from you

These are safe, small, and valuable regardless of how the linking policy lands:

- Fix the selfie to use the front camera.
- Call the existing face check on the selfie and block on a definite "no face",
  reusing `passportFaceCheck.ts` exactly as the agent flow does.
- Show the date of birth that the API already returns.

Say the word and I will do those three while the OCR contract and the columns
are settled.
