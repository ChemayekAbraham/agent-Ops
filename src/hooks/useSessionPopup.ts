import { useEffect, useState } from 'react';
import {
  activeSessionPopup,
  claimSessionPopup,
  registerSessionPopup,
  subscribeSessionPopup,
  unregisterSessionPopup,
  type SessionPopupId,
  type SessionPopupPhase,
} from '@/lib/sessionPopup';

/**
 * True only when this interruption is the one dialog the session will show.
 * Register `unknown` while the decision is still loading so a lower-priority
 * dialog does not claim the slot first.
 */
export function useSessionPopup(id: SessionPopupId, phase: SessionPopupPhase): boolean {
  const [, setTick] = useState(0);

  useEffect(() => {
    registerSessionPopup(id, phase);
    return subscribeSessionPopup(() => setTick((n) => n + 1));
  }, [id, phase]);

  useEffect(() => () => unregisterSessionPopup(id), [id]);

  const active = activeSessionPopup();
  useEffect(() => {
    if (active === id) claimSessionPopup(id);
  }, [active, id]);

  return active === id;
}
