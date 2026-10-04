# Floating bottom nav redesign (Tenant, Agent, Funder, Owner)

Restyle the shared mobile bottom navigation into a floating pill with a sliding active indicator, matching the reference `floating-nav` design. All routes, taps, roles and features stay exactly as they are.

## What changes visually

- The nav detaches from the screen edge: a rounded-full floating bar, inset from the left/right and lifted above the safe area, with a soft shadow and subtle border.
- A single sliding indicator (rounded pill behind the active item) glides between items instead of the current per-item background + top dash.
- Icons stay 20px; labels shrink and hide on very narrow screens (as in the reference), so 5-6 items never crowd.
- Active item uses primary color; inactive uses muted foreground. All colors stay design tokens (no hardcoded gray-600/gray-300 from the reference snippet).
- The centered raised "Deposit" circle stays, now sitting on top of the floating pill.

## What does NOT change

- Same items per role: Tenant (Home, Shop, Invite), Agent (Home, Shop), Funder/Supporter (Home, Wallet, Shop, Settings), Owner/Landlord (Home, Shop, Invite), Manager (both hub-switch and standard variants).
- Deposit shortcut behaviour (`open-deposit` event / `?deposit=1`), AI drawer, Menu button vs Settings link fallback, haptics, and manager hub switching all untouched.
- No new npm dependencies (`lucide-react` and `framer-motion` are already installed).

## Technical notes

- Edit `src/components/MobileBottomNav.tsx` only (plus the two nav variants inside it). No new `/components/ui/floating-nav.tsx` file is added, because the app's nav is role-driven and route-driven; duplicating it as a standalone stateful component would fork the logic.
- Indicator is measured with refs + `getBoundingClientRect` against the container (same approach as the reference) and positioned with a CSS `transform`/`transition` rather than a framer `motion.div`. Reason: parts of this app resolve `framer-motion` through `src/lib/motion-lite.tsx`, where animations are neutralized; a plain CSS transition behaves identically everywhere and stays tear-free on low-end Android.
- Recompute the indicator on active change, on `resize`, and after items change (role switch) so the pill never lands off-target.
- Because the bar now floats, bump `--fab-bottom` / `--fab-bottom-stacked` in `src/index.css` by the new bottom inset so the WhatsApp FAB and other right-stack FABs keep the same visual gap above the nav.
- Sub-navs that are separate components (`SubAgentBottomNav`, `AgentOpsBottomNav`) are out of scope unless you want them matched too.
