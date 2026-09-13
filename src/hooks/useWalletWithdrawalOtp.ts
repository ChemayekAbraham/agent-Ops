import { useState, useCallback, useRef, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';

const DEFAULT_COOLDOWN_SECONDS = 30;

// Safely extract the JSON body from a Supabase FunctionsError. Mirrors
// useLandlordOtp's readErrorPayload — `error.context` is only a Response
// (with `.json()`) for FunctionsHttpError; for relay/fetch errors it can be
// undefined or a plain object, so calling `.json()` blindly can throw.
async function readErrorPayload(error: any): Promise<any | null> {
  const ctx = error?.context;
  if (ctx && typeof ctx.json === 'function') {
    try {
      return await ctx.json();
    } catch {
      return null;
    }
  }
  return null;
}

function friendlyOtpError(rawMessage: string | undefined, fallback: string): string {
  const msg = (rawMessage || '').toLowerCase();
  if (
    msg.includes('failed to send a request') ||
    msg.includes('failed to fetch') ||
    msg.includes('network') ||
    msg.includes('load failed')
  ) {
    return 'Network issue — the request did not reach our servers. Try again once you have a stable connection.';
  }
  return rawMessage || fallback;
}

export interface WithdrawalOtpPayload {
  amount: number;
  payout_method: 'mobile_money' | 'bank_transfer';
  mobile_money_number?: string;
  mobile_money_name?: string;
  mobile_money_provider?: string;
  bank_name?: string;
  bank_account_number?: string;
  bank_account_name?: string;
  reason?: string;
  client_request_id: string;
}

export interface SubmitWithdrawalResult {
  success: boolean;
  code?: string;
  message?: string;
  request_id?: string;
  payout_code?: string | null;
  available?: number;
}

/**
 * Gates a mobile-money / bank-transfer wallet withdrawal behind an OTP sent
 * to the ACCOUNT's own registered phone (profiles.phone) — never the payout
 * destination number being entered. Closes the account-takeover gap where
 * someone with mere session/credential access (not the victim's real phone)
 * could register their own number as the permanent payout destination on a
 * first-ever withdrawal. Mirrors useLandlordOtp's payout-OTP shape.
 */
export function useWalletWithdrawalOtp() {
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [maskedPhone, setMaskedPhone] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [otpIssuing, setOtpIssuing] = useState(false);
  const [otpVerifying, setOtpVerifying] = useState(false);
  const [otpError, setOtpError] = useState<string | null>(null);
  const [attemptsLeft, setAttemptsLeft] = useState<number | null>(null);
  const [cooldownSeconds, setCooldownSeconds] = useState(0);

  const inFlightRef = useRef(false);
  const cooldownUntilRef = useRef(0);
  const cooldownTimerRef = useRef<ReturnType<typeof setInterval>>();

  useEffect(() => {
    return () => {
      if (cooldownTimerRef.current) clearInterval(cooldownTimerRef.current);
    };
  }, []);

  const startCooldown = useCallback((seconds: number) => {
    const safe = Math.max(0, Math.ceil(seconds));
    if (safe <= 0) return;
    cooldownUntilRef.current = Date.now() + safe * 1000;
    setCooldownSeconds(safe);
    if (cooldownTimerRef.current) clearInterval(cooldownTimerRef.current);
    cooldownTimerRef.current = setInterval(() => {
      const remaining = Math.ceil((cooldownUntilRef.current - Date.now()) / 1000);
      if (remaining <= 0) {
        setCooldownSeconds(0);
        if (cooldownTimerRef.current) clearInterval(cooldownTimerRef.current);
      } else {
        setCooldownSeconds(remaining);
      }
    }, 1000);
  }, []);

  /** Issue a fresh code (first send). Resets any prior challenge state. */
  const issueOtp = useCallback(async (payload: WithdrawalOtpPayload): Promise<boolean> => {
    if (inFlightRef.current || otpIssuing) return false;
    inFlightRef.current = true;
    setOtpIssuing(true);
    setOtpError(null);
    setAttemptsLeft(null);
    try {
      const { data, error } = await supabase.functions.invoke('issue-wallet-withdrawal-otp', {
        body: payload,
      });
      if (error) {
        const body = await readErrorPayload(error);
        const msg = body?.message || body?.error || error.message;
        setOtpError(friendlyOtpError(msg, 'Could not send verification code.'));
        return false;
      }
      if (data?.error) {
        setOtpError(data.message || data.error);
        return false;
      }
      if (!data?.challenge_id) {
        setOtpError('The server did not return a verification challenge. Please try again.');
        return false;
      }
      setChallengeId(data.challenge_id);
      setMaskedPhone(data.masked_phone ?? null);
      setExpiresAt(data.expires_at ?? null);
      startCooldown(DEFAULT_COOLDOWN_SECONDS);
      if (data.sms_sent === false) {
        setOtpError('Code created but SMS delivery could not be confirmed. Use Resend if it does not arrive shortly.');
      }
      return true;
    } catch (e: any) {
      setOtpError(friendlyOtpError(e?.message, 'Could not send verification code.'));
      return false;
    } finally {
      inFlightRef.current = false;
      setOtpIssuing(false);
    }
  }, [otpIssuing, startCooldown]);

  /** Resend on the same client_request_id — same challenge row, fresh code. */
  const resendOtp = useCallback(async (payload: WithdrawalOtpPayload): Promise<boolean> => {
    if (cooldownSeconds > 0) return false;
    return issueOtp(payload);
  }, [cooldownSeconds, issueOtp]);

  /** Verify the code and submit the withdrawal server-side in one step. */
  const verifyAndSubmit = useCallback(async (otp: string): Promise<SubmitWithdrawalResult | null> => {
    if (!challengeId) {
      setOtpError('No active verification code — request a new one.');
      return null;
    }
    setOtpVerifying(true);
    setOtpError(null);
    try {
      const { data, error } = await supabase.functions.invoke('verify-wallet-withdrawal-otp', {
        body: { challenge_id: challengeId, otp },
      });
      if (error) {
        const body = await readErrorPayload(error);
        const msg = body?.error || error.message;
        if (typeof body?.attempts_left === 'number') setAttemptsLeft(body.attempts_left);
        setOtpError(body?.error ? msg : friendlyOtpError(error.message, 'Verification failed.'));
        return null;
      }
      if (data?.error) {
        if (typeof data?.attempts_left === 'number') setAttemptsLeft(data.attempts_left);
        setOtpError(data.error);
        return null;
      }
      return data as SubmitWithdrawalResult;
    } catch (e: any) {
      setOtpError(friendlyOtpError(e?.message, 'Verification failed.'));
      return null;
    } finally {
      setOtpVerifying(false);
    }
  }, [challengeId]);

  const resetOtp = useCallback(() => {
    setChallengeId(null);
    setMaskedPhone(null);
    setExpiresAt(null);
    setOtpError(null);
    setAttemptsLeft(null);
    setOtpIssuing(false);
    setOtpVerifying(false);
    inFlightRef.current = false;
    setCooldownSeconds(0);
    cooldownUntilRef.current = 0;
    if (cooldownTimerRef.current) clearInterval(cooldownTimerRef.current);
  }, []);

  return {
    challengeId,
    maskedPhone,
    expiresAt,
    otpIssuing,
    otpVerifying,
    otpError,
    attemptsLeft,
    cooldownSeconds,
    issueOtp,
    resendOtp,
    verifyAndSubmit,
    resetOtp,
  };
}
