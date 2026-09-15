import { useState, useCallback, useRef, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { cleanPhoneNumber } from '@/lib/phoneUtils';
import { toast } from 'sonner';

export type OtpSendStatus = 'idle' | 'pending' | 'accepted' | 'failed';

// How long / how often we poll the gateway-acceptance status after a send
// that the backend reported as still "pending".
const POLL_INTERVAL_MS = 2000;
const POLL_MAX_ATTEMPTS = 15;

// Default client-side cooldown between sends. Mirrors the backend
// RESEND_COOLDOWN_SECONDS so the UI and server stay in agreement even before
// the server has a chance to reject an early resend.
const DEFAULT_COOLDOWN_SECONDS = 60;

export function useOtpVerification() {
  const [otpSent, setOtpSent] = useState(false);
  const [otpVerified, setOtpVerified] = useState(false);
  const [otpLoading, setOtpLoading] = useState(false);
  const [otpError, setOtpError] = useState<string | null>(null);
  const [verifiedPhone, setVerifiedPhone] = useState<string | null>(null);
  const [sendStatus, setSendStatus] = useState<OtpSendStatus>('idle');
  // Seconds remaining before another send is allowed. Owned here (not in the
  // UI) so the countdown survives re-renders and stays synced to the backend.
  const [cooldownSeconds, setCooldownSeconds] = useState(0);

  // Token used to cancel an in-flight polling loop (on resend / reset / unmount).
  const pollTokenRef = useRef(0);
  // Absolute timestamp (ms) when the cooldown ends; drives the 1s ticker.
  const cooldownUntilRef = useRef(0);
  const cooldownTimerRef = useRef<ReturnType<typeof setInterval>>();

  useEffect(() => {
    // Cancel any polling when the component unmounts.
    return () => {
      pollTokenRef.current += 1;
      if (cooldownTimerRef.current) clearInterval(cooldownTimerRef.current);
    };
  }, []);

  // Start (or extend) the resend cooldown for the given number of seconds.
  // A self-correcting interval recomputes from an absolute end time so it stays
  // accurate even if the tab is backgrounded.
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

  const pollSendStatus = useCallback(async (phone: string) => {
    const token = ++pollTokenRef.current;
    const cleaned = cleanPhoneNumber(phone);

    for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      // A newer send/reset superseded this loop — stop silently.
      if (token !== pollTokenRef.current) return;

      const { data, error } = await supabase.functions.invoke('sms-otp', {
        body: { action: 'status', phone: cleaned },
      });
      if (token !== pollTokenRef.current) return;
      if (error) continue; // transient — keep trying

      const status = data?.status as string | undefined;
      if (status === 'accepted') {
        setSendStatus('accepted');
        return;
      }
      if (status === 'failed') {
        setSendStatus('failed');
        setOtpError('We could not send the code. Please try again.');
        return;
      }
      // 'pending' / 'unknown' — keep polling.
    }
    // Ran out of attempts; leave status as 'pending' (code may still arrive).
  }, []);

  /**
   * `extra` lets a caller tell the backend what the code is FOR, so the SMS can
   * carry the wording that fits that flow (e.g. payout-number confirmation)
   * instead of the generic verification sentence. It never changes the code,
   * its storage or the rate limits.
   */
  const sendOtp = useCallback(async (phone: string, extra?: Record<string, unknown>) => {
    // Hard guard: never fire an overlapping send while a cooldown is active or
    // another request is in flight. Keeps duplicate SMS sends from being queued.
    if (cooldownSeconds > 0) {
      toast.message('Please wait before requesting another code', {
        description: cooldownSeconds >= 60
          ? `Try again in about ${Math.ceil(cooldownSeconds / 60)} minute${Math.ceil(cooldownSeconds / 60) === 1 ? '' : 's'}.`
          : `Try again in ${cooldownSeconds} second${cooldownSeconds === 1 ? '' : 's'}.`,
      });
      return false;
    }
    if (otpLoading) {
      toast.message('Code request already in progress', {
        description: 'Please wait a moment while we send the SMS.',
      });
      return false;
    }
    setOtpLoading(true);
    setOtpError(null);
    setSendStatus('idle');
    // Any re-send targets a phone that has NOT been verified yet. Reset the
    // verified flag so a stale verification from a previous phone can't slip
    // past the "verify your phone" gate after the user edits their number.
    setOtpVerified(false);
    // Supersede any prior polling loop.
    pollTokenRef.current += 1;
    try {
      const { data, error } = await supabase.functions.invoke('sms-otp', {
        body: { action: 'send', phone: cleanPhoneNumber(phone), ...(extra ?? {}) },
      });
      if (error) {
        // Parse the response body once so we can recover both the message and
        // the backend-supplied retry window for 429 (cooldown / hourly cap).
        let payload: any = null;
        if (error?.context) {
          payload = await error.context.json().catch(() => null);
        }
        const errMsg = payload?.error || error.message;
        const status = error?.context?.status;
        // If the backend reports a cooldown window, sync our countdown to it so
        // the messaging is accurate (e.g. after a page reload).
        if (typeof payload?.retry_after === 'number') {
          startCooldown(payload.retry_after);
        }
        setOtpError(errMsg || 'Failed to send OTP');
        setSendStatus('failed');
        if (status === 429) {
          const secs = typeof payload?.retry_after === 'number' ? payload.retry_after : 0;
          const mins = secs > 0 ? Math.ceil(secs / 60) : 0;
          toast.error('Too many code requests', {
            description: secs > 0 && secs < 60
              ? `Please try again in ${secs} second${secs === 1 ? '' : 's'}.`
              : mins > 0
              ? `Please try again in about ${mins} minute${mins === 1 ? '' : 's'}.`
              : (errMsg || 'Please wait before requesting another code.'),
          });
        } else {
          toast.error('Could not send SMS code', { description: errMsg || 'Please try again.' });
        }
        return false;
      }
      if (data?.error) {
        if (typeof data?.retry_after === 'number') startCooldown(data.retry_after);
        setOtpError(data.error);
        setSendStatus('failed');
        toast.error('Could not send SMS code', { description: data.error });
        return false;
      }
      setOtpSent(true);
      setVerifiedPhone(cleanPhoneNumber(phone));
      // Only start the cooldown on a confirmed accepted send so transient
      // failures don't needlessly lock the user out for a full minute.
      startCooldown(DEFAULT_COOLDOWN_SECONDS);
      if (data?.pending) {
        // Gateway acceptance not yet confirmed — poll for it.
        setSendStatus('pending');
        void pollSendStatus(phone);
      } else {
        setSendStatus('accepted');
        toast.success('Verification code sent', { description: 'Check your SMS for the 6-digit code.' });
      }
      return true;
    } catch (e: any) {
      setOtpError(e?.message || 'Failed to send OTP');
      setSendStatus('failed');
      toast.error('Could not send SMS code', { description: e?.message || 'Network error. Please try again.' });
      return false;
    } finally {
      setOtpLoading(false);
    }
  }, [pollSendStatus, startCooldown, cooldownSeconds, otpLoading]);

  const verifyOtp = useCallback(async (phone: string, otp: string) => {
    setOtpLoading(true);
    setOtpError(null);
    try {
      const { data, error } = await supabase.functions.invoke('sms-otp', {
        body: { action: 'verify', phone: cleanPhoneNumber(phone), otp },
      });
      if (error) {
        const errMsg = error?.context ?
          await error.context.json().then((r: any) => r.error).catch(() => error.message)
          : error.message;
        setOtpError(errMsg || 'Verification failed');
        return false;
      }
      if (data?.error) {
        setOtpError(data.error);
        return false;
      }
      setOtpVerified(true);
      setVerifiedPhone(cleanPhoneNumber(phone));
      return true;
    } catch (e: any) {
      setOtpError(e?.message || 'Verification failed');
      return false;
    } finally {
      setOtpLoading(false);
    }
  }, []);

  const resetOtp = useCallback(() => {
    setOtpSent(false);
    setOtpVerified(false);
    setOtpError(null);
    setVerifiedPhone(null);
    setSendStatus('idle');
    pollTokenRef.current += 1;
    setCooldownSeconds(0);
    cooldownUntilRef.current = 0;
    if (cooldownTimerRef.current) clearInterval(cooldownTimerRef.current);
  }, []);

  return {
    otpSent,
    otpVerified,
    otpLoading,
    otpError,
    verifiedPhone,
    sendStatus,
    cooldownSeconds,
    sendOtp,
    verifyOtp,
    resetOtp,
  };
}
