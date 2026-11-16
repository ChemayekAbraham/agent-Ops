import { useCallback, useEffect, useState } from 'react';
import { BellRing } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/integrations/supabase/client';
import { ensurePushSubscription, isInIframe, isLegacyPushOrigin, isPushSupported, subscriptionUsesCurrentVapidKey } from '@/lib/webPush';
import { CALM, FOCUS } from './deskTheme';
import { ErrorLine } from './ui';

/**
 * E114: the 07:30 call list arrives as a push. A staff member whose device
 * has no push subscription sees a banner at the top of their desk; one tap
 * subscribes this device (src/lib/webPush.ts) and the banner goes.
 *
 *   unknown      still checking: nothing shown
 *   unavailable  this browser cannot take push here (unsupported, preview
 *                iframe, old address): nothing shown, nothing to offer
 *   none         no subscription on this device: the banner
 *   subscribed   the banner is gone
 */

export type DevicePush = 'unknown' | 'unavailable' | 'none' | 'subscribed';
export const BANNER_TEXT = 'Turn on notifications to get your 07:30 call list';

/** Whether this device holds a current push subscription. */
export async function readDevicePush(): Promise<DevicePush> {
  if (!isPushSupported() || isInIframe() || isLegacyPushOrigin()) return 'unavailable';
  try {
    if (Notification.permission !== 'granted') return 'none';
    const reg = await navigator.serviceWorker.getRegistration('/sw.js');
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    return sub && subscriptionUsesCurrentVapidKey(sub) ? 'subscribed' : 'none';
  } catch {
    return 'none';
  }
}

export function useDevicePush() {
  const [state, setState] = useState<DevicePush>('unknown');
  const refresh = useCallback(() => {
    void readDevicePush().then(setState);
  }, []);
  useEffect(refresh, [refresh]);
  return { state, setState, refresh };
}

export function DeskPushBanner() {
  const { user } = useAuth();
  const { state, setState } = useDevicePush();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  if (state !== 'none' || !user?.id) return null;

  const turnOn = async () => {
    setBusy(true);
    setProblem(null);
    const result = await ensurePushSubscription(
      async ({ endpoint, p256dh, auth }) => {
        // This device's endpoint belongs to whoever is signed in now.
        await supabase.from('push_subscriptions').delete().eq('endpoint', endpoint);
        const { error } = await supabase.from('push_subscriptions').insert({ user_id: user.id, endpoint, p256dh, auth });
        if (error) throw error;
      },
      async (endpoint) => {
        await supabase.from('push_subscriptions').delete().eq('endpoint', endpoint);
      },
    );
    setBusy(false);
    if (result.ok) {
      setState('subscribed');
      toast.success('Notifications are on. Your call list arrives at 07:30.');
    } else {
      setProblem(result.message);
    }
  };

  return (
    <div role="region" aria-label="Notifications" className="desk-panel flex flex-wrap items-center justify-between gap-3 px-4 py-3" data-push-banner>
      <span className="flex items-center gap-2 text-sm text-foreground">
        <BellRing className="h-4 w-4 shrink-0" aria-hidden />
        {BANNER_TEXT}
      </span>
      <button
        type="button"
        onClick={() => void turnOn()}
        disabled={busy}
        className={`rounded-md border border-[hsl(var(--primary)/0.6)] bg-[hsl(var(--primary)/0.18)] px-3 py-1.5 text-sm font-medium text-foreground hover:bg-[hsl(var(--primary)/0.28)] disabled:opacity-50 ${CALM} ${FOCUS}`}
      >
        {busy ? 'Turning on…' : 'Turn on notifications'}
      </button>
      {problem && (
        <div className="w-full">
          <ErrorLine>{problem}</ErrorLine>
        </div>
      )}
    </div>
  );
}
