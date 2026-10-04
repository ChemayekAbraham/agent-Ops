# Change the notification prompt snooze window to 7 days

## What changes

The "Stay in the loop" / Enable notifications popup currently re-asks 3 days after a user dismisses it. That interval becomes 7 days.

Nothing else about the prompt changes:
- It still appears 5 seconds after sign-in resolves.
- It is still mandatory (no "Not now") while the browser permission is still grantable.
- Users who already enabled notifications are still never prompted again.
- The 7-day window still only applies on the dismissible path (OS-level permission blocked, or push unsupported).

## Technical detail

One file, one constant — `src/components/notifications/PushNotificationGate.tsx`:

```text
const SNOOZE_MS = 3 * 24 * 60 * 60 * 1000;  ->  const SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;
```

The comparison logic (`ts > Date.now() - SNOOZE_MS`) and the `welile-push-prompt-snooze` localStorage key stay unchanged, so existing stored timestamps keep working — a device dismissed 4 days ago simply stays quiet for another 3 days instead of re-prompting now.

## Verification

TypeScript check, then confirm the dialog still renders on a dashboard route.