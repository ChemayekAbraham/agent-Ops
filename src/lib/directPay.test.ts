/*
 * Author: SSENKAALI PIUS
 * Email: ssenkaali.pius@welileapp.com
 * Date: 2026-11-13
 * Website: welileapp.com
 */
import { describe, expect, it } from 'vitest';
import {
  DIRECT_PAY_FLAG_LABEL,
  directPayDecisionMessage,
  directPayMessage,
  directPayQueueCursor,
  formatUgx,
  holdTimeLeft,
  isDirectPayView,
  type DirectPayQueueRow,
  type DirectPayView,
} from './directPay';

const view = (over: Partial<DirectPayView> = {}): DirectPayView => ({
  ok: false, code: null, payment_id: 'p1', rent_request_id: 'r1', status: 'held',
  tenant_first_name: 'Musa', landlord_name: 'Okello', landlord_number: '+256 772 123456',
  amount_due: 500000, amount_received: 450000, amount_short: 50000, cover_fee: 10000, float_available: 40000,
  hold_expires_at: '2026-11-18T06:00:00Z', proofs: [], ...over,
});

describe('partner messages: the build plan wording, with real numbers', () => {
  it('short amount', () => {
    expect(directPayMessage(view({ code: 'amount_short' }))).toBe(
      'You sent UGX 450,000. This Rent Plan needs UGX 500,000. Send UGX 50,000 more to Okello and upload that SMS too.');
  });
  it('float too low for the Cover fee', () => {
    expect(directPayMessage({ ok: false, code: 'float_short', float_short: 10000 }))
      .toBe('Add UGX 10,000 to your operational float for the 2% Cover fee.');
  });
  it('hold ended carries the support number', () => {
    expect(directPayMessage(view({ code: 'hold_ended' })))
      .toBe("The hold on Musa's Rent Plan has ended. Call +256 748 747134 if you already paid.");
  });
  it('TID not read', () => {
    expect(directPayMessage(view({ code: 'tid_missing' }))).toBe("We couldn't read the Transaction ID. Type it from the SMS.");
  });
  it('nothing to say when ok', () => {
    expect(directPayMessage(view({ ok: true, code: null }))).toBeNull();
  });
  it('the cap on holds uses the number the server sent', () => {
    expect(directPayMessage({ ok: false, code: 'too_many_holds', max: 3 })).toBe('You can hold 3 Rent Plans at a time. Finish or release one first.');
  });
  it('every code has a sentence, and none uses a forbidden word', () => {
    const codes = ['not_available', 'not_partner', 'agreement_required', 'taken', 'too_many_holds', 'landlord_not_verified',
      'tenant_still_owes', 'float_short', 'invalid', 'amount_short', 'hold_ended', 'not_held', 'invalid_photo',
      'too_many_proofs', 'tid_missing', 'amount_missing', 'same_proof_again', 'photo_not_found', 'photo_too_large',
      'save_failed', 'not_signed_in', 'has_proofs', 'not_found'] as const;
    for (const code of codes) {
      const msg = directPayMessage(view({ code })) ?? '';
      expect(msg.length, code).toBeGreaterThan(5);
      expect(msg, code).not.toMatch(/\b(loan|lender|interest|ROI)\b|agent care/i);
    }
  });
});

describe('Landlord Ops messages', () => {
  it('wrong OTP says how many tries are left', () => {
    expect(directPayDecisionMessage({ ok: false, code: 'otp_wrong', attempts_left: 2 })).toBe('That code is wrong. 2 tries left.');
    expect(directPayDecisionMessage({ ok: false, code: 'otp_wrong', attempts_left: 1 })).toBe('That code is wrong. 1 try left.');
  });
  it('a flagged payment needs a reason', () => {
    expect(directPayDecisionMessage({ ok: false, code: 'flag_reason_required' })).toBe('This payment is flagged. Write why it is safe to approve.');
  });
  it('no message on success', () => {
    expect(directPayDecisionMessage({ ok: true })).toBeNull();
  });
  it('every flag has the label from the plan', () => {
    expect(Object.keys(DIRECT_PAY_FLAG_LABEL)).toHaveLength(8);
    expect(DIRECT_PAY_FLAG_LABEL.paid_before_hold).toBe('Paid before the hold');
  });
});

describe('queue paging (keyset)', () => {
  const row = { payment_id: 'p9', has_flags: true, created_at: '2026-11-17T08:00:00Z', decided_at: '2026-11-17T10:00:00Z' } as DirectPayQueueRow;
  it('pending pages continue from the last row\'s flag, time and id', () => {
    expect(directPayQueueCursor('pending', row)).toEqual({ p_after_flagged: true, p_after_at: row.created_at, p_after_id: 'p9' });
  });
  it('decided pages continue from the decision time', () => {
    expect(directPayQueueCursor('decided', row)).toEqual({ p_after_flagged: null, p_after_at: row.decided_at, p_after_id: 'p9' });
  });
  it('no last row: first page', () => {
    expect(directPayQueueCursor('pending', undefined)).toBeNull();
  });
});

describe('small helpers', () => {
  it('formats UGX', () => {
    expect(formatUgx(500000)).toBe('UGX 500,000');
    expect(formatUgx(null)).toBe('UGX 0');
  });
  it('hold countdown', () => {
    const now = Date.parse('2026-11-17T06:00:00Z');
    expect(holdTimeLeft('2026-11-18T08:30:00Z', now).label).toBe('26h 30m left');
    expect(holdTimeLeft('2026-11-17T06:20:00Z', now).label).toBe('20m left');
    expect(holdTimeLeft('2026-11-17T05:00:00Z', now)).toMatchObject({ ended: true, label: 'Hold ended' });
  });
  it('tells a payment view from a refusal', () => {
    expect(isDirectPayView(view())).toBe(true);
    expect(isDirectPayView({ ok: false, code: 'taken' })).toBe(false);
  });
});
