import { useCallback, useEffect, useState } from 'react';
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

  const check = useCallback(async () => {
    if (!userId) {
      setState({ required: false, phoneMasked: null, loading: false });
      return;
    }
    const fp = await deviceFp();
    if (!fp) {
      setState({ required: false, phoneMasked: null, loading: false });
      return;
    }
    // The periodic re-check can fire after sign-out or while the token is
    // missing; calling the function then only produces a 401 "Not signed in".
    const { data: sess } = await supabase.auth.getSession().catch(() => ({ data: { session: null } }));
    if (!sess?.session?.access_token) {
      setState({ required: false, phoneMasked: null, loading: false });
      return;
    }
    const hw = await getHardwareFingerprint().catch(() => null);
    const { data } = await invokeEdgeFunction<{ required: boolean; phone_masked?: string; revoked?: boolean }>('device-step-up', {
      body: {
        action: 'check',
        device_fp: fp,
        hw_fp: isValidFingerprintShape(hw) ? hw : null,
        user_agent: typeof navigator !== 'undefined' ? navigator.userAgent : null,
      },
      silent: true,
    });
    if (data?.revoked) {
      await signOutRejectedDevice();
      return;
    }
    setState({
      required: data?.required === true,
      phoneMasked: data?.phone_masked ?? null,
      loading: false,
    });
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

  const requestCode = useCallback(async () => {
    const fp = await deviceFp();
    return invokeEdgeFunction<{ phone_masked?: string; required?: boolean }>('device-step-up', {
      body: { action: 'request', device_fp: fp },
      errorTitle: 'Could not send the code',
    });
  }, []);

  const verifyCode = useCallback(async (code: string) => {
    const fp = await deviceFp();
    const res = await invokeEdgeFunction('device-step-up', {
      body: { action: 'verify', code, device_fp: fp },
      errorTitle: 'Verification failed',
    });
    if (!res.error) setState((s) => ({ ...s, required: false }));
    return res;
  }, []);

  return { ...state, check, requestCode, verifyCode };
}
