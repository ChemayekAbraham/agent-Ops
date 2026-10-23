import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { invokeEdgeFunction } from '@/lib/invokeEdgeFunction';
import { getDeviceFingerprint, isValidFingerprintShape } from '@/lib/deviceFingerprint';

/**
 * New-device sign-in alerts for the signed-in owner (device-sign-in-alert edge
 * function). Lists devices that signed in to this account and await an answer.
 * The server only returns them to a device the owner already trusts, so the new
 * device itself never sees or answers its own alert.
 */
export type DeviceIconKey = 'iphone' | 'android' | 'windows' | 'mac' | 'linux' | 'unknown';

export interface PendingDeviceSignIn {
  device_fp: string;
  icon: DeviceIconKey;
  label: string;
  os: string | null;
  browser: string | null;
  location: string | null;
  ip: string | null;
  signed_in_at: string;
  last_seen_at: string;
}

const POLL_MS = 2 * 60 * 1000;

async function myFp(): Promise<string | null> {
  const fp = await getDeviceFingerprint().catch(() => null);
  return isValidFingerprintShape(fp) ? fp : null;
}

/**
 * Fresh token for the CURRENT account only. A cached/expired session — or one
 * belonging to a different user after an account switch — returns null so the
 * background check skips instead of firing a 401.
 */
async function freshToken(userId: string, refresh = false): Promise<string | null> {
  const { data, error } = refresh
    ? await supabase.auth.refreshSession()
    : await supabase.auth.getSession();
  const session = data?.session;
  if (error || !session?.access_token || session.user.id !== userId) return null;
  if (!session.expires_at || session.expires_at * 1000 <= Date.now() + 30_000) {
    return refresh ? null : freshToken(userId, true);
  }
  return session.access_token;
}

export function useNewDeviceSignIns(userId: string | undefined) {
  const [pending, setPending] = useState<PendingDeviceSignIn[]>([]);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (!userId) {
      setPending([]);
      return;
    }
    // Mount, tab visibility and the timer can fire together — one check at a time.
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const fp = await myFp();
      if (!fp) return;

      let token = await freshToken(userId);
      if (!token) {
        // Signed out (or session expired): nothing to list, and never an error.
        setPending([]);
        return;
      }

      // Background poll: invoke directly so a rejected token stays quiet —
      // it must never surface as a page error. One refresh retry, never a loop.
      const invokeList = (accessToken: string) =>
        supabase.functions.invoke('device-sign-in-alert', {
          headers: { Authorization: `Bearer ${accessToken}` },
          body: { action: 'list', device_fp: fp },
        });

      let response = await invokeList(token);
      if (response.error?.context?.status === 401) {
        token = await freshToken(userId, true);
        if (!token) {
          setPending([]);
          return;
        }
        response = await invokeList(token);
      }
      if (response.error || response.data?.error) return;

      const devices = (response.data as { devices?: PendingDeviceSignIn[] } | null)?.devices;
      setPending(Array.isArray(devices) ? devices : []);
    } finally {
      inFlight.current = false;
    }
  }, [userId]);

  useEffect(() => {
    refresh();
    if (!userId) return;
    const timer = window.setInterval(refresh, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh, userId]);

  /** trust=true: "I know this device". trust=false: sign it out and get a password tip. */
  const respond = useCallback(
    async (targetFp: string, trust: boolean) => {
      const fp = await myFp();
      const res = await invokeEdgeFunction<{ status: string; sessions_ended: number }>('device-sign-in-alert', {
        body: { action: 'respond', device_fp: fp, target_device_fp: targetFp, trust },
        errorTitle: 'Could not save your answer',
      });
      if (!res.error) setPending((list) => list.filter((d) => d.device_fp !== targetFp));
      return res;
    },
    [],
  );

  return { pending, refresh, respond };
}
