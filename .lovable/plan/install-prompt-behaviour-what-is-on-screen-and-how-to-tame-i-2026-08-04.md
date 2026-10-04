# Install prompt behaviour: what is on screen and how to tame it

## What the screenshot shows

Three separate install surfaces are competing at the same time:

1. **Top card — "Install App / Not now"** (`InstallAppCard`, rendered from `Dashboard.tsx` as `fixed top-4 … z-40`). It floats over the dashboard header and covers the user's name and greeting ("Kalyang… Welcome back").
2. **Bottom-right card — "Install Welile / Install"** (`PWAInstallPrompt`, rendered globally from `App.tsx` as `fixed bottom-6 … z-50`). It sits on top of the bottom navigation and the Invite & Earn strip.
3. **The browser's own install bubble** — Chrome's native mini-infobar. This is not app code and cannot be suppressed from the app; it appears because a valid manifest is served.

## Why they keep coming back

- `InstallAppCard` dismisses for the **session only** (`sessionStorage` key `welile_install_card_dismissed`), so a new tab or a reopened app shows it again.
- `PWAInstallPrompt` **ignores dismissal entirely**: it appears 5 seconds after load and a `setInterval` re-shows it **every 60 seconds** while the user is not installed. Tapping X only silences it for a minute.
- Both surfaces share one hook (`usePWAInstall`) and one deferred `beforeinstallprompt` event, but neither knows the other is visible, so they render together.
- `InstallAppCard` is a fixed overlay rather than in-flow, so it always occludes dashboard content instead of pushing it down.

## Proposed fix

**One install surface, one dismissal memory, never overlapping content.**

1. **Retire the auto-reappearing banner.** Remove `PWAInstallPrompt` from `App.tsx` and delete the component, so no timer or interval can resurface an install prompt.
2. **Keep a single card — `InstallAppCard` — and stop it covering the header.** Render it in-flow at the top of the dashboard content (or as a bottom sheet above the nav with safe-area padding) instead of `fixed top-4`.
3. **Make "Not now" stick.** Move dismissal from `sessionStorage` to `localStorage` with a snooze timestamp: dismissing hides the card for 14 days; installing hides it permanently. No interval-based re-show.
4. **Keep manual install available.** The existing install entry in `DashboardHeader` and the `/install` page stay, so a user who dismissed the card can still install on demand.
5. **Leave the browser bubble alone.** Chrome's own prompt is browser-controlled; the app can only avoid adding a second prompt beside it.

## Technical notes

- Files touched: `src/App.tsx` (remove lazy import + render), delete `src/components/PWAInstallPrompt.tsx`, `src/pages/Dashboard.tsx` (positioning), `src/components/InstallAppCard.tsx` (dismissal persistence).
- `usePWAInstall`, `useInstallPreflight`, `IOSInstallGuide`, `WhatsAppInstallBanner` and install telemetry stay unchanged.
- No service worker is introduced or registered; this stays manifest-only home-screen support. Note `useInstallPreflight` currently probes `/sw.js` as a readiness check — worth revisiting separately if the card is ever silently hidden.
- No backend, wallet, or ledger code is involved.