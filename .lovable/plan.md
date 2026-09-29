# Add Cash Position page to the CFO dashboard

## Goal
Create a dedicated **Cash Position** page in the CFO dashboard sidebar, directly below **Home**, containing the complete selected Cash Position section.

## Changes
- Add **Cash Position** immediately after **Home** in the CFO sidebar and section navigation.
- Extract the existing Cash Position section into a shared CFO component so its figures, dialogs, drill-downs, and live updates remain unchanged.
- Show that shared section on the new Cash Position page.
- Keep the existing section on Home as requested by “copy,” rather than changing financial logic or data sources.
- Preserve all other CFO pages and sidebar ordering.

## Verification
- Confirm Home still displays the Cash Position section.
- Confirm the new sidebar item opens the dedicated Cash Position page.
- Check the page at desktop and mobile widths and confirm current dialogs and drill-downs still open.
