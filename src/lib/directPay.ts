/*
 * Author: SSENKAALI PIUS
 * Email: ssenkaali.pius@welileapp.com
 * Date: 2026-11-13
 * Website: welileapp.com
 *
 * Option 2 of self-support: the partner pays the landlord directly from their own phone, uploads the SMS, and
 * Landlord Ops approve after calling the landlord and checking the landlord's OTP.
 *
 * Types and pure helpers only (no Supabase import, so Vitest loads it as is). The calls are in
 * src/hooks/useDirectPay.ts. Every decision is made in the database (migrations 20261121090000 .. 130000);
 * this file only turns the codes the database returns into the words in the build plan.
 * Words: Rent Plan, Rent Profit Share, Cover fee. Never loan, interest, ROI or Agent Care.
 */

export const DIRECT_PAY_SUPPORT_PHONE = '+256 748 747134';
export const DIRECT_PAY_PROOF_BUCKET = 'funder-offplatform-receipts';
export const DIRECT_PAY_HOLD_HOURS = 48;

export type DirectPayStatus = 'held' | 'pending' | 'confirmed' | 'rejected' | 'expired';

/** What the partner's calls return (direct_pay_claim / _release / _refresh / _my_payments / the proof upload). */
export interface DirectPayView {
  ok: boolean;
  code: DirectPayCode | null;
  payment_id: string;
  rent_request_id: string;
  status: DirectPayStatus;
  tenant_first_name: string;
  landlord_name: string;
  /** Only while held or pending: the landlord's VERIFIED mobile money number. */
  landlord_number: string | null;
  amount_due: number;
  amount_received: number;
  amount_short: number;
  cover_fee: number;
  float_available: number;
  hold_expires_at: string;
  /** Only with code 'float_short'. */
  float_short?: number;
  proofs: { id: string; amount: number | null; tid_last4: string | null; created_at: string }[];
}

/** A refusal without a payment (claim refused before anything was held). */
export interface DirectPayRefusal {
  ok: false;
  code: DirectPayCode;
  cover_fee?: number;
  float_available?: number;
  float_short?: number;
  max?: number;
}

export type DirectPayClaimResult = DirectPayView | DirectPayRefusal;

export type DirectPayCode =
  // claim
  | 'not_available' | 'not_partner' | 'agreement_required' | 'taken' | 'too_many_holds' | 'landlord_not_verified'
  | 'tenant_still_owes' | 'float_short' | 'invalid'
  // proofs
  | 'amount_short' | 'hold_ended' | 'not_held' | 'invalid_photo' | 'too_many_proofs' | 'tid_missing' | 'amount_missing'
  | 'same_proof_again' | 'photo_not_found' | 'photo_too_large' | 'save_failed' | 'not_signed_in'
  // release / refresh
  | 'has_proofs' | 'not_found';

export function isDirectPayView(r: DirectPayClaimResult | null | undefined): r is DirectPayView {
  return !!r && typeof (r as DirectPayView).payment_id === 'string';
}

export function formatUgx(amount: number | null | undefined): string {
  return 'UGX ' + Math.round(Number(amount) || 0).toLocaleString('en-US');
}

/**
 * The sentence to show the partner for a code. Wording from the build plan (Hold, checks and flags), with the
 * plan's real numbers. Returns null when there is nothing to say (ok and no code).
 */
