import { useEffect, useRef, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { useReducedMotion } from './useCombinedSettings';

interface RealtimeNotification {
  id: string;
  title: string | null;
  message: string | null;
  type: string | null;
  metadata: Record<string, unknown> | null;
}

/**
 * Subscribes to `notifications` INSERTs for a user and:
 *  - toggles a short-lived `isPulsing` flag (used to ring/glow the bell)
 *  - shows a sonner toast for wallet-related notifications
 *
 * All animations respect `prefers-reduced-motion` — when reduced motion is
 * on, only the toast fires (with no animated entrance).
 */
export function useNotificationPulse(userId: string | undefined) {
  const [isPulsing, setIsPulsing] = useState(false);
  const [lastNotificationId, setLastNotificationId] = useState<string | null>(null);
  const { prefersReducedMotion } = useReducedMotion();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!userId) return;
    const channel = supabase
      .channel(`notif-pulse-${userId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'notifications',
          filter: `user_id=eq.${userId}`,
        },
        (payload) => {
          const n = payload.new as RealtimeNotification;
          setLastNotificationId(n.id);

          if (!prefersReducedMotion) {
            setIsPulsing(true);
            if (timerRef.current) clearTimeout(timerRef.current);
            timerRef.current = setTimeout(() => setIsPulsing(false), 4500);
          }

          const meta = (n.metadata ?? {}) as Record<string, unknown>;
          const isWallet =
            (typeof meta.kind === 'string' && String(meta.kind).startsWith('wallet_')) ||
            (n.type ?? '').includes('wallet') ||
            (n.type ?? '') === 'deposit' ||
            (n.type ?? '') === 'withdrawal' ||
            (n.type ?? '') === 'transfer' ||
            (n.type ?? '') === 'commission';

          if (isWallet) {
            const isCredit =
              String(meta.direction ?? '').toLowerCase() === 'credit' ||
              /credit|deposit|received|paid to you/i.test(n.message ?? '');
            const emoji = isCredit ? '💰' : '💸';
            const title = `${emoji} ${n.title ?? 'Wallet update'}`;
            const description = n.message ?? undefined;
            if (isCredit) toast.success(title, { description, duration: 5000 });
            else toast(title, { description, duration: 5000 });
          }
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [userId, prefersReducedMotion]);

  const stopPulse = () => {
    setIsPulsing(false);
    if (timerRef.current) clearTimeout(timerRef.current);
  };

  return { isPulsing, stopPulse, lastNotificationId };
}