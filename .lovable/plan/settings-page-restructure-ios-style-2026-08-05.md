# Settings page restructure (iOS-style)

Restyle the arrangement of `/settings` to follow the reference screen: a centered page title, a hero card, then clean grouped rows. Section switching keeps the existing chip tabs, and no feature logic changes.

## Layout changes

1. **Header**
   - Centered "Settings" title, with the back arrow on the left and the Home button on the right, all on one row.
   - Remove the current cramped left-aligned title + separate compact profile strip.

2. **Hero card (profile summary)**
   - A single rounded, filled card directly under the title: larger avatar, full name, email, and role badges (`+N` overflow chip kept).
   - Replaces the small avatar strip in the sticky header, so the header stays short.

3. **Chip tabs (kept)**
   - The horizontal section chips (Me / Roles / Look / Safety / Legal / More) stay, moved just below the hero card, same behaviour.

4. **Grouped rows inside sections**
   - Within each section, related items render as a single grouped container: full-width rows with a leading icon, label, optional helper text, hairline dividers between rows, and a chevron on rows that open something (Edit profile details, Change password, language, currency, etc.).
   - Drop the boxed-card-per-item look and the ALL-CAPS grey headings in favour of one section heading plus grouped rows.

5. **Account sub-tabs (Profile / Contact / Withdrawal / Sign-in / Vault)**
   - Keep the sub-tab rail, but as a horizontal scroll row on mobile and the existing vertical rail on desktop, with the content below rendered as grouped rows.

6. **Spacing and touch targets**
   - Consistent row height (min 48px), uniform padding, safe-area-aware bottom padding so the floating nav never overlaps the last row.

## Technical notes

- Single file: `src/pages/Settings.tsx`.
- Add small local presentational helpers in that file (`SettingsGroup`, `SettingsRow`) — no new files, no new dependencies.
- All existing lazy-loaded section components (`WalletCard`, `MobileMoneyNameCard`, `AccountLinkingCard`, `ArchivedPdfsCard`, etc.) render unchanged inside the new containers; only the wrappers around them change.
- Colors use existing semantic tokens only (`bg-card`, `border-border/40`, `text-muted-foreground`, `bg-primary`) — no hardcoded colors, no purple from the reference.
- No changes to state, queries, RPCs, roles, or save handlers.
