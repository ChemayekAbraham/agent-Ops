# 85 — `useMyIdentityPhotos` cached one account's ID/selfie thumbnails under the next account that logged in

**Fixed in code 2026-09-19, not yet deployed/verified live. Read this before trusting an
"already on file" National ID/selfie thumbnail on a shared device, or before adding a new
`useQuery` that reads per-user profile data.**

## What was reported

Josh: merchant agent Immeculate "submitted all verification documents, the ID shot and the
selfie" but still can't withdraw. Screenshots she sent showed the Settings → Withdrawal &
Identity screen displaying "National ID front already on file" and "Selfie already on file"
with real thumbnail images.

## What was found

Live DB for her account (`27d5a08b-5fee-452e-bc9a-bc8064f96ae3`) showed **zero trace** of any
submission: `profiles.national_id_photo_path` / `selfie_photo_path` /
`identity_photos_submitted_at` all `NULL`, no files under her folder in the
`identity-verification` storage bucket, no `identity_photos_submitted` row in `audit_logs`
(the RPC inserts one unconditionally on every successful submission), and
`payout_destination_verifications.national_id_submitted_at` also `NULL`. So the "already on
file" thumbnails she saw could not have been her own account's real data.

Root cause: `useMyIdentityPhotos()` (`src/hooks/useIdentityPhotos.ts`) used the bare React
Query key `['my-identity-photos']` — no user id in it — while reading the *current* user id
only inside `queryFn` via `supabase.auth.getUser()`. Its sibling hook,
`useIdentityAlreadyVerified()`, does this correctly (`['identity-already-verified', user?.id]`),
which is what exposed the inconsistency. On a shared device (a common pattern for merchant
agents — one physical phone, multiple agents/tills), if a previous user's session left
`['my-identity-photos']` cached and the app never reloaded on account switch, the next user to
open the identity screen would see the *previous* user's cached ID/selfie paths rendered as
"already on file." `signOutUser` (`src/hooks/auth/authOperations.ts`) never calls
`queryClient.clear()` or otherwise invalidates React Query state on sign-out, so nothing would
have evicted the stale entry.

If that second user then hit "Send my photos for verification," `IdentityPhotoCapture.tsx`'s
`handleSave` reuses `storedIdPath!` / `storedSelfiePath!` as-is when no new photo was taken —
paths that belong to someone else's `identity-verification/<their-uid>/...` folder. The
`submit-identity-photos` edge function's ownership check
(`idPhotoPath.split("/")[0] !== user.id`) would then reject the whole submission with "Those
photos do not belong to your account," and nothing would be written anywhere — exactly the
zero-trace result found live for Immeculate's account.

## What was fixed

`src/hooks/useIdentityPhotos.ts`: `useMyIdentityPhotos()` now takes `user?.id` from `useAuth()`,
keys the query as `['my-identity-photos', uid]`, and gates on `enabled: !!uid` — matching
`useIdentityAlreadyVerified()`'s pattern. A new user id now gets its own cache entry instead of
inheriting whatever was last cached under the shared key.

This was found and fixed while reviewing a separate Gemini-driven UI simplification of the same
withdrawal/identity screens (stacked warning cards, duplicate payout-number forms, verbose
instructional bullets) — the new `IdentityVerificationChecklist` component that UI work added
reads `myIdentityPhotos.data` directly in `WithdrawFlow.tsx` and `IdentityPhotoCapture.tsx`, so
it now benefits from the fix rather than reintroducing the same stale-cross-account display.

## What not to do

- Don't assume this was the *only* unscoped per-user query key in the identity/withdrawal
  surface — this was found by noticing one hook disagreed with its sibling, not by an exhaustive
  audit. Grep for `useQuery` calls whose `queryKey` reads a `.eq('id', ...)` / `.eq('user_id',
  ...)` filter but doesn't include that id in the key array.
- Don't treat "already on file" thumbnails as proof of a real submission without checking
  `profiles.identity_photos_submitted_at` / `audit_logs` — this incident is exactly the case
  where the screen and the database disagreed.
- Don't fix this class of bug by clearing the whole React Query cache on every sign-out as a
  blanket workaround — that's a bigger behavior change (drops every other cached query, not just
  identity data) than this specific fix, and wasn't asked for here.
