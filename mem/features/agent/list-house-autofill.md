---
name: List Empty House Auto-fill
description: Agent house-listing dialog auto-fills location/LC1 area from the agent profile, defaults caretaker to the agent (self), and remembers the last-used landlord locally for one-tap reuse
type: feature
---

# List Empty House — Auto-fill (minimal typing)

`src/components/agent/ListEmptyHouseDialog.tsx` is a 2-step wizard (Step 1: House & photos · Step 2: Landlord & list). Required to list = rent + region + ≥1 photo. Landlord, caretaker and LC1 are all optional.

## Auto-fill behaviour (applied on dialog open)
- **Location + LC1 area**: on open, fetch `profiles` (`region`, `district`, `village`) for the current agent and pre-fill the matching house-location fields **only when empty** (never overwrites promo / `initialLandlord` pre-fills). `village` also seeds `lc1_village`, and the `Lc1ChairpersonPicker` inherits region/district/village via its `default*` props. A "Filled from your profile" badge shows in the Location header when applied (`prefilledFromProfile`).
- **Caretaker = agent (self)**: when the agent ticks "Landlord doesn't have / can't use a smartphone", `caretaker_type` auto-selects `self` (agent identity, `caretaker_user_id = user.id`) if it was `none`. Reverting the toggle resets it to `none`.
- **Last landlord reuse**: on a successful listing, the chosen landlord (existing selection or manual name+phone) is stored in `localStorage` under `welile_last_landlord_<userId>`. On open it loads into `lastLandlord` and renders a one-tap "Use last landlord" chip above the landlord search that calls `selectLandlord(...)`. Profiles contain no landlord, so this local cache is the landlord auto-fill source.

## Notes
- GPS is intentionally NOT auto-filled from the agent's residence — house GPS must be captured at the house via the "Capture GPS Location" button.
- All auto-fill is best-effort and silent on failure; nothing blocks listing.
