# 194 - Send Money: the "what are you sending?" picture picker was unusable on desktop web

**Date:** 2026-10-02 · **Scope:** `src/components/wallet/ItemSwipePicker.tsx` (positioning logic only), dev harness + Playwright spec. Frontend only, no migration, no edge function.

## What users saw
On the web, in Send Money, tapping "What are you sending?" opens the full-screen picture picker. On a laptop or desktop the user could not get to the picture they wanted, or close the picker.

## Root cause
The picker pins itself over the Send Money dialog. It sized itself to `window.innerWidth x innerHeight` and moved its top-left to the browser window's corner, then the dialog set `overflow: hidden`. That only works when the dialog fills the screen, which it does below the `sm` breakpoint (phones). From `sm` up the dialog is a centred `max-w-md` card, so everything laid out near the window edges was clipped away: the Previous and Next arrows (12px from the edge), the Close button, and part of "Choose this". The only other ways to move were touch swipe and the keyboard arrows, so a mouse user was stuck on the first picture.

Reproduced before the fix (Playwright, 1920x1080): Close button at x=18 while the dialog starts at x=707.

## Fix
`place()` now fills the dialog's own inner box (`host.clientWidth/Height`, aligned to the dialog's padding box) instead of the window. While the picker is open the dialog gets `min-height: min(85vh, 760px)` so a short desktop card has room for a full picture; it is restored on close. On a phone the dialog is already the whole screen, so nothing changes there.

## Tests
- New: `e2e/item-swipe-picker-desktop.spec.ts` against a dev-only harness at `/__e2e/item-swipe-picker` (the real picker inside a dialog with Send Money's sizing classes). At 1280x720, 1366x768, 1920x1080 and 390x844 it checks the Close, Next and Choose buttons sit inside the dialog, then steps to the second item with the mouse and picks it. 4/4 pass; the three desktop sizes failed before the fix.
- `ItemSwipePicker.test.tsx` passes.
- `SendMoneyDialog.test.tsx`: 7 tests fail. They fail identically with the picker change reverted, so this is not caused by this change and is not fixed here.

## For Gemini
This is a layout change inside a UI component (done here because it blocked users). The picker's look is untouched. Worth a visual pass on desktop: the picture is now a dialog-sized card, not full window.

## Not done
- Mouse drag and wheel on the rail still do nothing (only arrows, keys and touch). Not needed now that the arrows are reachable.
- Not tried on the live site: this needs a signed-in session with a wallet balance.

## Architecture map
No update: no new data flow.
