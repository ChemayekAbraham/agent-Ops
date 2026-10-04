# Standardise screen loaders on the three-dot loader

## What you get

Every full-screen / whole-page "loading" state uses the same three rotating dots animation instead of the current mix of small spinning circles. Small inline spinners inside buttons ("Saving...", "Submitting...") stay as they are — they read better at that size.

## Current state (verified)

- `src/components/common/ThreeBodyLoader.tsx` already exists (pure CSS, styles in `src/index.css` under `.three-body`), but it is used in exactly one place: `StalledLoaderWatchdog`, which backs the route-level `PageLoader` in `src/App.tsx`.
- Everywhere else, screen-level loading uses a spinning `Loader2` icon. 49 `.tsx` files render a `min-h-screen` container with a spinning icon — route pages, role guards, dashboards.
- `src/pages/Dashboard.tsx` has its own `DashboardLoadingFallback` with a spinning `Loader2` + "Loading...".
- `src/main.tsx` paints a pre-React inline HTML loader (a 20px rotating ring) before the bundle mounts, plus a 10s blank-screen watchdog.

## Plan

1. Add one shared screen loader component (`src/components/common/ScreenLoader.tsx`) that renders `ThreeBodyLoader` centred in a full-height, theme-background container with an optional label. This becomes the single approved screen-loading surface.
2. Replace the spinning-icon block with `ScreenLoader` in every screen-level loading state:
   - `src/pages/Dashboard.tsx` (`DashboardLoadingFallback`)
   - route pages under `src/pages/**` that render a `min-h-screen` spinner while data or auth resolves
   - auth/role gates such as `src/components/auth/RoleGuard.tsx` and `PhoneVerificationGate.tsx`
   - dashboard-level suspense fallbacks in `src/components/dashboards/*`
3. Keep `StalledLoaderWatchdog` as-is (already three dots) so the 15s stall recovery behaviour is unchanged.
4. Update the pre-mount loader in `src/main.tsx` to the same three-dot look using inline CSS keyframes (no imports available at that point), so the very first paint matches the in-app loader.
5. Leave untouched: spinners inside buttons, table/card skeletons, and small inline indicators next to text.

## Technical notes

- `ScreenLoader` props: `label?: string`, `size?: number`, `className?: string`, `fullScreen?: boolean` (defaults to `min-h-screen`; `false` renders a padded block for panel-level use).
- Dot colour comes from `--uib-color: hsl(var(--primary))` in `index.css`, so it themes automatically in light and dark mode. No hardcoded colours.
- Where a spinner is removed, the now-unused `Loader2` import is dropped from that file to keep lint clean.
- `main.tsx` keeps the existing `animation:` marker string in the injected HTML, because the blank-screen watchdog checks for it before showing the offline hint.