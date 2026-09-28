import { useRef } from 'react';
import { usePolling } from '@/hooks/usePolling';

export type RealtimeStatus = 'connecting' | 'live' | 'polling';

/**
 * Keeps the tenant dashboard hero and the public tracking page in step with
 * `business_advances` status changes written by agent ops, tenant ops,
 * landlord ops, COO, CFO, or the disbursement engine.
 *
 * Polls every 30s (+ on focus) and returns 'polling' once active. This used to
 * be a Realtime subscription, but business_advances is not in the Realtime
 * publication, so the channel never reached SUBSCRIBED: every viewer got a
 * "Taking longer than usual to connect" toast after 10s and then fell back to
 * a 15s poll anyway (doc 147).
 *
 * The name, `channelKey` and `opts` are kept so existing callers don't change;
 * `opts.filter` is no longer used.
 */
export function useBusinessAdvanceRealtime(
  channelKey: string | null | undefined,
  onChange: () => void,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  opts?: { filter?: string }
): RealtimeStatus {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  usePolling(() => onChangeRef.current(), 30_000, { enabled: !!channelKey });

  return channelKey ? 'polling' : 'connecting';
}

export default useBusinessAdvanceRealtime;
