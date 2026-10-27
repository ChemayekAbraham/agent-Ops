import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useAuth, type AppRole } from '@/hooks/useAuth';

/**
 * Shared gate for session RPCs (staff prompts, and functions granted only to
 * `authenticated`).
 *
 * PostgREST answers a missing or expired user JWT with HTTP 401 before the
 * function runs. A function without anon EXECUTE also logs Postgres 42501.
 * These helpers keep signed-out visitors, signed-out tabs and dead refresh
 * tokens from ever issuing that request. The database function still decides
 * who, among signed-in users, actually receives a prompt.
 */

export class AuthRequiredError extends Error {
  readonly code = 'AUTH_REQUIRED';
  constructor(message = 'Sign in again to continue.') {
    super(message);
    this.name = 'AuthRequiredError';
  }
}

/** True when this session can be sent as a user JWT. An expired access token is not usable. */
export function sessionHasUsableAccessToken(
  session: { access_token?: string | null; expires_at?: number | null } | null | undefined,
  now = Date.now(),
): boolean {
  if (!session?.access_token) return false;
  if (session.expires_at == null) return true;
  return session.expires_at * 1000 > now;
}

/**
 * Live session from the Supabase client (not React state). `getSession` refreshes
 * an access token that is about to expire; a token that is still expired afterwards
 * means the refresh did not succeed, and the caller must not hit PostgREST.
 */
export async function hasUsableUserSession(): Promise<boolean> {
  try {
    const { data, error } = await supabase.auth.getSession();
    if (error) return false;
    return sessionHasUsableAccessToken(data.session);
  } catch {
    return false;
  }
}

/** PostgREST / GoTrue failures that mean "no usable user JWT", including anon-key calls. */
export function isUnauthenticatedRpcError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  if (error instanceof AuthRequiredError) return true;
  const e = error as { status?: number; code?: string; message?: string; name?: string };
  if (e.name === 'AuthRequiredError' || e.code === 'AUTH_REQUIRED') return true;
  if (e.status === 401) return true;
  const code = String(e.code || '').toUpperCase();
  if (code === 'PGRST301' || code === 'PGRST302' || code === 'PGRST303') return true;
  const msg = String(e.message || '').toLowerCase();
  if (msg.includes('jwt') || msg.includes('not authenticated') || msg.includes('invalid claim')) return true;
  // anon role calling a function granted only to authenticated.
  return code === '42501' && msg.includes('permission denied for function');
}

/**
 * AuthProvider has finished loading and holds a real user access token.
 * Pass `roles` to also require one of those roles (the CTO collections RPC).
 * Omit `roles` when the RPC itself picks the recipient — a named approver, the
 * requester, or anyone `staff_survey_is_employee()` accepts.
 */
export function useAuthenticatedAudience(roles?: readonly AppRole[]): boolean {
  const { user, session, loading, roles: held } = useAuth();
  if (loading || !user?.id || !session?.access_token) return false;
  if (!roles || roles.length === 0) return true;
  return held.some((role) => roles.includes(role));
}

/**
 * Run `load` on an interval only while `useAuthenticatedAudience` is true, and
 * only after `getSession()` still has a usable access token. The timer stops
 * as soon as the person signs out. A new access token (sign-in or refresh)
 * checks again immediately.
 *
 * `onNavigate` re-checks when the path changes (payroll and survey prompts).
 * `onFocus` re-checks when the window regains focus (requisition notices).
 * The first path is not a navigation — the interval effect already loads once.
 */
export function useAuthenticatedPoll(
  load: () => unknown,
  intervalMs: number,
  opts: { roles?: readonly AppRole[]; onNavigate?: boolean; onFocus?: boolean } = {},
): void {
  const { session } = useAuth();
  const ready = useAuthenticatedAudience(opts.roles);
  const loadRef = useRef(load);
  loadRef.current = load;
  const readyRef = useRef(ready);
  readyRef.current = ready;
  const onFocus = opts.onFocus === true;
  const token = session?.access_token ?? '';

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    const run = () => {
      if (!readyRef.current || cancelled) return;
      void (async () => {
        if (!(await hasUsableUserSession())) return;
        if (!readyRef.current || cancelled) return;
        await loadRef.current();
      })();
    };
    run();
    const timer = window.setInterval(run, intervalMs);
    const onWindowFocus = () => { if (onFocus) run(); };
    if (onFocus) window.addEventListener('focus', onWindowFocus);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      if (onFocus) window.removeEventListener('focus', onWindowFocus);
    };
  }, [ready, token, intervalMs, onFocus]);

  const path = useLocation().pathname;
  const seenPath = useRef<string | null>(null);
  const onNavigate = opts.onNavigate === true;
  useEffect(() => {
    if (!onNavigate || !ready) return;
    if (seenPath.current === null) {
      seenPath.current = path;
      return;
    }
    if (seenPath.current === path) return;
    seenPath.current = path;
    void (async () => {
      if (!(await hasUsableUserSession())) return;
      await loadRef.current();
    })();
  }, [onNavigate, path, ready]);
}
