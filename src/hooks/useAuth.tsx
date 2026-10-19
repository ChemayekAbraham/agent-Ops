import { useState, useEffect, useRef, createContext, useContext, ReactNode } from 'react';
import { useInRouterContext, useLocation } from 'react-router-dom';
import { User, Session, isAuthRetryableFetchError } from '@supabase/supabase-js';
import { supabase } from '@/integrations/supabase/client';
import { setReportingTags } from '@/lib/errorReporting';
import {
  setCachedSession,
  clearSessionCache,
  clearAllAuthStorage,
  getPreloadedSession,
  getPreloadedRoles,
  isSessionPastMaxAge,
  readStoredAuthSession,
} from '@/lib/sessionCache';
import { installStaleSessionDetector, STALE_SESSION_EVENTS, isSignOutSuppressed } from '@/lib/staleSessionDetector';
import { loginTelemetry as lt } from '@/lib/loginTelemetry';
import { keepRoles, keepSession, keepUser } from '@/lib/authStateIdentity';
import { rememberReturnPath } from '@/lib/returnPath';


// Re-export types so existing imports keep working
export type { AppRole } from './auth/types';
export type { AuthContextType } from './auth/types';

import type { AppRole, AuthContextType } from './auth/types';
import { DEFAULT_ROLES, fetchUserRoles, addRoleForUser } from './auth/roleManager';
import * as ops from './auth/authOperations';

const AuthContext = createContext<AuthContextType | undefined>(undefined);

// Synthetic placeholder addresses issued to accounts that never gave a real
// email (phone-only signups, agent-assisted registrations) — these are
// auto-confirmed at creation (see register-tenant / submit-tenant-form) and
// there is no real inbox to send a confirmation link to, so they're exempt
// from the "must confirm email" rule below.
const SYNTHETIC_EMAIL_SUFFIXES = ['@welile.agent', '@welile.user', '@noapp.welile.user'];

function hasUnconfirmedRealEmail(user: { email?: string | null; email_confirmed_at?: string | null }): boolean {
  const email = (user.email || '').trim().toLowerCase();
  if (!email) return false;
  if (SYNTHETIC_EMAIL_SUFFIXES.some((suffix) => email.endsWith(suffix))) return false;
  return !user.email_confirmed_at;
}

// Longest initializeAuth waits on enforceAccountAccess before proceeding.
const ENFORCE_ACCOUNT_ACCESS_WAIT_MS = 2500;

async function enforceAccountAccess(user: { id: string; email?: string | null; email_confirmed_at?: string | null }): Promise<boolean> {
  const userId = user.id;
  const stop = lt.start('auth.enforceAccountAccess', { userId });
  try {
    // Belt-and-braces backstop: GoTrue itself already refuses to issue a
    // session for a real-email account whose email isn't confirmed (see the
    // "Confirm your email to finish" gate in useAuthForm.ts, and the native
    // "Email not confirmed" sign-in error already handled there). This check
    // exists in case a session was issued before that policy took effect, or
    // a config change ever loosens it — no session should ever be allowed to
    // stand for a real, unconfirmed email either way.
    if (hasUnconfirmedRealEmail(user)) {
      try {
        localStorage.setItem(
          'welile_account_blocked_reason',
          'Please confirm your email before signing in. Check your inbox for the confirmation link, or request a new one.',
        );
      } catch { /* ignore */ }
      clearAllAuthStorage();
      await supabase.auth.signOut();
      stop('email_unconfirmed');
      window.location.href = '/auth';
      return false;
    }

    const [{ data: profile }, { data: fraudBlocked }] = await Promise.all([
      supabase
        .from('profiles')
        .select('is_frozen, frozen_reason')
        .eq('id', userId)
        .maybeSingle(),
      (supabase as any).rpc('is_fraud_identifier_blocked', {
        p_type: 'user_id',
        p_value: userId,
      }),
    ]);

    // Frozen accounts are ALLOWED to sign in — the AccountFrozenGate overlay
    // renders a full-screen "Account Frozen" screen with support contact info
    // as soon as the session hydrates. Only hard fraud blocks force sign-out.
    if (fraudBlocked === true) {
      try {
        localStorage.setItem(
          'welile_account_blocked_reason',
          profile?.frozen_reason || 'This account has been permanently restricted for fraud review.',
        );
      } catch { /* ignore */ }
      clearAllAuthStorage();
      await supabase.auth.signOut();
      stop('fraud_blocked', { frozen: profile?.is_frozen ?? false });
      window.location.href = '/auth';
      return false;
    }
  } catch (error) {
    console.warn('[Auth] account access guard failed:', error);
    stop('error', { message: (error as Error)?.message });
    return true;
  }
  stop('ok');
  return true;
}

