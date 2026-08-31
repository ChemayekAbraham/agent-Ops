import { useCallback, useState } from 'react';
import type { CalleeRole } from '@/lib/callCentre';

/** Who the dialer is calling. Every panel that can start a call supplies this. */
export interface DialTarget {
  calleeId: string;
  name: string;
  phone: string;
  avatarUrl: string | null;
  role: CalleeRole;
  location: string | null;
}

/**
 * Owns the "which call is open" state, so a panel's list and its table drive one
 * drawer instead of each keeping a copy.
 *
 * Lives apart from `CallDrawer` because a module that exports both a component
 * and a hook loses fast refresh.
 */
export function useCallDialer() {
  const [target, setTarget] = useState<DialTarget | null>(null);

  return {
    target,
    /** Open the dialer on someone. */
    dial: useCallback((next: DialTarget) => setTarget(next), []),
    close: useCallback(() => setTarget(null), []),
  };
}
