import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import { hasUsableUserSession, useAuthenticatedAudience, useAuthenticatedPoll } from '@/hooks/useAuthenticatedPoll';
import { REQUISITION_REMINDER_MS, reminderDelay, reminderDue } from './reminderTiming';

/**
 * A reminder pop-up that checks at most every 4 hours and is put off for 4 hours by "Later" (or by opening the queue).
 * The server decides who is reminded and keeps the snooze, so a refresh cannot bring it back early.
 * FAIL OPEN: any error leaves the app usable and shows nothing.
 */
export function useApprovalReminder<P>({
  fetchPrompt,
  snooze,
}: {
  /** The next item waiting on the signed-in user, or null. */
  fetchPrompt: () => Promise<P | null>;
  /** Puts the item off on the server; returns the server's "until" time when it has one. */
  snooze: (prompt: P) => Promise<unknown>;
}) {
  const [prompt, setPrompt] = useState<P | null>(null);
  const [working, setWorking] = useState(false);
  const suppressedUntilRef = useRef(0);
  const lastCheckedRef = useRef<number | null>(null);
  const timerRef = useRef<number | null>(null);
  const ready = useAuthenticatedAudience();
  const { user } = useAuth();
  const fetchRef = useRef(fetchPrompt);
  fetchRef.current = fetchPrompt;

  useEffect(() => {
    lastCheckedRef.current = null;
    suppressedUntilRef.current = 0;
    if (timerRef.current) window.clearTimeout(timerRef.current);
    setPrompt(null);
  }, [user?.id]);

  const load = useCallback(async () => {
    if (Date.now() < suppressedUntilRef.current) return;
    if (!reminderDue(lastCheckedRef.current, Date.now())) return;
    if (!(await hasUsableUserSession())) { setPrompt(null); return; }
    lastCheckedRef.current = Date.now();
    try {
      setPrompt(await fetchRef.current());
    } catch {
      setPrompt(null);
    }
  }, []);

  useAuthenticatedPoll(load, REQUISITION_REMINDER_MS);
  useEffect(() => { if (!ready) setPrompt(null); }, [ready]);
  useEffect(() => () => { if (timerRef.current) window.clearTimeout(timerRef.current); }, []);

  /** Put the reminder off for 4 hours. Resolves true when it was put off. */
  const later = async (): Promise<boolean> => {
    if (!prompt) return false;
    setWorking(true);
    try {
      const until = await snooze(prompt);
      const delay = reminderDelay(until, Date.now());
      suppressedUntilRef.current = Date.now() + delay;
      lastCheckedRef.current = null;
      if (timerRef.current) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => { void load(); }, delay + 500);
      setPrompt(null);
      return true;
    } catch (e) {
      toast.error((e as { message?: string })?.message || 'Could not put the reminder off. Try again.');
      return false;
    } finally {
      setWorking(false);
    }
  };

  return { prompt, working, later };
}
