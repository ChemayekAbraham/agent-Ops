import { supabase } from '@/integrations/supabase/client';
import { getDeviceFingerprint, isValidFingerprintShape } from '@/lib/deviceFingerprint';

/**
 * Withdrawal PIN (docs 258 to 260). The PIN is checked by the database; this file only calls the RPCs and the
 * edge function `withdrawal-pin-reset` and turns their codes into words. It never stores, logs or returns a PIN
 * or a code, and it writes no ledger or wallet state.
 */

export type PinPurpose = 'withdrawal' | 'payout_number_change' | 'pin_change';

export interface PinResult {
  success: boolean;
  code: string;
  message?: string;
  attemptsLeft?: number;
  lockedUntil?: string;
  releaseAt?: string;
  resetId?: string;
  challengeId?: string;
  destinationMasked?: string;
  deviceTrusted?: boolean;
  raw?: any;
}

export interface PinStatus {
  hasPin: boolean;
  required: boolean;
  lockedUntil: string | null;
  numberChangeHoldUntil: string | null;
  pendingReset: { id: string; releaseAt: string } | null;
}

const rpc = (name: string, args?: Record<string, unknown>) => (supabase as any).rpc(name, args);

function toResult(d: any): PinResult {
  const r = d ?? {};
  return {
    success: r.success === true,
    code: String(r.code ?? (r.success === true ? 'ok' : 'unknown')),
    message: r.message,
    attemptsLeft: typeof r.attempts_left === 'number' ? r.attempts_left : undefined,
    lockedUntil: r.locked_until ?? undefined,
    releaseAt: r.release_at ?? undefined,
    resetId: r.reset_id ?? undefined,
    challengeId: r.challenge_id ?? undefined,
    destinationMasked: r.destination_masked ?? r.email_masked ?? undefined,
    deviceTrusted: typeof r.device_trusted === 'boolean' ? r.device_trusted : undefined,
    raw: r,
  };
}

function fail(code: string, message?: string): PinResult {
  return { success: false, code, message };
}

async function deviceFp(): Promise<string | null> {
  try {
    const fp = await getDeviceFingerprint();
    return isValidFingerprintShape(fp) ? fp : null;
  } catch {
    return null;
  }
}

/** Calls the edge function and returns its JSON body even on a 4xx (the body carries the `code`). */
async function callReset(body: Record<string, unknown>): Promise<PinResult> {
  const { data, error } = await supabase.functions.invoke('withdrawal-pin-reset', { body });
  if (error) {
    const ctx = (error as any).context;
    if (ctx && typeof ctx.json === 'function') {
      try {
        const payload = await ctx.json();
        if (payload?.code) return toResult(payload);
        return fail('server_error', payload?.error);
      } catch {
        /* fall through */
      }
    }
    return fail('network');
  }
  return toResult(data);
}

