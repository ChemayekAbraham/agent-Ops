import { useState, useCallback, useRef, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { cleanPhoneNumber } from '@/lib/phoneUtils';

export type OtpSendStatus = 'idle' | 'pending' | 'accepted' | 'failed';

const POLL_INTERVAL_MS = 2000;
const POLL_MAX_ATTEMPTS = 15;
const DEFAULT_COOLDOWN_SECONDS = 60;

// Safely extract the JSON body from a Supabase FunctionsError. `error.context`
// is only a Response (with `.json()`) for FunctionsHttpError — for relay/fetch
// errors it can be undefined or a plain object, so calling `.json()` blindly
// throws "context.json is not a function". This guards against that.
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

// Turn a raw Supabase FunctionsError into a message an agent can act on.
// A network-level fetch failure ("Failed to send a request to the Edge
// Function") means the request never reached the server — the OTP is still
// valid and can simply be re-entered on a stable connection.
function isNetworkishMessage(rawMessage: string | undefined): boolean {
  const msg = (rawMessage || '').toLowerCase();
  return (
    msg.includes('failed to send a request') ||
    msg.includes('failed to fetch') ||
    msg.includes('network') ||
    msg.includes('load failed')
  );
}

function friendlyOtpError(rawMessage: string | undefined, fallback: string): string {
  if (isNetworkishMessage(rawMessage)) {
    return 'Network issue — the request did not reach our servers. Your code is still valid; check the connection and tap Verify again.';
  }
  return rawMessage || fallback;
}

// A transport-level failure on `issue-landlord-payout-otp` does NOT mean
// nothing happened — the server may have already committed the OTP challenge
// (and kicked off the SMS send in the background) before the response was
// lost in transit. Rather than asserting "the request did not reach our
// servers" — which is often simply false — ask the server what actually
// happened: is there already a live challenge for this exact landlord (+
// rent request)? If so, adopt it instead of telling the agent to start over
// and risk a second SMS / a confusing duplicate attempt.
async function reconcilePayoutChallenge(
  landlordId: string,
  rentRequestId?: string,
): Promise<{ id: string; expires_at: string } | null> {
  try {
    let q = supabase
      .from('landlord_payout_otp_challenges')
      .select('id, otp_expires_at')
      .eq('landlord_id', landlordId)
      .eq('status', 'pending')
      .gt('otp_expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(1);
    q = rentRequestId ? q.eq('rent_request_id', rentRequestId) : q.is('rent_request_id', null);
    const { data, error } = await q.maybeSingle();
    if (error || !data) return null;
    return { id: data.id, expires_at: data.otp_expires_at };
  } catch {
    return null;
  }
}

interface PayoutOtpPayload {
  landlord_id: string;
  landlord_name: string;
  landlord_phone: string;
  tenant_id?: string;
  tenant_name?: string;
  tenant_phone?: string;
  rent_request_id?: string;
  amount: number;
  mobile_money_provider: string;
  agent_latitude?: number | null;
  agent_longitude?: number | null;
  property_latitude?: number | null;
  property_longitude?: number | null;
  trigger_source?: 'auto' | 'manual';
}

export function useLandlordOtp() {
  const [otpSent, setOtpSent] = useState(false);
  const [otpVerified, setOtpVerified] = useState(false);
  const [otpLoading, setOtpLoading] = useState(false);
  const [otpError, setOtpError] = useState<string | null>(null);
  const [verifiedPhone, setVerifiedPhone] = useState<string | null>(null);
  const [sendStatus, setSendStatus] = useState<OtpSendStatus>('idle');
  const [cooldownSeconds, setCooldownSeconds] = useState(0);
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);

  const pollTokenRef = useRef(0);
  const cooldownUntilRef = useRef(0);
  const cooldownTimerRef = useRef<ReturnType<typeof setInterval>>();
  // Synchronous in-flight lock — prevents rapid double-taps from firing two
  // SMS sends before the async `otpLoading` state has had a chance to update.
  const inFlightRef = useRef(false);
  // Last failure reason, kept in a ref so callers can read it IMMEDIATELY after
  // an await (React state would still be stale) and surface a real message
  // instead of failing silently.
  const lastErrorRef = useRef<string | null>(null);

  const fail = useCallback((message: string) => {
    lastErrorRef.current = message;
    setOtpError(message);
  }, []);

  const getLastError = useCallback(() => lastErrorRef.current, []);

  useEffect(() => {
    return () => {
      pollTokenRef.current += 1;
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

  const pollSendStatus = useCallback(async (phone: string) => {
    const token = ++pollTokenRef.current;
    const cleaned = cleanPhoneNumber(phone);

    for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      if (token !== pollTokenRef.current) return;

      const { data, error } = await supabase.functions.invoke('sms-otp', {
        body: { action: 'status', phone: cleaned },
      });
      if (token !== pollTokenRef.current) return;
      if (error) continue;

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
    }
  }, []);

  // Generic OTP (legacy / non-payout flows)
  const sendOtp = useCallback(async (phone: string) => {
    if (inFlightRef.current || cooldownSeconds > 0 || otpLoading) return false;
    inFlightRef.current = true;
    setOtpLoading(true);
    setOtpError(null);
    setSendStatus('idle');
    pollTokenRef.current += 1;
    try {
      const { data, error } = await supabase.functions.invoke('sms-otp', {
        body: { action: 'send', phone: cleanPhoneNumber(phone) },
      });
      if (error) {
        let payload: any = null;
        payload = await readErrorPayload(error);
        const errMsg = payload?.error || error.message;
        if (typeof payload?.retry_after === 'number') {
          startCooldown(payload.retry_after);
        }
        setOtpError(errMsg || 'Failed to send OTP');
        setSendStatus('failed');
        return false;
      }
      if (data?.error) {
        if (typeof data?.retry_after === 'number') startCooldown(data.retry_after);
        setOtpError(data.error);
        setSendStatus('failed');
        return false;
      }
      setOtpSent(true);
      setVerifiedPhone(cleanPhoneNumber(phone));
      startCooldown(DEFAULT_COOLDOWN_SECONDS);
      if (data?.pending) {
        setSendStatus('pending');
        void pollSendStatus(phone);
      } else {
        setSendStatus('accepted');
      }
      return true;
    } catch (e: any) {
      setOtpError(e?.message || 'Failed to send OTP');
      setSendStatus('failed');
      return false;
    } finally {
      inFlightRef.current = false;
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
        const payload = await readErrorPayload(error);
        const errMsg = payload?.error || error.message;
        setOtpError(payload?.error ? errMsg : friendlyOtpError(error.message, 'Verification failed'));
        return false;
      }
      if (data?.error) {
        setOtpError(data.error);
        return false;
      }
      setOtpVerified(true);
      return true;
    } catch (e: any) {
      setOtpError(friendlyOtpError(e?.message, 'Verification failed'));
      return false;
    } finally {
      setOtpLoading(false);
    }
  }, []);

  // Payout-specific OTP (challenge-based)
  const sendPayoutOtp = useCallback(async (payload: PayoutOtpPayload) => {
    if (inFlightRef.current || otpLoading) {
      lastErrorRef.current = 'An OTP request is already being sent — please wait a moment.';
      return null;
    }
    if (cooldownSeconds > 0) {
      lastErrorRef.current = `Please wait ${cooldownSeconds}s before requesting another code.`;
      return null;
    }
    inFlightRef.current = true;
    setOtpLoading(true);
    setOtpError(null);
    lastErrorRef.current = null;
    setSendStatus('idle');
    pollTokenRef.current += 1;
    // Shared "we don't actually know what happened" recovery: check the
    // server for a live challenge before telling the agent nothing was sent.
    const reconcileOrFail = async (rawMessage: string | undefined) => {
      if (isNetworkishMessage(rawMessage)) {
        fail("We couldn't confirm the response — checking whether your OTP request was created…");
        const existing = await reconcilePayoutChallenge(payload.landlord_id, payload.rent_request_id);
        if (existing) {
          setOtpSent(true);
          setVerifiedPhone(cleanPhoneNumber(payload.landlord_phone));
          setChallengeId(existing.id);
          setExpiresAt(existing.expires_at);
          startCooldown(DEFAULT_COOLDOWN_SECONDS);
          setSendStatus('accepted');
          lastErrorRef.current = null;
          setOtpError(null);
          return existing.id;
        }
        fail('The OTP request was not created. Please try again.');
        setSendStatus('failed');
        return null;
      }
      fail(friendlyOtpError(rawMessage, 'Failed to send OTP'));
      setSendStatus('failed');
      return null;
    };

    try {
      const { data, error } = await supabase.functions.invoke('issue-landlord-payout-otp', {
        body: payload,
      });
      if (error) {
        const errPayload = await readErrorPayload(error);
        const errMsg = errPayload?.error || error.message;
        if (typeof errPayload?.retry_after === 'number') {
          startCooldown(errPayload.retry_after);
        }
        // A real error body from the server (e.g. "Insufficient float") is
        // authoritative — only reconcile when the message itself looks like
        // the request never got a response at all.
        if (errPayload?.error) {
          fail(errPayload.error);
          setSendStatus('failed');
          return null;
        }
        return await reconcileOrFail(errMsg);
      }
      if (data?.error) {
        if (typeof data?.retry_after === 'number') startCooldown(data.retry_after);
        fail(data.error);
        setSendStatus('failed');
        return null;
      }
      if (!data?.challenge_id) {
        fail('The server did not return an OTP challenge. Please try again.');
        setSendStatus('failed');
        return null;
      }
      setOtpSent(true);
      setVerifiedPhone(cleanPhoneNumber(payload.landlord_phone));
      setChallengeId(data?.challenge_id ?? null);
      setExpiresAt(data?.expires_at ?? null);
      startCooldown(DEFAULT_COOLDOWN_SECONDS);
      setSendStatus('accepted');
      return data?.challenge_id as string | null;
    } catch (e: any) {
      return await reconcileOrFail(e?.message);
    } finally {
      inFlightRef.current = false;
      setOtpLoading(false);
    }
  }, [startCooldown, cooldownSeconds, otpLoading, fail]);

  const resendPayoutOtp = useCallback(async () => {
    if (!challengeId) {
      fail('No active challenge to resend');
      return false;
    }
    if (inFlightRef.current || otpLoading) {
      lastErrorRef.current = 'An OTP request is already being sent — please wait a moment.';
      return false;
    }
    if (cooldownSeconds > 0) {
      lastErrorRef.current = `Please wait ${cooldownSeconds}s before resending.`;
      return false;
    }
    inFlightRef.current = true;
    setOtpLoading(true);
    setOtpError(null);
    lastErrorRef.current = null;
    setSendStatus('idle');
    pollTokenRef.current += 1;
    try {
      const { data, error } = await supabase.functions.invoke('issue-landlord-payout-otp', {
        body: { challenge_id: challengeId },
      });
      if (error) {
        const errPayload = await readErrorPayload(error);
        const errMsg = errPayload?.error || error.message;
        if (typeof errPayload?.retry_after === 'number') {
          startCooldown(errPayload.retry_after);
        }
        if (errPayload?.error) {
          fail(errPayload.error);
        } else {
          // The existing challenge is unaffected either way — we just don't
          // know if a new code went out. Don't claim the request "never
          // reached our servers" when that may simply be false.
          fail(
            isNetworkishMessage(errMsg)
              ? "We couldn't confirm the resend reached our servers. If the landlord doesn't get a new code shortly, tap Resend again."
              : friendlyOtpError(errMsg, 'Failed to resend OTP'),
          );
        }
        setSendStatus('failed');
        return false;
      }
      if (data?.error) {
        if (typeof data?.retry_after === 'number') startCooldown(data.retry_after);
        fail(data.error);
        setSendStatus('failed');
        return false;
      }
      setOtpSent(true);
      setExpiresAt(data?.expires_at ?? null);
      startCooldown(DEFAULT_COOLDOWN_SECONDS);
      setSendStatus('accepted');
      return true;
    } catch (e: any) {
      fail(
        isNetworkishMessage(e?.message)
          ? "We couldn't confirm the resend reached our servers. If the landlord doesn't get a new code shortly, tap Resend again."
          : friendlyOtpError(e?.message, 'Failed to resend OTP'),
      );
      setSendStatus('failed');
      return false;
    } finally {
      inFlightRef.current = false;
      setOtpLoading(false);
    }
  }, [challengeId, startCooldown, cooldownSeconds, otpLoading, fail]);

  const verifyPayoutOtp = useCallback(async (otp: string) => {
    if (!challengeId) {
      setOtpError('No active challenge to verify');
      return null;
    }
    setOtpLoading(true);
    setOtpError(null);
    try {
      const { data, error } = await supabase.functions.invoke('verify-landlord-payout-otp', {
        body: { challenge_id: challengeId, otp },
      });
      if (error) {
        let payload: any = null;
        payload = await readErrorPayload(error);
        const errMsg = payload?.error || error.message;
        setOtpError(payload?.error ? errMsg : friendlyOtpError(error.message, 'Verification failed'));
        return null;
      }
      if (data?.error) {
        setOtpError(data.error);
        return null;
      }
      setOtpVerified(true);
      return data as {
        success: boolean;
        already_verified?: boolean;
        challenge_id: string;
        payout_id?: string | null;
        verified_at?: string;
      } | null;
    } catch (e: any) {
      setOtpError(friendlyOtpError(e?.message, 'Verification failed'));
      return null;
    } finally {
      setOtpLoading(false);
    }
  }, [challengeId]);

  const resetOtp = useCallback(() => {
    setOtpSent(false);
    setOtpVerified(false);
    setOtpError(null);
    lastErrorRef.current = null;
    setVerifiedPhone(null);
    setSendStatus('idle');
    pollTokenRef.current += 1;
    inFlightRef.current = false;
    setCooldownSeconds(0);
    cooldownUntilRef.current = 0;
    setChallengeId(null);
    setExpiresAt(null);
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
    challengeId,
    expiresAt,
    getLastError,
    sendOtp,
    verifyOtp,
    sendPayoutOtp,
    resendPayoutOtp,
    verifyPayoutOtp,
    resetOtp,
  };
}