export function directPayMessage(r: DirectPayClaimResult | null | undefined): string | null {
  if (!r || !r.code) return null;
  const v = isDirectPayView(r) ? r : null;
  const tenant = v?.tenant_first_name || 'the tenant';
  const landlord = v?.landlord_name || 'the landlord';
  switch (r.code) {
    case 'amount_short':
      return v
        ? `You sent ${formatUgx(v.amount_received)}. This Rent Plan needs ${formatUgx(v.amount_due)}. ` +
          `Send ${formatUgx(v.amount_short)} more to ${landlord} and upload that SMS too.`
        : null;
    case 'float_short':
      return `Add ${formatUgx(r.float_short ?? 0)} to your operational float for the 2% Cover fee.`;
    case 'hold_ended':
      return `The hold on ${tenant}'s Rent Plan has ended. Call ${DIRECT_PAY_SUPPORT_PHONE} if you already paid.`;
    case 'tid_missing':
      return "We couldn't read the Transaction ID. Type it from the SMS.";
    case 'amount_missing':
      return "We couldn't read the amount. Type the amount from the SMS.";
    case 'same_proof_again':
      return 'You already uploaded this SMS for this Rent Plan.';
    case 'too_many_proofs':
      return `You can upload up to 5 SMS for one Rent Plan. Call ${DIRECT_PAY_SUPPORT_PHONE} for help.`;
    case 'invalid_photo':
    case 'photo_not_found':
      return 'The photo did not upload. Please try again.';
    case 'photo_too_large':
      return 'That photo is too large. Take a screenshot of the SMS instead.';
    case 'taken':
      return 'Another partner is supporting this Rent Plan. Please choose another one.';
    case 'too_many_holds': {
      const max = (r as DirectPayRefusal).max ?? 3;
      return `You can hold ${max} Rent Plans at a time. Finish or release one first.`;
    }
    case 'landlord_not_verified':
      return "This landlord's number is not verified yet, so you can't pay them directly. Choose another Rent Plan.";
    case 'tenant_still_owes':
      return 'This tenant is still repaying another Rent Plan, so this one cannot be supported yet.';
    case 'agreement_required':
      return 'Sign your partnership agreement first, then you can support a Rent Plan.';
    case 'not_available':
      return 'Paying the landlord directly is not available yet.';
    case 'not_held':
    case 'has_proofs':
      return 'This Rent Plan is already with Landlord Ops. We will tell you when it is done.';
    case 'not_signed_in':
      return 'Please sign in again.';
    case 'save_failed':
      return 'We could not save your SMS. Please try again.';
    default:
      return 'Something went wrong. Please try again.';
  }
}

/** Time left on a hold, for the countdown. */
export function holdTimeLeft(holdExpiresAt: string | null | undefined, now: number = Date.now()) {
  const ends = holdExpiresAt ? Date.parse(holdExpiresAt) : NaN;
  if (Number.isNaN(ends)) return { ms: 0, ended: true, label: '' };
  const ms = Math.max(0, ends - now);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return { ms, ended: ms === 0, label: ms === 0 ? 'Hold ended' : h > 0 ? `${h}h ${m}m left` : `${m}m left` };
}

// ------------------------------------------------------------------ Landlord Ops

export type DirectPayFlag =
  | 'tid_used_before' | 'paid_before_hold' | 'wrong_number' | 'number_not_read' | 'tids_differ'
  | 'photo_unreadable' | 'same_photo' | 'paid_more';

/** The flag names from the build plan (Flagged for Landlord Ops). */
export const DIRECT_PAY_FLAG_LABEL: Record<DirectPayFlag, string> = {
  tid_used_before: 'TID used before',
  paid_before_hold: 'Paid before the hold',
  wrong_number: 'Wrong number',
  number_not_read: 'Number not read',
  tids_differ: 'TIDs differ',
  photo_unreadable: 'Photo unreadable',
  same_photo: 'Same photo again',
  paid_more: 'Paid more',
};

export interface DirectPayQueueProof {
  id: string;
  photo_path: string;
  provider: 'mtn' | 'airtel' | null;
  amount_read: number | null;
  amount_typed: number | null;
  tid_read: string | null;
  tid_typed: string | null;
  recipient_read: string | null;
  paid_at_read: string | null;
  reader_status: 'pending' | 'read' | 'unreadable' | 'error';
  created_at: string;
}