/** Pages a signed-out person may stay on; ending a session there clears it without a redirect. */
function isPublicPath(path: string): boolean {
  return path.startsWith('/auth') || path === '/' || path.startsWith('/campaign');
}

/** Sign-in page URL that brings the person back to where they were. */
function signInUrl(reason: string): string {
  const back = window.location.pathname + window.location.search;
  return `/auth?redirect=${encodeURIComponent(back)}&reason=${reason}`;
}

let endingSession = false;
/** Set while the person taps Sign out, so the sign-in page is not told their session expired. */
let signingOutOnPurpose = false;

/** Remembers the page a signed-in person is on, so signing back in returns them there (see lib/returnPath). */
function ReturnPathTracker({ userId }: { userId: string }) {
  const location = useLocation();
  useEffect(() => {
    rememberReturnPath(userId, location.pathname + location.search);
  }, [userId, location.pathname, location.search]);
  return null;
}

/**
 * The one way out for a session that has ended — refresh token rejected, session dropped from storage, or past the
 * 7-day limit: wipe it on this device and go to sign-in. Never leave the person on a dashboard where every query
 * runs anonymously and comes back empty. Scope is local so the person's other devices keep their own sessions.
 */
async function endSession(reason: string): Promise<void> {
  if (endingSession) return;
  endingSession = true;
  console.warn('[Auth] session ended —', reason);
  lt.mark('auth.session_ended', { reason }, 'warn');
  try { clearSessionCache(); clearAllAuthStorage(); } catch { /* ignore */ }
  try { await supabase.auth.signOut({ scope: 'local' }); } catch { /* ignore */ }
  if (isPublicPath(window.location.pathname)) {
    endingSession = false;
    return;
  }
  window.location.replace(signInUrl(reason));
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const cachedSession = getPreloadedSession();
  const cachedRoles = getPreloadedRoles() as AppRole[] | null;

  const isCachedSupporterOnly = cachedRoles?.length === 1 && cachedRoles[0] === 'supporter';
  const initialRoles: AppRole[] =
    cachedRoles && cachedRoles.length > 0
      ? cachedRoles.includes('supporter') ? cachedRoles : ['supporter', ...cachedRoles] as AppRole[]
      : DEFAULT_ROLES;

  const [user, setUser] = useState<User | null>(null);
  // Tests mount the provider without a router; the tracker needs one.
  const inRouter = useInRouterContext();
  // Read by the session watchdog, which runs outside React's render cycle.
  const userRef = useRef<User | null>(null);
  userRef.current = user;
  const [session, setSession] = useState<Session | null>(null);
  const [role, setRole] = useState<AppRole | null>(initialRoles.includes('supporter') ? 'supporter' : initialRoles[0]);
  const [roles, setRoles] = useState<AppRole[]>(initialRoles);
  const rolesRef = useRef<AppRole[]>(initialRoles);
  const [loading, setLoading] = useState(true);
  // Whether the role list reflects a definitive database answer. A transient
  // failure right after sign-in leaves this false, and routing must NOT treat
  // an unresolved empty list as "this account has no dashboard role".
  const [rolesResolved, setRolesResolved] = useState(false);

  // Keep ref in sync with state
  const setRolesWithRef = (newRoles: AppRole[]) => {
    rolesRef.current = newRoles;
    // same roles = same array, so nothing that depends on the list starts over
    setRoles(keepRoles(newRoles));
  };

  useEffect(() => {
    lt.mark('auth.provider.mount', {
      hasCachedSession: Boolean(cachedSession?.userId),
      cachedRolesCount: cachedRoles?.length ?? 0,
    });
    let isMounted = true;
    let rolesFetched = false; // prevent duplicate role fetches

    // Install the global stale-session detector once. It watches Supabase
    // responses for bad_jwt / missing sub errors and forces a token refresh
    // (or a clean sign-out if the refresh token itself is dead).
    installStaleSessionDetector();

    // When the detector successfully refreshes the token, re-fetch roles so
    // any stale in-memory identity state is rehydrated from the new session.
    const onRehydrated = () => {
      if (!isMounted) return;
      lt.mark('auth.rehydrate.start');
      supabase.auth.getSession().then(({ data: { session: fresh } }) => {
        if (!isMounted || !fresh?.user) return;
        lt.setUserId(fresh.user.id);
        lt.mark('auth.rehydrate.session_ok', { userId: fresh.user.id });
        setSession(keepSession(fresh));
        setUser(keepUser(fresh.user));
        setCachedSession(fresh.user.id, fresh.user.email || '', fresh.expires_at || 0);
        fetchUserRoles(fresh.user.id, role, setRolesWithRef, setRole, setRolesResolved).catch(() => { /* ignore */ });
      }).catch(() => { /* ignore */ });
    };
    window.addEventListener(STALE_SESSION_EVENTS.rehydrated, onRehydrated as EventListener);

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (event, session) => {
        if (!isMounted) return;
        lt.mark('auth.state_change', {
          event,
          hasSession: Boolean(session),
          userId: session?.user?.id ?? null,
        });

        // OTP login fallback guard: when a session is established right after an
        // OTP-initiated magic-link redirect, verify the resolved auth user id
        // (stashed by the OTP login flow) matches the session we actually
        // landed on. If a stale/mismatched email resolved a different account,
        // abort and sign out instead of completing sign-in on the wrong account.
        if (session?.user && (event === 'SIGNED_IN' || event === 'INITIAL_SESSION')) {
          let expectedUid: string | null = null;
          try { expectedUid = localStorage.getItem('welile_otp_expected_uid'); } catch { /* ignore */ }
          if (expectedUid) {
            if (expectedUid === session.user.id) {
              // Matched — consume the guard and continue normally.
              try { localStorage.removeItem('welile_otp_expected_uid'); } catch { /* ignore */ }
            } else {
              // Wrong account resolved — do not complete sign-in.
              try {
                localStorage.removeItem('welile_otp_expected_uid');
                localStorage.setItem('welile_otp_mismatch', '1');
              } catch { /* ignore */ }
              // Audit the profile/session mismatch with both the expected
              // (OTP-resolved) and actual (session) user ids. Fire-and-forget.
              try {
                const actualUid = session.user.id;
                supabase.functions.invoke('otp-login', {
                  body: {
                    action: 'report_mismatch',
                    expected_user_id: expectedUid,
                    actual_user_id: actualUid,
                  },
                }).catch(() => { /* logging must not block sign-out */ });
              } catch { /* ignore */ }
              setSession(null);
              setUser(null);
              // Defer signOut out of the callback — calling auth methods
              // synchronously here deadlocks the auth client.
              setTimeout(() => {
                supabase.auth.signOut().finally(() => { window.location.href = '/auth'; });
              }, 0);
              return;
            }
          }
          setTimeout(() => {
            enforceAccountAccess(session.user).catch(() => { /* non-blocking */ });
          }, 0);
        }

        // Only update session state if we actually have a session,
        // or if this is an explicit sign-out. This prevents transient
        // null sessions (e.g., during INITIAL_SESSION before token refresh)
        // from logging users out on page refresh.
        // A repeat announcement for the same person (every tab resume, every token renewal) carries a freshly
        // parsed copy; keep the object already held unless the user or the sign-in really changed, so nothing
        // that depends on it starts over and no dashboard is thrown away and rebuilt.
        if (session) {
          setSession(keepSession(session));
          setUser(keepUser(session.user));
        } else if (event === 'SIGNED_OUT' && !isSignOutSuppressed()) {
          setSession(null);
          setUser(null);
        }
        // For other events with null session (INITIAL_SESSION, TOKEN_REFRESHED failure),
        // preserve existing state and let initializeAuth handle it.

        if (session?.user) {
          setCachedSession(session.user.id, session.user.email || '', session.expires_at || 0);
          
          // Only fetch roles if initializeAuth hasn't already done it
          if (!rolesFetched) {
            rolesFetched = true;
            // CRITICAL: defer out of the onAuthStateChange callback. Calling
            // Supabase auth methods (fetchUserRoles → supabase.auth.getUser())
            // synchronously inside this callback deadlocks the auth client,
            // which freezes every later query. This path is what runs on a
            // fresh/second device (no cached session), so without the defer
            // the user stays logged in but no data ever loads.
            const uid = session.user.id;
            setTimeout(() => {
              fetchUserRoles(uid, role, setRolesWithRef, setRole, setRolesResolved);
            }, 0);
          }

        if (event === 'SIGNED_IN') {
            // Record OAuth funnel completion if this sign-in came back from a
            // Google/Apple redirect (no-op when there is no pending funnel).
            setTimeout(() => {
              import('@/lib/oauthFunnel')
                .then((m) => m.completePendingOAuthFunnel(session.user.id))
                .catch(() => {});
            }, 0);
            // If Google sign-in previously failed with "account already exists"
            // and the user then signed in with their password, auto-link the
            // Google identity to this account.
            setTimeout(() => {
              (async () => {
                try {
                  const { getPendingIdentityLink, clearPendingIdentityLink } =
                    await import('@/lib/pendingIdentityLink');
                  const pending = getPendingIdentityLink();
                  if (!pending) return;
                  const { error } = await supabase.auth.linkIdentity({
                    provider: pending.provider,
                    options: { redirectTo: `${window.location.origin}/settings?linked=${pending.provider}` },
                  });
                  if (!error) clearPendingIdentityLink();
                } catch { /* ignore */ }
              })();
            }, 0);
            // If this browser has a pending campaign attribution, attach it
            // to the new session. Fire-and-forget, idempotent server-side.
            setTimeout(() => {
              import('@/lib/campaignAttribution')
                .then((m) => m.attachCampaignIfPresent())
                .catch(() => {});
            }, 500);
            // Defer non-critical profile update — don't block login
            // SIGNED_IN also fires on every tab resume, so throttle the write
            // to once per 15 min per user (doc 177: profiles write load).
            setTimeout(() => {
              const key = `last_active_written:${session.user.id}`;
              const now = Date.now();
              try {
                const prev = Number(localStorage.getItem(key) || 0);
                if (now - prev < 15 * 60 * 1000) return;
                localStorage.setItem(key, String(now));
              } catch { /* storage unavailable: fall through and write */ }
              supabase
                .from('profiles')
                .update({ last_active_at: new Date(now).toISOString() })
                .eq('id', session.user.id)
                .then(() => {});
            }, 5000);
          }
        } else if (event === 'SIGNED_OUT') {
          // A SIGNED_OUT that lands while an auth-critical action is running
          // (camera → proof-of-payment upload) or right after the page resumed
          // is environmental, not the user leaving. Keep the session state and
          // let the token refresh recover instead of booting to /auth.
          if (isSignOutSuppressed()) {
            console.warn('[Auth] SIGNED_OUT ignored — auth-critical action in progress');
            return;
          }
          rolesFetched = false;
          setRole(null);
          setRolesWithRef([]);
          setRolesResolved(true);
          clearSessionCache();
          // If the sign-out was triggered by an expired/invalid token (not by
          // the user tapping "Sign out" — which navigates via ops.signOutUser),
          // redirect immediately to /auth instead of leaving the user idle on
          // a broken authenticated screen.
          try {
            if (!isPublicPath(window.location.pathname)) {
              window.location.replace(signInUrl(signingOutOnPurpose ? 'signed_out' : 'session_expired'));
            }
          } catch { /* ignore */ }
        }
      },
    );

    const initializeAuth = async () => {
      lt.mark('auth.init.start');
      const forceLoadingOff = setTimeout(() => {
        if (!isMounted) return;
        // getSession is still running — almost always a token refresh on a slow connection. Turning loading off with
        // no user here sent signed-in people to /auth, where Sign in then queued behind the same refresh and seemed
        // to refuse. If this device holds a session, show it now: queries wait for the refresh to finish, and if the
        // refresh fails for good, SIGNED_OUT sends the person to sign in.
        const stored = readStoredAuthSession();
        if (stored && !isSessionPastMaxAge(stored)) {
          console.warn('[Auth] Init slow after 8s — keeping the stored session while it refreshes');
          lt.mark('auth.init.timeout_kept_session', { userId: stored.user.id }, 'warn');
          setSession((prev) => prev ?? (stored as unknown as Session));
          setUser((prev) => prev ?? (stored.user as User));
        } else {
          console.warn('[Auth] Init timeout after 8s — forcing loading off');
          lt.mark('auth.init.timeout_forced', undefined, 'warn');
        }
        setLoading(false);
      }, 8000);

      // Start role fetch early from cache in parallel with getSession
      let earlyRoleFetch: Promise<void> | null = null;
      if (cachedSession?.userId && !rolesFetched) {
        rolesFetched = true;
        lt.setUserId(cachedSession.userId);
        lt.mark('auth.roles.early_fetch.start', { userId: cachedSession.userId });
        earlyRoleFetch = fetchUserRoles(cachedSession.userId, role, setRolesWithRef, setRole, setRolesResolved).then(() => {});
        earlyRoleFetch.finally(() => lt.mark('auth.roles.early_fetch.end'));
      }

      try {
        const stopGet = lt.start('auth.getSession');
        const { data: { session }, error } = await supabase.auth.getSession();
        stopGet(error ? 'error' : (session ? 'ok' : 'null'), {
          message: error?.message,
          userId: session?.user?.id ?? null,
        });
        if (!isMounted) return;

        if (error) {
          const msg = error.message?.toLowerCase() || '';
          const isAuthError = msg.includes('refresh_token') || msg.includes('invalid') || msg.includes('expired') || msg.includes('not authenticated');
          const isNetworkError = msg.includes('networkerror') || msg.includes('fetch') || msg.includes('network');
          if (isAuthError) {
            console.warn('[Auth] Auth token invalid, clearing:', error.message);
            clearAllAuthStorage();
            setSession(null);
            setUser(null);
            setRole(null);
            setRolesWithRef([]);
          } else if (isNetworkError) {
            console.warn('[Auth] Network error during session restore — proceeding offline:', error.message);
          } else {
            console.warn('[Auth] Transient getSession error:', error.message);
          }
        } else {
          if (session && isSessionPastMaxAge(session)) {
            await endSession('session_max_age');
            return;
          } else if (session) {
            lt.setUserId(session.user.id);
            // Don't let a slow guard hold up the whole init: it sits behind
            // getSession and ahead of setUser/roles, and the 8s watchdog below
            // flips loading off with user still null, which routes a signed-in
            // person to /auth (84 users hit auth.init.timeout_forced on
            // 2026-09-30; guard p95 3.4s, getSession p95 4.5s). If the guard is
            // still running after the cap, carry on: it signs out and redirects
            // by itself when it denies, and it already fails open on error.
            let guardCapped = false;
            const allowed = await Promise.race([
              enforceAccountAccess(session.user),
              new Promise<boolean>((resolve) => setTimeout(() => {
                guardCapped = true;
                resolve(true);
              }, ENFORCE_ACCOUNT_ACCESS_WAIT_MS)),
            ]);
            if (guardCapped) lt.mark('auth.enforceAccountAccess.wait_capped', { userId: session.user.id }, 'warn');
            if (!allowed || !isMounted) return;
            setSession(keepSession(session));
            setUser(keepUser(session.user));

            setCachedSession(session.user.id, session.user.email || '', session.expires_at || 0);
            // If early fetch was for the same user, just await it; otherwise fetch fresh
            if (earlyRoleFetch && cachedSession?.userId === session.user.id) {
              const stopWait = lt.start('auth.roles.early_fetch.await');
              const timeoutPromise = new Promise<void>((resolve) => setTimeout(resolve, 5000));
              await Promise.race([earlyRoleFetch, timeoutPromise]);
              stopWait();
            } else {
              rolesFetched = true;
              const stopRoles = lt.start('auth.roles.fetch', { userId: session.user.id });
              const rolePromise = fetchUserRoles(session.user.id, role, setRolesWithRef, setRole, setRolesResolved);
              const timeoutPromise = new Promise<void>((resolve) => setTimeout(resolve, 5000));
              await Promise.race([rolePromise, timeoutPromise]);
              stopRoles();
            }
          } else if (cachedSession) {
            // No error and no session means supabase-js holds no session at all (a failed refresh has already
            // removed it). Keeping the cached identity left people on a dashboard where nothing loaded.
            lt.mark('auth.init.null_session_cached');
            setSession(null);
            setUser(null);
            await endSession('session_expired');
          } else {
            setSession(null);
            setUser(null);
            clearSessionCache();
            lt.mark('auth.init.no_session');
          }
        }
      } catch (err: any) {
        console.warn('[Auth] Init failed (keeping session for retry):', err?.message);
        lt.mark('auth.init.error', { message: err?.message }, 'error');
      } finally {
        clearTimeout(forceLoadingOff);
        if (isMounted) {
          setLoading(false);
          lt.mark('auth.init.loading_off');
        }
      }
    };

    initializeAuth();

    // Idle-expiry watchdog: if the current session's expires_at passes and
    // Supabase couldn't silently refresh (e.g. refresh token revoked, offline
    // for too long, cookie/storage cleared), force a clean sign-out + redirect
    // instead of leaving the user idle on a screen whose queries will all 401.
    const expiryInterval = window.setInterval(async () => {
      if (!isMounted) return;
      try {
        const { data: { session: current }, error: currentError } = await supabase.auth.getSession();
        if (!current) {
          // A network failure also returns no session but keeps it stored — that is not an ending.
          if (currentError && isAuthRetryableFetchError(currentError)) return;
          // supabase-js dropped the session (its SIGNED_OUT may have landed while sign-out was suppressed and been
          // ignored) but this screen still shows someone signed in, so every query now runs anonymously.
          if (userRef.current && !readStoredAuthSession() && !isSignOutSuppressed()) {
            await endSession('session_expired');
          }
          return;
        }
        if (isSessionPastMaxAge(current)) {
          await endSession('session_max_age');
          return;
        }
        const expMs = (current.expires_at ?? 0) * 1000;
        if (!expMs) return;
        // Grace: only act 30s after expiry, so auto-refresh has a chance.
        if (Date.now() < expMs + 30_000) return;
        // Try one refresh; if the server rejects it, end the session.
        const { data, error } = await supabase.auth.refreshSession();
        if (!error && data.session) return;
        // A refresh that failed on the network says nothing about the session — try again next tick.
        if (error && isAuthRetryableFetchError(error)) return;
        // Do not boot the user while offline, backgrounded, or mid-action
        // (e.g. a merchant uploading proof of payment after using the camera).
        if (isSignOutSuppressed()) return;
        await endSession('session_expired');
      } catch { /* never let the watchdog throw */ }
    }, 20_000);

    return () => {
      isMounted = false;
      subscription.unsubscribe();
      window.removeEventListener(STALE_SESSION_EVENTS.rehydrated, onRehydrated as EventListener);
      window.clearInterval(expiryInterval);
    };
  }, []);

  const switchRole = (newRole: AppRole) => {
    if (rolesRef.current.includes(newRole)) {
      setRole(newRole);
      try { localStorage.setItem('welile_last_role', newRole); } catch {}
    }
  };

  const addRole = async (newRole: AppRole) => {
    if (!user) return { error: new Error('No user logged in') };
    return addRoleForUser(user.id, newRole, rolesRef.current, role, setRolesWithRef, setRole);
  };

  /** Atomically grant a role (if missing) and switch to it */
  const grantAndSwitchRole = async (newRole: AppRole) => {
    if (!user) return { error: new Error('No user logged in') };
    if (!rolesRef.current.includes(newRole)) {
      const { error } = await addRoleForUser(user.id, newRole, rolesRef.current, role, setRolesWithRef, setRole);
      if (error) return { error };
    }
    // At this point rolesRef is already updated by setRolesWithRef
    setRole(newRole);
    return { error: null };
  };

  const signOut = async () => {
    signingOutOnPurpose = true;
    try {
      await ops.signOutUser(user?.id);
    } finally {
      signingOutOnPurpose = false;
    }
    setUser(null);
    setSession(null);
    setRole(null);
    setRolesWithRef([]);
    clearSessionCache();
  };

  // Keep the error-reporting pipeline tagged with the current user + role so
  // every captured exception (boundary, window.onerror, unhandledrejection)
  // is traceable per identity.
  useEffect(() => {
    setReportingTags({ userId: user?.id ?? null, role: role ?? null });
  }, [user?.id, role]);

  return (
    <AuthContext.Provider
      value={{
        user, session, role, roles, loading, rolesResolved,
        signUp: ops.signUp,
        signUpWithoutRole: ops.signUpWithoutRole,
        signIn: ops.signIn,
        signInWithGoogle: ops.signInWithGoogle,
        signInWithApple: ops.signInWithApple,
        signOut,
        switchRole,
        addRole,
        grantAndSwitchRole,
        resetPassword: ops.resetPassword,
      }}
    >
      {inRouter && user && <ReturnPathTracker userId={user.id} />}
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
