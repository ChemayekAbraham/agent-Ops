# Replace the app screen loader with the three-body spinner

## What changes

The full-screen loading spinner (the small rotating circle shown while pages load) is replaced with the three-body orbiting-dots animation you provided. Everything else about the loading screen — the "Taking longer than usual" recovery panel with Reload / Clear cache after 15 seconds — stays exactly the same.

Where it shows up:
- Every lazy-loaded route/page load (`PageLoader` in the app shell)
- Role-guard loading states

## Technical notes

1. New file `src/components/common/ThreeBodyLoader.tsx`: the markup (`.three-body` wrapper with three `.three-body__dot` children), with an optional `size` prop.
2. Styles: the provided CSS is ported verbatim into the project stylesheet (`src/index.css`) as plain classes plus the `spin78236`, `wobble1`, `wobble2` keyframes, instead of adding `styled-components` as a new dependency (it is not currently installed, and adding a runtime CSS-in-JS lib would grow the bundle and the build memory footprint that we just optimized).
3. Color: `--uib-color` is bound to the existing `hsl(var(--primary))` design token rather than the hardcoded `#5D3FD3`, so it stays on-brand in light and dark mode. Size stays 35px by default.
4. `src/components/common/StalledLoaderWatchdog.tsx`: the `Loader2` spinner at the top is swapped for `<ThreeBodyLoader />`. The `Loader2` inside the "Clear cache & reload" button (a small inline button spinner) is left as-is.

No behaviour, timing, routing, or data logic changes.