export interface DirectPayQueueRow {
  payment_id: string;
  status: DirectPayStatus;
  created_at: string;
  has_flags: boolean;
  flags: DirectPayFlag[];
  waiting_hours: number;
  over_24h: boolean;
  decided_at: string | null;
  rent_request_id: string;
  amount_due: number;
  amount_received: number;
  cover_fee: number;
  cover_fee_status: string;
  partner: { id: string; name: string | null; phone: string | null };
  tenant: { name: string | null; phone: string | null };
  agent: { id: string | null; name: string | null; phone: string | null };
  landlord: { name: string | null; phone_on_file: string | null; verified_number: string | null };
  call_note: string | null;
  flag_reason: string | null;
  reject_note: string | null;
  otp: { status: string; sent_at: string; expires_at: string; attempts_left: number } | null;
  proofs: DirectPayQueueProof[];
}

export type DirectPayQueueView = 'pending' | 'decided';

export interface DirectPayQueuePage {
  can_act: boolean;
  rows: DirectPayQueueRow[];
}

/** Arguments for the next page of direct_pay_ops_queue (keyset: no offsets, no repeats). */
export function directPayQueueCursor(view: DirectPayQueueView, last: DirectPayQueueRow | undefined) {
  if (!last) return null;
  return view === 'decided'
    ? { p_after_flagged: null, p_after_at: last.decided_at, p_after_id: last.payment_id }
    : { p_after_flagged: last.has_flags, p_after_at: last.created_at, p_after_id: last.payment_id };
}

export type DirectPayDecisionCode =
  | 'otp_required' | 'otp_wrong' | 'otp_expired' | 'otp_locked' | 'call_note_required' | 'flag_reason_required'
  | 'agreement_required' | 'plan_changed' | 'tenant_still_owes' | 'tid_already_approved' | 'not_pending'
  | 'not_found' | 'reason_required';

export interface DirectPayDecisionResult {
  ok: boolean;
  code?: DirectPayDecisionCode;
  attempts_left?: number;
  payment_id?: string;
  portfolio_id?: string;
  receipt_number?: string;
  receipt_code?: string;
  cover_fee_status?: string;
  repayment_starts_on?: string;
}

/** The sentence to show the Landlord Ops officer for an approve / reject refusal. */
export function directPayDecisionMessage(r: DirectPayDecisionResult | null | undefined): string | null {
  if (!r || r.ok || !r.code) return null;
  switch (r.code) {
    case 'otp_required': return 'Send the landlord an OTP first, then enter the code they read out.';
    case 'otp_wrong': return `That code is wrong. ${r.attempts_left ?? 0} ${r.attempts_left === 1 ? 'try' : 'tries'} left.`;
    case 'otp_expired': return 'The code has expired. Send a new OTP.';
    case 'otp_locked': return 'Too many wrong codes. Send a new OTP.';
    case 'call_note_required': return 'Write a short note of the call.';
    case 'flag_reason_required': return 'This payment is flagged. Write why it is safe to approve.';
    case 'agreement_required': return "The partner hasn't signed their partnership agreement yet.";
    case 'plan_changed': return 'This Rent Plan changed since the partner paid. Reject it and call the partner.';
    case 'tenant_still_owes': return 'The tenant is still repaying another Rent Plan. Do not approve; call the partner.';
    case 'tid_already_approved': return 'A Transaction ID on this payment was already approved on another payment. Reject it.';
    case 'not_pending': return 'Someone already decided this payment.';
    case 'reason_required': return 'Write the reason for rejecting.';
    default: return 'Something went wrong. Please try again.';
  }
}

export interface DirectPayOtpSendResult {
  ok: boolean;
  code: string | null;
  challenge_id?: string;
  sent_to?: string;
  expires_at?: string;
}

// ------------------------------------------------------------------ agent

export interface DirectPayAgentItem {
  payment_id: string;
  rent_request_id: string;
  amount: number;
  confirmed_at: string;
  tenant_name: string | null;
  landlord_name: string | null;
  partner_first_name: string;
  receipt_number: string | null;
  receipt_code: string | null;
  landlord_receipt_number: string | null;
  landlord_receipt_recorded_at: string | null;
  needs_landlord_receipt: boolean;
}

export const welileReceiptUrl = (code: string) => `https://welileapp.com/r/${code}`;
