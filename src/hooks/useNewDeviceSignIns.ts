import { useCallback, useEffect, useState } from 'react';
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

export function useNewDeviceSignIns(userId: string | undefined) {
  const [pending, setPending] = useState<PendingDeviceSignIn[]>([]);

  const refresh = useCallback(async () => {
    if (!userId) {
      setPending([]);
      return;
    }
    const fp = await myFp();
    if (!fp) return;
    const { data } = await invokeEdgeFunction<{ devices: PendingDeviceSignIn[] }>('device-sign-in-alert', {
      body: { action: 'list', device_fp: fp },
      silent: true,
    });
    setPending(Array.isArray(data?.devices) ? data!.devices : []);
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
