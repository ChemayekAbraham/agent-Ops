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
 * `preview` marks an opened drawer as a look-only run: the drawer shows the call
 * exactly as it looks while dialling, but nobody is dialled and nothing is
 * written. It is decided here, on the server of this panel's state, rather than
 * inside the drawer, so the two can never disagree about what is open.
 *
 * Lives apart from `CallDrawer` because a module that exports both a component
 * and a hook loses fast refresh.
 */
export function useCallDialer() {
  const [target, setTarget] = useState<DialTarget | null>(null);
  const [preview, setPreview] = useState(false);

  const open = useCallback((next: DialTarget, asPreview: boolean) => {
    setTarget(next);
    setPreview(asPreview);
  }, []);

  return {
    target,
    preview,
    /** Open the dialer on someone and place the call. */
    dial: useCallback((next: DialTarget) => open(next, false), [open]),
    /** Open the dialer on someone and look at it, without dialling. */
    dialPreview: useCallback((next: DialTarget) => open(next, true), [open]),
    close: useCallback(() => {
      setTarget(null);
      setPreview(false);
    }, []),
  };
}
