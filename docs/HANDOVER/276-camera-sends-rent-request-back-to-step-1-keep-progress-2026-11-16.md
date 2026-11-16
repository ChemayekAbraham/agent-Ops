# 276 — Taking the face photo sent the rent request back to step 1

**Date:** 2026-11-16 · **Asked by:** Josh (CTO), from agent reports · **Status:** frontend only, on `dev/financial-ops`. Tests pass; tenant form checked in a browser (reload keeps the step and answers). **Not tried on a real Android phone yet.**

## What was found

- Agents posting a rent request, and tenants on "Request rent here", were thrown back to the first question after taking the tenant's face photo.
- Both forms held every answer in React memory only. The tenant form kept typed text in localStorage but not the step, the picked landlord/LC1/village, or any photo. The agent form (`RentRequestAssistant`, the T4 form) kept nothing.
- Every photo used `<input type="file" capture>`, which opens the phone's own camera app. The browser goes to the background and Android often discards the page and reloads it on return, so the form started again from step 1. The wallet selfie hit the same problem earlier (doc 67) and was fixed with an in-page camera.

## Change

- `src/lib/formPhotoDraft.ts` (new): keeps a form's photos in IndexedDB (`idb-keyval`, key `form-photos:<draft key>`); never throws.
- `SelfieCameraCapture`: optional `facing`, `title`, `hint` (defaults unchanged for the wallet selfie).
- Tenant form (`TenantsOnboarding.tsx`):
  - The draft now also keeps the step, location, landlord and LC1; photos (passport, ID front/back, LC letter, house) go to IndexedDB under the same key.
  - Restore never moves the step backwards and fills only empty photo slots, because it also runs when a visitor's account is created mid-submit.
  - A restored passport photo is checked again, so its fingerprint goes with the request.
  - Cleared on a successful send.
  - The passport photo is taken with the in-page camera, with the file picker as a fallback.
- Agent form (`RentRequestAssistant.tsx`), new requests only:
  - Answers, the current question and photos are kept per agent (`welile_agent_rent_request_draft_<uid>`).
  - They are restored when the form opens, unless it was opened prefilled for a tenant or the draft is more than 24 hours old.
  - A "Picked up where you left off" toast has a **Start over** button.
  - The face check runs again on a restored face photo.
  - Cleared on send and on "Post another".
  - The tenant's face is taken with the in-page back camera.
  - Resubmits and renewals are filled from the server, so they are not kept.
- `T4RentRequestHost.tsx`: while an agent has a new request open, `welile_agent_rent_request_open` holds their user id. After a reload, the host reopens the form for that same agent. Closing the form clears the flag.

## Not changed

- ID, house and LC letter photos still open the phone camera. If the page reloads then, the shot just taken is lost, but the form comes back at the same question with everything else.
- GPS is captured again; it is not kept.
- An agent who closes the form with the back arrow keeps the draft for 24 hours; opening "Post rent request" again resumes it. Start over drops it.

## Tests

`RentRequestAssistant.intake.test.tsx` (new: resumes at the same question after a remount), `RentRequestAssistant.t4.test.tsx`, `t4EntryPoints.test.tsx` and `TenantsOnboarding.intake.test.tsx` pass (53). Both intake files now clear localStorage before each test, since the forms keep drafts.
