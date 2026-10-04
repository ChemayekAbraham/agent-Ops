// Device-trust + session-permanence helpers.
//
// "Remember this device" controls whether a successful sign-in produces a
// PERMANENT session (stays logged in until the user taps Log
// out) or an EPHEMERAL one (dropped when the browser is fully closed, so an
// OTP / password is required again next time).
//
// Supabase already persists sessions in localStorage with auto token refresh,
// so "remember" = leave that in place. "Don't remember" = mark the session
// ephemeral; `ephemeralGuard` drops the stored token on the next cold browser
// start so the user must re-authenticate.

const TRUSTED_DEVICE_KEY = 'welile_trusted_device';
const EPHEMERAL_SESSION_KEY = 'welile_ephemeral_session';
const SESSION_ACTIVE_KEY = 'welile_session_active';

/** Persist the user's "remember this device" choice after a successful login. */
export function setDeviceTrust(remember: boolean): void {
  try {
    if (remember) {
      localStorage.setItem(TRUSTED_DEVICE_KEY, 'true');
      localStorage.removeItem(EPHEMERAL_SESSION_KEY);
    } else {
      localStorage.removeItem(TRUSTED_DEVICE_KEY);
      localStorage.setItem(EPHEMERAL_SESSION_KEY, 'true');
    }
    // Mark this browsing session as live so the ephemeral guard doesn't drop
    // the freshly created session on the very next render.
    sessionStorage.setItem(SESSION_ACTIVE_KEY, '1');
  } catch {
    // Ignore storage errors (private mode, quota, etc.)
  }
}

/** Whether this browser was previously marked as a trusted device. */
export function isDeviceTrusted(): boolean {
  try {
    return localStorage.getItem(TRUSTED_DEVICE_KEY) === 'true';
  } catch {
    return false;
  }
}

/** Clear device-trust markers (called on explicit logout). */
export function clearDeviceTrust(): void {
  try {
    localStorage.removeItem(TRUSTED_DEVICE_KEY);
    localStorage.removeItem(EPHEMERAL_SESSION_KEY);
    sessionStorage.removeItem(SESSION_ACTIVE_KEY);
  } catch {
    // Ignore
  }
}
