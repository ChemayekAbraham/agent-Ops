# Fix: Google OAuth popup blocker detection & UX

## Problem

When a user taps "Continue with Google" on mobile, some browsers (Samsung Internet, Brave, Firefox Focus, some ad blockers) silently block the `window.open()` call. The current code waits **15 seconds** via a safety timer before showing a generic error:

> "That took too long to start. Please try again..."

The user has no idea why it failed or what to do about it.

**Symptom:** Button spins → nothing opens → times out → stays on Auth page.

## Root Cause

`lovableAuth.signInWithOAuth()` (in `@lovable.dev/cloud-auth-js`) calls `window.open()` internally. When the popup is blocked, `window.open()` returns `null` — but the library doesn't expose this. The `signInWithOAuth` call resolves almost instantly with no error and no redirect, which looks like a no-op.

## Proposed Changes

### 1. Detect popup blocked in `src/hooks/auth/authOperations.ts`

In `attemptOAuth()` (line 129), wrap the call with a `window.open` interceptor to detect when the popup was blocked:

```ts
async function attemptOAuth(provider: 'google' | 'apple', redirectUri: string) {
  console.log(`[OAuth] Attempting ${provider} with redirect_uri:`, redirectUri);

  // Detect popup blocker: intercept window.open to check if it returned null
  let popupBlocked = false;
  const origOpen = window.open;
  window.open = function (...args: Parameters<typeof window.open>) {
    const w = origOpen.apply(this, args);
    if (!w) popupBlocked = true;
    return w;
  };

  const result = await lovable.auth.signInWithOAuth(provider, {
    redirect_uri: redirectUri,
  });

  window.open = origOpen; // restore immediately

  console.log(`[OAuth] ${provider} result:`, {
    redirected: result.redirected,
    error: result.error?.message,
    popupBlocked,
  });

  // If popup was blocked, return a specific error
  if (popupBlocked && !result.redirected && !result.error) {
    return {
      ...result,
      error: new Error('popup_blocked'),
    };
  }

  return result;
}
```

### 2. Handle `popup_blocked` error in `src/hooks/useAuthForm.ts`

In `handleGoogleSignIn()` (around line 1129), add specific handling for the popup_blocked error before the generic error toast:

```ts
const { error } = await signInWithGoogle();
if (error) {
  // Popup blocker — instant, specific feedback
  if (error.message === 'popup_blocked') {
    toast({
      title: 'Pop-up blocked',
      description:
        'Your browser blocked the Google sign-in window. Allow pop-ups for this site in your browser settings, or sign in with your phone number and password below.',
      variant: 'destructive',
      duration: 10000, // keep it visible longer so they can read it
    });
    return; // skip the generic error path
  }
  // ... existing error handling
}
```

### 3. Reduce safety timer from 15s to 5s

In `handleGoogleSignIn()` line 1126, change:
```ts
// Before
}, 15000);

// After  
}, 5000);
```

With the popup blocker now detected instantly, the 5s timer is only a safety net for truly unexpected hangs.

### 4. Same changes for `handleAppleSignIn()`

Apply the same popup detection and timer reduction to `handleAppleSignIn()` which has the same structure starting at line 1188.

## Files to modify

| File | What |
|---|---|
| `src/hooks/auth/authOperations.ts` | `attemptOAuth()` — add `window.open` interceptor |
| `src/hooks/useAuthForm.ts` | `handleGoogleSignIn()` and `handleAppleSignIn()` — handle `popup_blocked`, reduce timer |

## Testing

1. Open the app in a browser with popups blocked (Brave with Shields up, or Chrome with popups disabled for the site)
2. Tap "Continue with Google"
3. Should immediately show: "Pop-up blocked — Allow pop-ups for this site..."
4. Enable popups, try again — should work normally
5. Verify normal Google sign-in still works on Chrome/Safari with popups allowed
