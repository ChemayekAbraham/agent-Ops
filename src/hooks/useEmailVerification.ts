/**
 * Self-service email verification: request a code, then confirm it.
 *
 * Both steps go through edge functions: the address is adopted server-side
 * once the code comes back, so the browser never writes `profiles.email` for
 * a self-change.
 */
import { useCallback, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';

export interface RequestCodeResult {
  challengeId: string;
  expiresAt: string;
}

export interface ConfirmCodeResult {
  email: string;
  /** False when the profile moved but the auth login address did not. */
  authSynced: boolean;
}

interface FnError {
  error?: string;
  message?: string;
  attempts_left?: number | null;
}

/** Edge functions signal failure by status code, so the body carries the reason. */
async function readError(err: unknown, fallback: string): Promise<FnError> {
  const ctx = (err as { context?: Response })?.context;
  if (ctx && typeof ctx.json === 'function') {
    try {
      return (await ctx.json()) as FnError;
    } catch {
      /* fall through to the generic message */
    }
  }
  return { message: fallback };
}

export function useEmailVerification() {
  const [sending, setSending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [attemptsLeft, setAttemptsLeft] = useState<number | null>(null);

  /** `confirmCurrent`: send a code to the address already on the profile, to prove the inbox. */
  const requestCode = useCallback(async (email: string, opts?: { confirmCurrent?: boolean }): Promise<RequestCodeResult> => {
    setSending(true);
    setAttemptsLeft(null);
    try {
      const { data, error } = await supabase.functions.invoke('email-verify-request', {
        body: {
          email: email.trim().toLowerCase(),
          ...(opts?.confirmCurrent ? { purpose: 'confirm_current' } : {}),
        },
      });
      if (error) {
        const body = await readError(error, 'Could not send the code.');
        throw new Error(body.message ?? 'Could not send the code.');
      }
      return {
        challengeId: data.challenge_id,
        expiresAt: data.expires_at,
      };
    } finally {
      setSending(false);
    }
  }, []);

  const confirmCode = useCallback(
    async (challengeId: string, code: string): Promise<ConfirmCodeResult> => {
      setConfirming(true);
      try {
        const { data, error } = await supabase.functions.invoke('email-verify-confirm', {
          body: { challenge_id: challengeId, code: code.trim() },
        });
        if (error) {
          const body = await readError(error, 'Could not confirm the code.');
          if (typeof body.attempts_left === 'number') setAttemptsLeft(body.attempts_left);
          throw new Error(body.message ?? 'Could not confirm the code.');
        }
        setAttemptsLeft(null);
        return {
          email: data.email,
          authSynced: data.auth_synced !== false,
        };
      } finally {
        setConfirming(false);
      }
    },
    [],
  );

  return { requestCode, confirmCode, sending, confirming, attemptsLeft };
}
