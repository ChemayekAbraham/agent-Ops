# Make Agent Ops easy to navigate on smartphones

## Changes

1. **Persistent phone navigation**
   - Keep the five-item bottom navigation visible and enlarge each tap target.
   - Rename ambiguous destinations with plain labels: Overview, Rent Requests, Agents, Money, More.
   - Clearly highlight the selected destination and preserve the phone safe area.

2. **Simple all-sections menu**
   - Make More open the existing grouped Agent Ops sections instead of returning to the overview.
   - Add a prominent search field so staff can find any section by name.
   - Use full-width rows with larger icons and text instead of dense tiles on phones.

3. **Consistent navigation state**
   - Keep the bottom navigation selection synchronized when a section opens from a card, menu, or direct link.
   - Provide a large, sticky back-to-overview control on inner pages.
   - Keep all current sections, counts, permissions, data, and workflows unchanged.

4. **Verification**
   - Check the Agent Ops overview, Rent Requests, Agents, Money, More menu, section search, and back navigation at smartphone width.
   - Confirm no clipped labels, horizontal overflow, or inaccessible controls.

## Technical details

- Update only Agent Ops presentation/navigation files.
- Reuse existing design tokens, icons, and data hooks; add no dependencies or backend changes.
- Preserve the desktop sidebar and all existing deep links.
