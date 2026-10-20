import { useCallback, useEffect, useState } from 'react';
import { invokeEdgeFunction } from '@/lib/invokeEdgeFunction';
import { getDeviceFingerprint, getHardwareFingerprint, isValidFingerprintShape } from '@/lib/deviceFingerprint';

/**
 * Shared-device sign-in step-up for the signed-in user on THIS device (see the
 * device-step-up edge function). The 3rd and later account to sign in on one
 * device must confirm an SMS code sent to its own phone, once.
 *
 * Fails open: if the fingerprint, the network or the function fails, `required`
 * stays false. Nobody is ever locked out by this check going wrong.
 */
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
    const hw = await getHardwareFingerprint().catch(() => null);
    const { data } = await invokeEdgeFunction<{ required: boolean; phone_masked?: string }>('device-step-up', {
      body: {
        action: 'check',
        device_fp: fp,
        hw_fp: isValidFingerprintShape(hw) ? hw : null,
        user_agent: typeof navigator !== 'undefined' ? navigator.userAgent : null,
      },
      silent: true,
    });
    setState({
      required: data?.required === true,
      phoneMasked: data?.phone_masked ?? null,
      loading: false,
    });
  }, [userId]);

  useEffect(() => {
    check();
  }, [check]);

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