function fmtTime(iso?: string): string {
  if (!iso) return 'later';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? 'later' : d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

/** One message per code, for every code the database and the edge function can return (doc 258 section 4, doc 260). */
export function pinErrorMessage(r: Pick<PinResult, 'code' | 'attemptsLeft' | 'lockedUntil' | 'releaseAt' | 'message'>): string {
  switch (r.code) {
    case 'wrong_pin':
      return typeof r.attemptsLeft === 'number'
        ? `Wrong PIN. ${r.attemptsLeft} ${r.attemptsLeft === 1 ? 'try' : 'tries'} left before it is locked.`
        : r.message || 'Enter your 4-digit PIN.';
    case 'pin_locked':
      return `Too many wrong tries. Your PIN is locked until ${fmtTime(r.lockedUntil)}.`;
    case 'no_pin':
      return 'You have not set a withdrawal PIN yet. Set one in Settings, under Safety.';
    case 'weak_pin':
      return 'That PIN is too easy to guess. Avoid repeats like 1111 and runs like 1234.';
    case 'current_pin_required':
      return 'Enter your current PIN first.';
    case 'email_code_required':
      return 'To change your PIN we need the code we email you.';
    case 'pin_exists':
      return 'You already have a PIN. Use Change PIN.';
    case 'pin_recently_set':
      return `For your safety you cannot change a payout number until ${fmtTime(r.releaseAt)}.`;
    case 'pin_reset_pending':
      return 'A PIN reset is waiting on this account. Finish it, or cancel it if it was not you.';
    case 'already_pending':
      return 'A PIN reset is already in progress.';
    case 'rate_limited':
      return 'Too many codes requested. Wait an hour and try again.';
    case 'no_pending_reset':
      return 'No PIN reset is in progress. Start again.';
    case 'not_ready':
      return `This reset can be completed from ${fmtTime(r.releaseAt)}.`;
    case 'wrong_code':
      return typeof r.attemptsLeft === 'number'
        ? `That code is not correct. ${r.attemptsLeft} ${r.attemptsLeft === 1 ? 'try' : 'tries'} left on this code.`
        : 'That code is not correct.';
    case 'code_expired_or_used_up':
      return 'That code has expired or has no tries left. Request a new one.';
    case 'channel_not_required':
      return 'That code is not needed for this step.';
    case 'no_email':
      return 'Your account has no real email address. Add one under Email in Settings first; a new PIN cannot be set by text message.';
    case 'email_recently_changed':
      return `Your email was changed recently, so a PIN reset is paused until ${fmtTime(r.releaseAt)}. If you did not change it, contact support.`;
    case 'no_phone':
      return 'We have no phone number for this account.';
    case 'send_failed':
      return 'We could not send the code. Please try again.';
    case 'not_pending':
      return 'That reset is no longer pending.';
    case 'forbidden':
      return 'You are not allowed to do that.';
    case 'invalid_purpose':
    case 'invalid_request':
      return 'Something went wrong. Please try again.';
    case 'unauthorized':
      return 'Please sign in again.';
    case 'withdrawal_pin_required':
      return 'A withdrawal PIN is now required. Set one in Settings, under Safety, then try again.';
    case 'withdrawal_pin_proof_required':
      return 'Your PIN confirmation expired. Enter your PIN again.';
    case 'network':
      return 'Network issue. Check your connection and try again.';
    default:
      return r.message || 'Something went wrong. Please try again.';
  }
}

/** True when an error string from the database or an edge function means "enter your PIN again". */
export function isPinProofError(message: string | undefined | null): boolean {
  const m = (message || '').toLowerCase();
  return m.includes('withdrawal_pin_proof_required') || m.includes('withdrawal_pin_required');
}

export async function fetchPinStatus(): Promise<PinStatus | null> {
  const { data, error } = await rpc('my_withdrawal_pin_status');
  if (error || !data?.success) return null;
  return {
    hasPin: !!data.has_pin,
    required: !!data.required,
    lockedUntil: data.locked_until ?? null,
    numberChangeHoldUntil: data.number_change_hold_until ?? null,
    pendingReset: data.pending_reset ? { id: data.pending_reset.id, releaseAt: data.pending_reset.release_at } : null,
  };
}

/** Checks the PIN and, on success, stores a one-use 5-minute proof that the next gated insert spends. */
export async function verifyPin(pin: string, purpose: PinPurpose): Promise<PinResult> {
  if (!/^\d{4}$/.test(pin)) return fail('wrong_pin', 'Enter your 4-digit PIN.');
  const { data, error } = await rpc('verify_withdrawal_pin', {
    p_pin: pin,
    p_purpose: purpose,
    p_device_fp: await deviceFp(),
  });
  if (error) return fail('network');
  return toResult(data);
}

export async function setFirstPin(pin: string): Promise<PinResult> {
  if (!/^\d{4}$/.test(pin)) return fail('weak_pin');
  const { data, error } = await rpc('set_withdrawal_pin', { p_new_pin: pin });
  if (error) return fail('network');
  return toResult(data);
}

export async function cancelReset(resetId: string): Promise<PinResult> {
  const { data, error } = await rpc('cancel_withdrawal_pin_reset', { p_request_id: resetId });
  if (error) return fail('network');
  return toResult(data);
}

/** Forgot PIN: begin, then email a code, then complete with the code and the new PIN. */
export const forgotPin = {
  begin: () => callReset({ action: 'begin' }),
  sendCode: () => callReset({ action: 'send_code', channel: 'email' }),
  complete: (emailCode: string, newPin: string) =>
    callReset({ action: 'complete', email_code: emailCode, new_pin: newPin }),
};

/** Change PIN: the current PIN and an emailed code are both required. */
export const changePin = {
  sendCode: () => callReset({ action: 'change_send_code' }),
  complete: (currentPin: string, emailCode: string, newPin: string) =>
    callReset({ action: 'change_complete', current_pin: currentPin, email_code: emailCode, new_pin: newPin }),
};
