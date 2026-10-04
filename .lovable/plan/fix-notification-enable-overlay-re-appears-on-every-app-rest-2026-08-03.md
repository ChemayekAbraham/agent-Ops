# Fix: Notification enable overlay re-appears on every app restart

## Current state
`PushNotificationGate.tsx` is mounted globally in `App.tsx`. It shows a dialog after a 30-second delay to signed-in users whose browser notification permission is not "granted". Persistence is currently:
- `welile-push-enabled:<userId>` — set only after a successful subscription.
- `welile-push-prompt-snooze` — a **single global** timestamp set when the user taps "Not now".

## Problems found
1. **No "already prompted" record.** If the user dismisses the dialog by closing the browser/app, tapping outside, or pressing Escape, the snooze key may never be written, so the prompt returns on the next restart.
2. **Snooze is global, not per-user.** User A's "Not now" suppresses the prompt for User B on the same device, and User B's prompt can re-trigger for User A if User B never snoozed.
3. **`checkedRef` is not keyed to the user.** If the component stays mounted while the signed-in user changes, the gate never re-evaluates for the new user.
4. **Prompt still fires when permission is "denied".** The browser will instantly block the request, creating a dead-end UX.
5. **No iframe/preview suppression.** Inside the Lovable preview (cross-origin iframe) the permission API returns "denied" immediately, yet the dialog still attempts to show.
6. **30-second delay is arbitrary and can interrupt active use.** It also makes the prompt feel like a pop-up rather than part of onboarding.

## Proposed changes

### 1. Per-user prompt state in `PushNotificationGate.tsx`
Replace the single `SNOOZE_KEY` with two per-user keys:
- `welile-push-prompted:<userId>` — ISO timestamp of the last time this user was shown the gate.
- `welile-push-snooze:<userId>` — ISO timestamp when the user explicitly tapped "Not now".

Show logic becomes:
- Return if `Notification.permission === "granted"`.
- Return if a live push subscription exists for this user/device.
- Return if permission is "denied" **and** we are not in an iframe (we will show an unobtrusive "unblock" hint instead of the full gate).
- Return if the user was prompted within the last **24 hours**.
- Return if the user explicitly snoozed within the last **7 days**.
- Otherwise show the gate once per session.

### 2. Make any dismissal count as a prompt
Set the `welile-push-prompted:<userId>` timestamp immediately when the dialog opens, not only when "Not now" is clicked. Keep the explicit 7-day snooze for "Not now".

### 3. Reset gate check on user change
Store the last evaluated `userId` in a ref. If `user.id` changes, reset `checkedRef` so the new user is evaluated properly.

### 4. Suppress in iframe/preview
Use the existing `isInIframe()` helper from `@/lib/webPush`. If inside an iframe, never show the gate and never register the push worker.

### 5. Handle "denied" permission gracefully
When permission is "denied", show a small inline/non-blocking card (or nothing) with instructions to unblock in browser settings. Do **not** show the full modal.

### 6. Reduce the startup delay
Change the 30-second timer to a shorter delay (e.g., 5 seconds) and only start it after the app has finished its initial loading state. Alternatively, tie display to a less intrusive moment such as after the first route transition completes.

## Files to modify
- `src/components/notifications/PushNotificationGate.tsx` — persistence, show logic, dismissal handling, iframe guard, delay.
- `src/lib/webPush.ts` — ensure `isInIframe()` is exported and usable (already exported; confirm no changes needed).

## Verification
- Unit-style check: simulate a user who dismisses the dialog; reload the component; confirm the gate does not re-open within 24 hours.
- Confirm that switching users without a page reload re-evaluates the gate.
- Confirm the gate does not open in the Lovable preview iframe.
- Confirm the gate does not open when `Notification.permission === "denied"`.
