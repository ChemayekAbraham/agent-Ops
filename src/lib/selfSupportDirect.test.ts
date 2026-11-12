import { describe, expect, it } from 'vitest';
import {
  AWAITING_LANDLORD_PAYMENT,
  LANDLORD_PAID_STEPS,
  formatDay,
  hoursLeft,
  landlordPaymentCopy,
  landlordPaymentState,
  staffAttentionReason,
  staffResolveErrorMessage,
  staffResolveProblem,
  supportErrorMessage,
  supportOutcome,
  supportSubmittedCopy,
  type LandlordPayment,
  type StaffLandlordPayment,
} from './selfSupportDirect';

const NOW = Date.parse('2026-11-12T10:00:00Z');
const inHours = (h: number) => new Date(NOW + h * 3_600_000).toISOString();
const BANNED = /\b(loan|lender|interest|ROI|returns?)\b/i;

const payment = (over: Partial<LandlordPayment> = {}): LandlordPayment => ({
  id: 'p1', status: 'queued', rent_request_id: 'rr1', amount: 1_000_000, landlord_name: 'Mukasa',
  expires_at: inHours(47.2), paid_at: null, earning_from: null, refunded_at: null,
  created_at: inHours(-1), role: 'partner', tenant_first_name: 'Odenyo', my_share: 510_000, ...over,
});

const staffRow = (over: Partial<StaffLandlordPayment> = {}): StaffLandlordPayment => ({
  id: 's1', status: 'queued', rent_request_id: 'rr1', amount: 500_000, landlord_name: 'Mukasa', landlord_phone: '0772000001',
  created_at: inHours(-50), expires_at: inHours(-2), paid_at: null, refunded_at: null, refund_reason: null,
  earning_from: null, stuck_flagged_at: null, overdue: true, agent_id: 'a1', agent_name: 'Agent', tenant_name: 'Odenyo',
  float_remaining: 500_000, float_paid_out: 0, payout_id: null, payout_status: null, payout_error: null,
  partners: [], can_refund: true, can_mark_paid: false, ...over,
});

describe('landlordPaymentState', () => {
  it('waiting before 48h, checking after, then paid / refunded', () => {
    expect(landlordPaymentState(payment(), NOW)).toBe('waiting');
    expect(landlordPaymentState(payment({ expires_at: inHours(-1) }), NOW)).toBe('checking');
    expect(landlordPaymentState(payment({ status: 'paid' }), NOW)).toBe('paid');
    expect(landlordPaymentState(payment({ status: 'refunded' }), NOW)).toBe('refunded');
  });
  it('hoursLeft rounds up and never goes negative', () => {
    expect(hoursLeft(inHours(47.2), NOW)).toBe(48);
    expect(hoursLeft(inHours(0.1), NOW)).toBe(1);
    expect(hoursLeft(inHours(-3), NOW)).toBe(0);
  });
});

describe('landlordPaymentCopy', () => {
  it('partner waiting: with the agent, earning from the day the landlord is paid', () => {
    const c = landlordPaymentCopy(payment(), NOW);
    expect(c.label).toBe('Waiting for the landlord to be paid');
    expect(c.detail).toContain('Your UGX 510,000 is with the agent');
    expect(c.detail).toContain('Rent Profit Share starts the day the landlord is paid');
  });
  it('agent waiting: pay within the hours left or it is recalled', () => {
    const c = landlordPaymentCopy(payment({ role: 'agent' }), NOW);
    expect(c.label).toBe('Pay the landlord');
    expect(c.detail).toContain('Pay Mukasa within 48 hours, or it is recalled');
  });
  it('paid and recalled', () => {
    expect(landlordPaymentCopy(payment({ status: 'paid', earning_from: '2026-11-12' }), NOW).detail)
      .toContain('Rent Profit Share started on 12 Nov 2026');
    expect(landlordPaymentCopy(payment({ status: 'refunded' }), NOW).detail).toContain('your UGX 510,000 is back in your float');
    expect(landlordPaymentCopy(payment({ status: 'refunded', role: 'agent' }), NOW).detail).toContain('Do not pay the landlord');
  });
  it('never uses banned words', () => {
    for (const status of ['queued', 'paid', 'refunded'] as const) {
      for (const role of ['partner', 'agent'] as const) {
        const c = landlordPaymentCopy(payment({ status, role, earning_from: '2026-11-12' }), NOW);
        expect(`${c.label} ${c.detail}`).not.toMatch(BANNED);
      }
    }
    expect(LANDLORD_PAID_STEPS.map((s) => `${s.title} ${s.text}`).join(' ')).not.toMatch(BANNED);
  });
});

