import { useEffect, useId } from 'react';
import { setCriticalFlowActive } from '@/lib/criticalFlowGuard';

/**
 * Tells the app a piece of live work is open, so nothing may interrupt it (the "new version" prompt, the install
 * nag, automatic cache clearing) until it is done. It only registers with the existing critical-flow guard; it
 * never touches data, money or any pipeline step.
 *
 * Several screens can be live at once, so each caller registers under its own id and releases only its own mark.
 * `label` is for people reading the guard while debugging, e.g. 'calling-center-call'.
 */
export function useCriticalFlow(label: string, active: boolean): void {
  const id = useId();
  useEffect(() => {
    if (!active) return;
    const key = `${label}:${id}`;
    setCriticalFlowActive(key, true);
    return () => setCriticalFlowActive(key, false);
  }, [label, id, active]);
}

/**
 * While `active`, the browser asks "leave this page?" before a reload, a tab close or a pull-down refresh, so a
 * live call or an unsent form is not lost silently. Browsers show their own wording; a page cannot change it.
 */
export function useLeavePageWarning(active: boolean): void {
  useEffect(() => {
    if (!active || typeof window === 'undefined') return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // older browsers need a value set to show the prompt
      event.returnValue = '';
      return '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [active]);
}
