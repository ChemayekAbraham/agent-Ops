import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { invokeEdgeFunction } from '@/lib/invokeEdgeFunction';

const DEVICE_ID_KEY = 'welile_device_id';
const DEVICE_LABEL_KEY = 'welile_device_label';

/** Same stable device id used by the signed-in devices list. */
export function getDeviceId(): string {
  try {
    let id = localStorage.getItem(DEVICE_ID_KEY);
    if (!id) {
      id = crypto?.randomUUID?.() ?? `dev-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      localStorage.setItem(DEVICE_ID_KEY, id);
    }
    return id;
  } catch {
    return `dev-${Date.now()}`;
  }
}

export function getDeviceLabel(): string {
  try {
    const custom = localStorage.getItem(DEVICE_LABEL_KEY);
    if (custom && custom.trim()) return custom.trim();
  } catch {
    /* ignore */
  }
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  let os = 'Unknown device';
  if (/Android/i.test(ua)) os = 'Android';
  else if (/iPhone|iPad|iPod/i.test(ua)) os = 'iPhone/iPad';
  else if (/Windows/i.test(ua)) os = 'Windows';
  else if (/Mac OS X|Macintosh/i.test(ua)) os = 'Mac';
  else if (/Linux/i.test(ua)) os = 'Linux';
  let browser = '';
  if (/Edg\//i.test(ua)) browser = 'Edge';
  else if (/Chrome\//i.test(ua) && !/Edg\//i.test(ua)) browser = 'Chrome';
  else if (/Firefox\//i.test(ua)) browser = 'Firefox';
  else if (/Safari\//i.test(ua) && !/Chrome\//i.test(ua)) browser = 'Safari';
  return browser ? `${os} · ${browser}` : os;
}

const SYNTHETIC_DOMAINS = ['welile.user', 'noapp.welile.user', 'welile.app', 'welile.local', 'app.local', 'no-email.local'];

/** Mirrors the backend rule: placeholder addresses cannot receive codes. */
export function isUnusableEmail(email?: string | null): boolean {
  if (!email) return true;
  const e = email.trim().toLowerCase();
  if (!e.includes('@')) return true;
  const domain = e.split('@').pop() ?? '';
  if (SYNTHETIC_DOMAINS.some((d) => domain === d || domain.endsWith('.' + d))) return true;
  const local = e.split('@')[0] ?? '';
  if (/^\+?\d{7,15}$/.test(local) && domain.endsWith('welile.com')) return true;
  return false;
}

export interface TwoFactorState {
  enabled: boolean;
  deviceTrusted: boolean;
  emailMasked: string | null;
  loading: boolean;
}

/**
 * Two-step verification (2MFA) state for the signed-in user on THIS device.
 * `deviceTrusted` is false when the device still owes an email code.
 */
export function useTwoFactor(userId: string | undefined) {
  const [state, setState] = useState<TwoFactorState>({
    enabled: false,
    deviceTrusted: true,
    emailMasked: null,
    loading: true,
  });

  const refresh = useCallback(async () => {
    if (!userId) {
      setState({ enabled: false, deviceTrusted: true, emailMasked: null, loading: false });
      return;
    }
    const { data } = await invokeEdgeFunction<{
      enabled: boolean;
      device_trusted: boolean;
      email_masked: string | null;
    }>('two-factor-challenge', {
      body: { action: 'status', device_id: getDeviceId(), device_label: getDeviceLabel() },
      silent: true,
    });
    setState({
      enabled: Boolean(data?.enabled),
      deviceTrusted: data ? Boolean(data.device_trusted) : true,
      emailMasked: data?.email_masked ?? null,
      loading: false,
    });
  }, [userId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  /** Turn 2MFA on: this device becomes the only trusted one and all other sessions end. */
  const enable = useCallback(async () => {
    const { data, error } = await invokeEdgeFunction<{
      devices_signed_out: number;
      email_masked: string;
    }>('two-factor-manage', {
      body: { action: 'enable', device_id: getDeviceId(), device_label: getDeviceLabel() },
      errorTitle: 'Could not turn on two-step verification',
    });
    if (error) return { error };
    // Revoke every OTHER auth session server-side; this device stays signed in.
    try {
      await supabase.auth.signOut({ scope: 'others' });
    } catch {
      /* best effort */
    }
    await refresh();
    return { data };
  }, [refresh]);

  const disable = useCallback(async () => {
    const { error } = await invokeEdgeFunction('two-factor-manage', {
      body: { action: 'disable', device_id: getDeviceId(), device_label: getDeviceLabel() },
      errorTitle: 'Could not turn off two-step verification',
    });
    if (!error) await refresh();
    return { error };
  }, [refresh]);

  const requestCode = useCallback(
    () =>
      invokeEdgeFunction<{ email_masked: string }>('two-factor-challenge', {
        body: { action: 'request', device_id: getDeviceId(), device_label: getDeviceLabel() },
        errorTitle: 'Could not send the code',
      }),
    [],
  );

  const verifyCode = useCallback(
    (code: string) =>
      invokeEdgeFunction('two-factor-challenge', {
        body: { action: 'verify', code, device_id: getDeviceId(), device_label: getDeviceLabel() },
        errorTitle: 'Verification failed',
      }),
    [],
  );

  return { ...state, refresh, enable, disable, requestCode, verifyCode };
}
