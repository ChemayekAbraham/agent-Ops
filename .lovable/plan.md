# Enforce straight National ID photos

## What will change
- Check every newly selected front and back National ID photo before reading it.
- Accept only landscape photos, where the card is wider than it is tall.
- Reject 90° or -90° sideways photos immediately, clear them from the form, and tell the person to turn the phone/card horizontally and retake.
- Keep the existing 180° upside-down correction, since it preserves a landscape image while turning the writing upright.
- Require both accepted photos to pass this orientation check before submission.

## Validation
- Add focused tests for landscape acceptance, sideways rejection, and unusable images.
- Run the National ID tests and all repository guards.

## Technical details
- Put the reusable image-dimension/orientation check in the National ID reading library.
- Apply it in the existing front and back photo handlers without changing database, policies, migrations, or money-related code.
