# Collapsible Wallet Hero Card

Make the wallet hero card start collapsed on all four dashboards (Tenant, Agent, Funder/Partner, Owner) and expand with a liquid-morph animation inspired by the reference component. No wallet feature, number, hook or write path changes — purely a presentation shell wrapped around the existing card body.

## Feasibility

Confirmed feasible, low risk:

- `src/components/wallet/UnifiedWalletHeroCard.tsx` (291 lines) is one self-contained presentational component used by `TenantDashboard`, `AgentDashboard`, `SupporterDashboard` and `LandlordDashboard`. Adding a collapse shell touches only this file, so all four roles get it at once with no prop changes at the call sites.
- `framer-motion` is already a dependency (`^12.23.26`) — nothing to install.
- All balance logic (`useAvailableBalance`, `usePayrollGrowth`, strict headline, pending-hold badge, agent float/withdrawable split, supporter metric tiles, quick actions, View Wallet) stays byte-for-byte the same; it just renders inside an animated container.

The reference component itself is a fixed bottom-centre floating menu with hard-coded hex colours (`#FFE862`, `#242424`) and a custom font. Dropping it in as-is would collide with the existing floating bottom nav and break theming, so it will not be added as a file. Its motion language is what gets reused.

## What the user sees

**Collapsed (default):** a single compact pill-height bar inside the same gradient card: wallet icon, role label ("Rent Wallet", "Agent Wallet", ...), the headline balance, the Active dot, and a chevron. Tapping anywhere on it expands. A discreet eye toggle keeps the amount hideable as today's behaviour allows.

**Expanding:** the card morphs — height and corner radius animate open over ~0.6s with the reference easing `[0.22, 1, 0.36, 1]`, a soft accent circle sweeps up from the bottom behind the content, and the inner blocks fade/stagger in. Collapsing is faster (~0.25s) so it feels snappy.

**Expanded:** exactly the card that exists today, unchanged, plus a collapse chevron in the header.

The open/closed choice is remembered per role in `localStorage` (e.g. `welile-wallet-hero-collapsed:tenant`), so a user who prefers it open keeps it open. First-ever load is collapsed.

## Technical notes

Single file edited: `src/components/wallet/UnifiedWalletHeroCard.tsx`.

- New optional prop `defaultCollapsed?: boolean` (defaults `true`) so a dashboard can opt out later without a refactor; no call site changes required now.
- Local `collapsed` state seeded from `localStorage`, persisted on toggle. Reduced-motion users get an instant show/hide via a `prefers-reduced-motion` check.
- Wrap the current `relative z-10 space-y-4` body in `motion.div` with `initial/animate` height `auto` transitions plus an `AnimatePresence` block for the collapsed bar; the decorative circles already present are reused for the morph sweep.
- Colours stay on semantic tokens (`primary-foreground/…`, existing `portfolio-hero-card` class). No hex values, no new fonts.
- Collapsed bar shows `headlineBalance` for non-agent roles and `withdrawableBalance` for the agent split, matching what each role already treats as its headline figure — no new calculation.
- Quick actions, payroll growth strip and View Wallet button live inside the expandable region, so the collapsed state is genuinely one row tall on mobile.

## Out of scope

No changes to wallet balances, ledger reads, hooks, RPCs, deposit/withdraw/transfer flows, or the bottom navigation.
