# Landlord Ops on mobile: why forms opened off-screen, and the fix

*5 November 2026. A record of the investigation, for anyone who touches `android-compositor-safe` or `landlordOpsMobile.css` later.*

## The report

On a phone, opening almost any item in Landlord Ops — editing a landlord, assigning someone, the verification decisions, the Landlord Calling Hub's record screen — opened the dialog pinned to one corner of the screen instead of filling it, with most of the form (including the Save/action buttons) pushed off-screen and unreachable. Officers could not act on anything, because they could not see the controls to act with.

## The cause

Two real CSS rules, both correct in isolation, fought over the same property:

1. `src/components/executive/landlord-ops/mobile/landlordOpsMobile.css` makes every Landlord Ops dialog go full screen on a phone (`position: fixed; inset: 0; transform: none !important; ...`), keyed off `html[data-landlord-ops] .app-dialog-content`.
2. `src/index.css` has a separate, app-wide rule for Android phones, `html.android-compositor-safe [role="dialog"].app-dialog-content { transform: translate3d(-50%, -50%, 0) !important; ... }`, which re-centres the *normal*, small, centred dialog by shifting it up and left by half its own size.

Both rules use `!important`, so CSS falls back to specificity. Rule 2's selector has one more class/attribute (`.android-compositor-safe` + `[role="dialog"]` + `.app-dialog-content` = 3) than rule 1's (`[data-landlord-ops]` + `.app-dialog-content` = 2), so **rule 2 won the `transform` property**, even inside Landlord Ops.

The result: the dialog's box was correctly resized to fill the whole screen by rule 1, then shifted left and up by half of that full-screen size by rule 2 — leaving only its bottom-right sliver on screen, with the title and most fields pushed off the top and left edges.

`android-compositor-safe` is added to the page for essentially every Android phone by default (`src/main.tsx`), which is the device almost every field/ops officer uses — so this hit consistently, not as an edge case.

## Proof

Reproduced in a real browser with the two rules extracted verbatim, at 375×812 (a typical phone):

| | Dialog's on-screen position |
|---|---|
| Before the fix | `x: -203.5, y: -422` (almost entirely off-screen) |
| After the fix | `x: 0, y: 0` (fills the screen, as intended) |

## The fix

One additional rule in `landlordOpsMobile.css`, specific enough to always win over rule 2 when both `android-compositor-safe` and Landlord Ops are active at once:

```css
html.android-compositor-safe[data-landlord-ops] [role='dialog'].app-dialog-content {
  transform: none !important;
  -webkit-transform: none !important;
}
```

This does not touch `index.css` or the Android performance rule it protects elsewhere in the app — it only adds a Landlord-Ops-and-Android-specific exception. Guarded by a test in `landlordOpsMobile.test.ts` that reads the CSS source and fails if this rule is ever removed without someone noticing why it exists.

## While investigating, also fixed

Two dialogs laid out their own form fields in a fixed 2-or-3 column grid with no narrower-screen fallback — `EditLandlordDialog.tsx` (the most-used dialog in Landlord Ops: 7 grids) and `AssignPersonDialog.tsx` (1 grid). Once the full-screen fix above made these dialogs actually visible on a phone, those grids would have squeezed 2–3 text inputs into a ~375px-wide screen. Both now use the same `grid-cols-1 sm:grid-cols-2` (or `sm:grid-cols-3`) pattern already used elsewhere in the app (for example `LandlordRegistrationForm.tsx`, `HouseDetailsDialog.tsx`): one column on a phone, the original 2/3 columns from `sm:` (640px) up, so desktop and tablet are pixel-for-pixel unchanged.

Every other dialog, sheet and alert dialog across Landlord Ops, Landlord Calling Center and the Landlord Calling Hub was checked for the same two issues (the transform conflict and non-collapsing grids). The remaining non-collapsing grids found (short stat tiles and 2–3-button action rows, for example "Verify / Pending / Reject") are a deliberate, already-used pattern elsewhere in the app and read fine at three per row even on a phone, so they were left as they were.

## What did not change

No data, no copy, no business logic, no migration. This is a CSS specificity fix and two layout-only class changes.
