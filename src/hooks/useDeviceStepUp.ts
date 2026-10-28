import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { invokeEdgeFunction } from '@/lib/invokeEdgeFunction';
import { clearAllAuthStorage, clearSessionCache } from '@/lib/sessionCache';
import { getDeviceFingerprint, getHardwareFingerprint, isValidFingerprintShape } from '@/lib/deviceFingerprint';

/**
 * Shared-device sign-in step-up for the signed-in user on THIS device (see the
 * device-step-up edge function). The 3rd and later account to sign in on one
 * device must confirm an SMS code sent to its own phone, once.
 *
 * Fails open: if the fingerprint, the network or the function fails, `required`
 * stays false. Nobody is ever locked out by this check going wrong.
 */
/** How often an open app re-checks, so a device the owner rejected is signed out promptly. */
const RECHECK_MS = 3 * 60 * 1000;

/**
 * The account owner said they don't know this device (new-device sign-in alert):
 * its session was ended on the server, so leave now instead of failing quietly.
 */
async function signOutRejectedDevice(): Promise<void> {
  try { clearSessionCache(); clearAllAuthStorage(); } catch { /* ignore */ }
  try { await supabase.auth.signOut({ scope: 'local' }); } catch { /* ignore */ }
  window.location.replace('/auth?reason=device_signed_out');
}

export interface DeviceStepUpState {
  required: boolean;
  phoneMasked: string | null;
  loading: boolean;
}

async function deviceFp(): Promise<string | null> {
  const fp = await getDeviceFingerprint().catch(() => null);
  return isValidFingerprintShape(fp) ? fp : null;
}

export function useDeviceStepUp(userId: string | undefined) {
  const [state, setState] = useState<DeviceStepUpState>({ required: false, phoneMasked: null, loading: true });
  const currentUserId = useRef(userId);
  currentUserId.current = userId;
  const inFlight = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const check = useCallback(async () => {
    if (!userId) {
      setState({ required: false, phoneMasked: null, loading: false });
      return;
    }
    // Mount, tab visibility and the timer can fire together. Only one check
    // may refresh the session or register this device at a time.
    if (inFlight.current) return;
    inFlight.current = true;
    const stillCurrent = () => mounted.current && currentUserId.current === userId;
    try {
      const fp = await deviceFp();
      if (!fp || !stillCurrent()) return;
      const hw = await getHardwareFingerprint().catch(() => null);

      const sessionForCheck = async (refresh = false): Promise<{ access_token: string } | null> => {
        const { data, error } = refresh
          ? await supabase.auth.refreshSession()
          : await supabase.auth.getSession();
        const session = data?.session;
        if (error || !stillCurrent() || !session?.access_token || session.user.id !== userId) return null;
        if (!session.expires_at || session.expires_at * 1000 <= Date.now() + 30_000) {
          return refresh ? null : sessionForCheck(true);
        }
        return session;
      };

      let session = await sessionForCheck();
      if (!session) return;
      const invokeCheck = (accessToken: string) => supabase.functions.invoke('device-step-up', {
        headers: { Authorization: `Bearer ${accessToken}` },
        body: {
          action: 'check',
          device_fp: fp,
          hw_fp: isValidFingerprintShape(hw) ? hw : null,
          user_agent: typeof navigator !== 'undefined' ? navigator.userAgent : null,
        },
      });
      // Background checks return errors rather than logging them as page
      // crashes. An expired/rejected token gets one refresh, never a loop.
      let response = await invokeCheck(session.access_token);
      if (response.error?.context?.status === 401 && stillCurrent()) {
        session = await sessionForCheck(true);
        if (!session) return;
        response = await invokeCheck(session.access_token);
      }
      if (!stillCurrent() || response.error || response.data?.error) return;
      const data = response.data as { required?: boolean; phone_masked?: string; revoked?: boolean } | null;
      if (data?.revoked) {
        await signOutRejectedDevice();
        return;
      }
      if (!data || typeof data.required !== 'boolean') return;
      setState({ required: data.required, phoneMasked: data.phone_masked ?? null, loading: false });
    } catch {
      // Session/network failures are not render errors or proof of trust.
      // Keep any existing verification requirement until a valid check clears it.
    } finally {
      inFlight.current = false;
      if (stillCurrent()) setState((s) => ({ ...s, loading: false }));
    }
  }, [userId]);

  useEffect(() => {
    check();
    if (!userId) return;
    const timer = window.setInterval(check, RECHECK_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') check();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [check, userId]);

  /** Fresh token for the current account, refreshed once if near expiry; null when signed out. */
  const freshToken = useCallback(async (): Promise<string | null> => {
    try {
      let { data } = await supabase.auth.getSession();
      let s = data?.session;
      if (!s?.access_token || !s.expires_at || s.expires_at * 1000 <= Date.now() + 30_000) {
        ({ data } = await supabase.auth.refreshSession());
        s = data?.session;
      }
      if (!s?.access_token || (userId && s.user.id !== userId)) return null;
      return s.access_token;
    } catch {
      return null;
    }
  }, [userId]);

  const notSignedIn = { data: null, error: new Error('Your session has ended. Please sign in again.') };

  const requestCode = useCallback(async () => {
    const token = await freshToken();
    if (!token) return notSignedIn as { data: null; error: Error };
    const fp = await deviceFp();
    return invokeEdgeFunction<{ phone_masked?: string; required?: boolean }>('device-step-up', {
      headers: { Authorization: `Bearer ${token}` },
      body: { action: 'request', device_fp: fp },
      errorTitle: 'Could not send the code',
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [freshToken]);

  const verifyCode = useCallback(async (code: string) => {
    const token = await freshToken();
    if (!token) return notSignedIn as { data: null; error: Error };
    const fp = await deviceFp();
    const res = await invokeEdgeFunction('device-step-up', {
      headers: { Authorization: `Bearer ${token}` },
      body: { action: 'verify', code, device_fp: fp },
      errorTitle: 'Verification failed',
    });
    if (!res.error) setState((s) => ({ ...s, required: false }));
    return res;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [freshToken]);

  return { ...state, check, requestCode, verifyCode };
}
