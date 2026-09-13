# Make Landlord Ops easier on smartphones

Improve the existing Landlord Ops interface without changing permissions, data, verification rules, or financial workflows.

## Changes

1. **Mobile-first page frame**
   - Reduce side padding on phones and use the full available width.
   - Keep the header compact so the current page remains visible above the fold.
   - Increase phone tap targets for the menu, search, settings, navigation rows, and primary actions.

2. **Quick text-size control**
   - Add an accessible text-size control to the Landlord Ops header using the app’s existing saved font-size setting.
   - Offer Small, Medium, Large, and Extra Large choices; the selection remains saved and applies across the app as it does today.
   - Keep the existing Settings entry unchanged.

3. **Simpler mobile navigation**
   - Make the phone menu easier to scan with larger rows and clearer active-page styling.
   - Keep all existing Landlord Ops destinations and badge counts unchanged.
   - Keep Landlord Verification and Landlord Float prominent on the Today page, with phone-friendly stacked actions.

4. **Phone-friendly location browsing**
   - Rework the existing Country → Region → District → County → Sub-county → Village/Cell → Landlord navigator into a clear step-by-step mobile flow.
   - Add a visible current-level heading, a large Back action, a compact path summary, and an in-place location search.
   - Make each location and landlord row a full-width, easy-to-tap item with count, agent, phone, and GPS details preserved.
   - Keep “Not recorded” groupings and all existing filtering behavior; no location values are guessed or changed.

5. **Queue usability on phones**
   - Rebalance search, status tabs, date controls, queue cards, and pagination so they stack cleanly without horizontal overflow.
   - Preserve every existing verification, rejection, export, history, chart, search, and pagination function.

6. **Verification**
   - Check the Today page and landlord verification queue at 390px and desktop widths.
   - Confirm no clipped text, horizontal overflow, inaccessible controls, or workflow regressions.

## Technical details

- Reuse `useFontSize` and its existing persisted options; do not create a second preference system.
- Limit changes to Landlord Ops presentation files and shared mobile styling only where required.
- No backend, database, policy, role, ledger, or location-dataset changes.
