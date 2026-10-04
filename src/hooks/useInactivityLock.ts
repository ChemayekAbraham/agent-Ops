import { useState, useEffect, useCallback, useRef } from 'react';

const ACTIVITY_EVENTS = ['mousedown', 'touchstart', 'keydown', 'scroll', 'mousemove'] as const;

interface UseInactivityLockOptions {
  /** Timeout in milliseconds before locking. Default: 5 minutes */
  timeout?: number;
  /** Whether the lock feature is enabled */
  enabled?: boolean;
}

export function useInactivityLock({ timeout = 5 * 60 * 1000, enabled = true }: UseInactivityLockOptions = {}) {
  // "Remember me" honors a 24h trust window: while it is active, the
  // inactivity lock is suppressed entirely so the user is never asked
  // to re-authenticate (no pre-login prompt).
  const isWithinRememberWindow = () => {
    try {
      const until = parseInt(localStorage.getItem('welile_remember_until') || '0', 10);
      return Number.isFinite(until) && until > Date.now();
    } catch { return false; }
  };
  const effectiveEnabled = enabled && !isWithinRememberWindow();
  const [isLocked, setIsLocked] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const resetTimer = useCallback(() => {
    if (!effectiveEnabled || isLocked) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setIsLocked(true), timeout);
  }, [effectiveEnabled, timeout, isLocked]);

  const unlock = useCallback(() => {
    setIsLocked(false);
    // Timer will be reset by the effect below when isLocked changes
  }, []);

  // Set up activity listeners
  useEffect(() => {
    if (!effectiveEnabled || isLocked) return;

    // Start initial timer
    timerRef.current = setTimeout(() => setIsLocked(true), timeout);

    const handler = () => resetTimer();
    ACTIVITY_EVENTS.forEach(evt => window.addEventListener(evt, handler, { passive: true }));

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      ACTIVITY_EVENTS.forEach(evt => window.removeEventListener(evt, handler));
    };
  }, [effectiveEnabled, isLocked, timeout, resetTimer]);

  return { isLocked, unlock };
}
