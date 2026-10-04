---
name: ID orientation correction + mandatory back side
description: Front ID photos are auto-rotated (0/180/270/90) and re-read before rejection; the back of the card is required, read, shown to the user and to FinOps
type: feature
---
# ID orientation + back of card

An upside-down or sideways card used to come back as "not a National ID" and a
perfectly sharp photo was refused (e.g. NSUBUGA GEORGE LAWRENCE).

- `readNationalIdPhotoOriented` (`src/lib/nationalIdOcr.ts`) reads the photo as
  taken, and only when the result is not `valid` retries rotated copies in the
  order 180 → 270 → 90, scoring by valid-field + populated-field count. The
  best-reading rotated copy REPLACES the file that gets archived and submitted.
- `orientationMessage(rotation)` tells the person the card was upside down /
  sideways; `ID_POSITION_TIPS` is the positioning guide, shown up front, on a
  correction, and on total failure.
- A `status: 'invalid'` reading is only reported after all four positions fail.
- **Back of the card is required**: `haveIdBack` gates submission alongside the
  front and selfie. `readNationalIdBackPhoto` reads it, surfaces card number /
  NIN / expiry / nationality / DOB / sex for confirmation, and flags
  `looksLikeFront` (both name fields valid ⇒ the front was shot twice) which
  BLOCKS submission. An unreadable back never blocks — it is archived anyway.
- Storage kind `national-id-back` → `national-id-back-<ts>.jpg`; `kindOf()` must
  test it BEFORE `national-id-` or it is misclassified.
- `profiles.national_id_back_photo_path` is selected by `useMyIdentityPhotos` /
  `useIdentityPhotosFor`; the FinOps `PayoutVerificationPanel` shows a 3-up hero
  row: Selfie / National ID front / National ID back.
- The `submit-identity-photos` AI "is this an ID?" check runs on the FRONT only.
