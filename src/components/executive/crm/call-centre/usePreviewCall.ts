import { useCallback, useEffect, useRef, useState } from 'react';
import type { CallState } from '@/hooks/useCrmVoiceCall';

/** How long the fake call spends in each pre-answer stage, in ms. */
const RING_AFTER_MS = 900;
const CONNECT_AFTER_MS = 4200;

/**
 * A browser-only stand-in for the live call lifecycle, so the call screen can be
 * opened and looked at without anyone being dialled.
 *
 * It deliberately exposes the same shape the drawer already reads (`state`,
 * `elapsed`, `muted`) and deliberately touches nothing else: no voice token, no
 * microphone, no WebRTC client, no call session row, no database write of any
 * kind. When the drawer closes it goes quiet and forgets everything.
 *
 * Lives in its own module (like `useCallDialer`) because a module exporting both
 * a component and a hook loses fast refresh.
 */
export function usePreviewCall(active: boolean) {
  const [state, setState] = useState<CallState>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [muted, setMuted] = useState(false);
  /** Re-opened on the same person after ending: bump to run the script again. */
  const [attempt, setAttempt] = useState(0);

  const stateRef = useRef<CallState>('idle');
  const connectedAtRef = useRef<number | null>(null);

  const set = useCallback((next: CallState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  /* --- The script: calling → ringing → connected. --- */
  useEffect(() => {
    if (!active) {
      stateRef.current = 'idle';
      connectedAtRef.current = null;
      setState('idle');
      setElapsed(0);
      setMuted(false);
      return;
    }

    set('calling');
    const ringTimer = window.setTimeout(() => {
      if (stateRef.current === 'calling') set('ringing');
    }, RING_AFTER_MS);
    const pickUpTimer = window.setTimeout(() => {
      if (stateRef.current !== 'calling' && stateRef.current !== 'ringing') return;
      connectedAtRef.current = Date.now();
      setElapsed(0);
      set('connected');
    }, CONNECT_AFTER_MS);

    return () => {
      window.clearTimeout(ringTimer);
      window.clearTimeout(pickUpTimer);
    };
  }, [active, attempt, set]);

  /* --- Talk-time ticker, mirroring the live hook's cadence. --- */
  useEffect(() => {
    if (state !== 'connected') return;
    const id = window.setInterval(() => {
      if (connectedAtRef.current != null) {
        setElapsed(Math.floor((Date.now() - connectedAtRef.current) / 1000));
      }
    }, 250);
    return () => window.clearInterval(id);
  }, [state]);

  /** Hang up the pretend call: settles to 'completed' with a talk time. */
  const end = useCallback(() => {
    const seconds =
      connectedAtRef.current != null
        ? Math.floor((Date.now() - connectedAtRef.current) / 1000)
        : 0;
    connectedAtRef.current = null;
    setElapsed(seconds);
    set('completed');
  }, [set]);

  /** Try the same person again, without reopening the row. */
  const restart = useCallback(() => setAttempt((n) => n + 1), []);

  /** Local-only: flips the icon, never touches a live microphone. */
  const toggleMute = useCallback(() => setMuted((m) => !m), []);

  const reset = useCallback(() => {
    stateRef.current = 'idle';
    connectedAtRef.current = null;
    setState('idle');
    setElapsed(0);
    setMuted(false);
  }, []);

  return { state, elapsed, muted, end, restart, toggleMute, reset };
}