describe('supportOutcome / supportSubmittedCopy', () => {
  it('reads every server shape', () => {
    expect(supportOutcome({ status: AWAITING_LANDLORD_PAYMENT, activates_when_landlord_paid: true, landlord_float_released: true }))
      .toBe('awaiting_landlord');
    expect(supportOutcome({ status: 'active', earning_from: '2026-11-12' })).toBe('house_active');
    expect(supportOutcome({ house_active: true })).toBe('house_active');
    expect(supportOutcome({ funding_mode: 'receivable' })).toBe('receivable');
    expect(supportOutcome({ status: 'active', landlord_float_released: true })).toBe('released_to_agent');
    expect(supportOutcome({ status: 'pending_ops_approval' })).toBe('pending_approval');
    expect(supportOutcome(null)).toBe('pending_approval');
  });
  it('the Rent Plan toast promises no Partner Ops step and explains the 48 hours', () => {
    const t = supportSubmittedCopy({ activates_when_landlord_paid: true }, 510_000);
    expect(t.title).toBe('Sent to the agent');
    expect(t.description).toContain('UGX 510,000');
    expect(t.description).toContain('48 hours');
    expect(t.description).not.toContain('Partner Operations');
  });
  it('house toast gives the start date', () => {
    expect(supportSubmittedCopy({ status: 'active', earning_from: '2026-11-12' }, 306_000).description).toContain('12 Nov 2026');
  });
});

describe('staff helpers', () => {
  it('attention reasons', () => {
    expect(staffAttentionReason(staffRow({ can_mark_paid: true, can_refund: false, payout_status: 'awaiting_agent_receipt' }), NOW))
      .toContain('mark it paid');
    expect(staffAttentionReason(staffRow({ float_paid_out: 100_000, can_refund: false }), NOW)).toContain('recovery case');
    expect(staffAttentionReason(staffRow({ payout_status: 'pending_merchant_payout', can_refund: false }), NOW))
      .toContain('pending merchant payout');
    expect(staffAttentionReason(staffRow(), NOW)).toContain('recall it');
  });
  it('resolve problems mirror the server', () => {
    expect(staffResolveProblem(staffRow(), 'refund', 'short')).toMatch(/10 characters/);
    expect(staffResolveProblem(staffRow(), 'refund', 'agent never paid the landlord')).toBeNull();
    expect(staffResolveProblem(staffRow(), 'paid', 'agent never paid the landlord')).toMatch(/not paid/);
    expect(staffResolveProblem(staffRow({ can_refund: false, payout_status: 'pending_merchant_payout' }), 'refund', 'xxxxxxxxxxxx'))
      .toMatch(/Settle or fail it first/);
    expect(staffResolveProblem(staffRow({ can_refund: false, float_paid_out: 5 }), 'refund', 'xxxxxxxxxxxx')).toMatch(/recovery/);
    expect(staffResolveProblem(staffRow({ status: 'paid' }), 'paid', 'xxxxxxxxxxxx')).toMatch(/already settled/);
  });
  it('server errors in plain words', () => {
    expect(staffResolveErrorMessage({ message: 'only Financial Ops can resolve a self-support landlord payment' }))
      .toBe('Only Financial Ops can settle these plans.');
    expect(staffResolveErrorMessage({ message: 'Cannot recall: an agent landlord payout for this Rent Plan is in progress or paid' }))
      .toMatch(/Settle or fail it first/);
    expect(supportErrorMessage('RENT_RECALLED: the rent for this tenant was recalled. Do not pay the landlord.'))
      .toBe('the rent for this tenant was recalled. Do not pay the landlord.');
    expect(supportErrorMessage('something else')).toBeNull();
  });
  it('formatDay is timezone-safe', () => {
    expect(formatDay('2026-11-13')).toBe('13 Nov 2026');
    expect(formatDay(null)).toBe('');
  });
});
