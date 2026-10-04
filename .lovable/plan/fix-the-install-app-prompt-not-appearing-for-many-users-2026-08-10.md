# Fix the "Install App" prompt not appearing for many users

## What the data says

Last 30 days of install telemetry:

| Signal | Count |
|---|---|
| Install card actually shown | 3,222 |
| Card silently hidden by the readiness pre-check | 1,841 |
| Installs completed | ~197 |

Roughly **one in three users who should have seen the card never saw it** — the card hid itself, with no message and no fallback. That matches the complaints.

Failure breakdown of those 1,841 hidden cases:
- 1,250 had all four checks fail (a momentary network blip, or a proxy blocking the checks)
- 367 failed only the service-worker check (normal on iPhone inside WhatsApp/Instagram/Facebook browsers, and on some Android WebViews)
- the rest were single asset checks failing intermittently

The underlying files are healthy: manifest, icons and the worker script all return 200 on the live site right now. The checks are failing on the user's network, not on the server.

## Root causes

1. **The readiness pre-check is a hard gate.** If any of four network checks fails, the card renders nothing at all. A slow or metered mobile connection fails these routinely — and the result is cached for the rest of that browsing session, so the card stays gone even after the connection recovers.
2. **The service-worker check blocks iPhone users who could still install.** Add to Home Screen on iOS does not need a service worker, yet a failed worker check hides the iOS instructions entirely.
3. **The browser's install signal can be missed.** The listener for Chrome's install event lives inside an app component that loads after the page starts. Chrome fires that signal once, early; if it fires first, it is lost and the card can never offer one-tap install for that whole visit.
4. **The card only exists inside the signed-in dashboard header.** Visitors on landing, listings, or receipt pages are never offered the install.
5. **"Not now" is sticky for 14 days, and "installed" is permanent.** A user who dismissed once, or who installed and later removed the app, is never offered it again.

## The fix

**Make readiness advisory, not a gate.**
- Show the card whenever the device could plausibly install. If a check fails, still show it, with the honest sub-line "Install may be slow on this connection" plus a Retry that re-runs the checks.
- Drop the service-worker requirement from the iOS path completely.
- Never cache a failed result for the session — cache only passing results, and re-check when the device comes back online.

**Never lose the browser install signal.**
- Capture the install event in a tiny inline script in `index.html` at page start and stash it on `window`, then have the app read that stash on mount. Standard PWA pattern; closes the race permanently.

**Always give a working path.**
- If no one-tap install signal is available (Firefox, in-app browsers, some Android WebViews), the button switches to step-by-step instructions for that exact browser instead of rendering greyed out and doing nothing — today that reads as "broken".

**Widen where the offer appears.**
- Also render the card on the public shell (landing / listings / receipt pages), same snooze rules.

**Sane re-offer rules.**
- "Not now" snoozes 7 days instead of 14.
- Remove the permanent "installed" lock — check live standalone/installed state on each load, so a user who removed the app is offered again.

**Close the measurement loop.**
- Log an `install_card_suppressed` event with the exact reason whenever the card decides not to render, so this is visible rather than guesswork.

## Technical notes

- `src/hooks/useInstallPreflight.ts` — return `degraded` alongside `ready`; write the session cache only when all checks pass; add an `online` listener to re-run.
- `src/components/InstallAppCard.tsx` — remove the `!preflight.ready` early return; render a degraded variant with Retry; add suppression telemetry; change `SNOOZE_DAYS` to 7 and drop the `'installed'` sentinel in favour of live detection via `detectStandalone()`.
- `index.html` — inline `beforeinstallprompt` capture into `window.__welileInstallPrompt` before the app bundle loads.
- `src/hooks/usePWAInstall.tsx` — adopt the window stash as the source of truth, keep the existing listener as a secondary path, expose a `canInstructInstead` flag for browsers with no native prompt.
- Public/unauthenticated layout — mount the install card alongside the existing dashboard placement.
- `src/lib/installTracking.ts` — add the `install_card_suppressed` event type.
- No database or backend changes; the install events table already accepts new event types.