import { describe, expect, it } from 'vitest';
import {
  AWAITING_LANDLORD_PAYMENT,
  formatDay,
  hoursLeft,
  landlordPaymentCopy,
  landlordPaymentState,
  staffAttentionReason,
  staffResolveErrorMessage,
  staffResolveProblem,
  supportOutcome,
  supportSubmittedCopy,
  type LandlordPayment,
  type StaffLandlordPayment,
} from './selfSupportDirect';

const NOW = Date.parse('2026-11-12T10:00:00Z');
const inHours = (h: number) => new Date(NOW + h * 3_600_000).toISOString();

const payment = (over: Partial<LandlordPayment> = {}): LandlordPayment => ({
  id: 'p1', status: 'queued', rent_request_id: 'rr1', amount: 1_000_000, landlord_name: 'Mukasa',
  expires_at: inHours(47.2), paid_at: null, earning_from: null, refunded_at: null,
  created_at: inHours(-1), role: 'partner', tenant_first_name: 'Odenyo', my_share: 510_000, ...over,
});

const staffRow = (over: Partial<StaffLandlordPayment> = {}): StaffLandlordPayment => ({
  id: 's1', status: 'queued', rent_request_id: 'rr1', amount: 500_000, landlord_name: 'Mukasa', landlord_phone: '0772000001',
  created_at: inHours(-50), expires_at: inHours(-2), paid_at: null, refunded_at: null, refund_reason: null,
  earning_from: null, stuck_flagged_at: null, overdue: true, withdrawal_id: 'w1', withdrawal_status: 'pending',
  merchant_claimed: false, landlord_payout_id: 'lp1', payout_status: 'pending_merchant_payout', payout_error: null,
  agent_id: 'a1', agent_name: 'Agent', tenant_name: 'Odenyo', partners: [], can_refund: true, can_mark_paid: false, ...over,
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
  it('partner waiting: the merchant pays, earning starts the day after', () => {
    const c = landlordPaymentCopy(payment(), NOW);
    expect(c.label).toBe('Waiting for the merchant to pay the landlord');
    expect(c.detail).toContain('Mukasa UGX 1,000,000 within 48 hours');
    expect(c.detail).toContain('Rent Profit Share starts the day after the landlord is paid');
    expect(c.tone).toBe('pending');
  });
  it('agent waiting: handles no money', () => {
    expect(landlordPaymentCopy(payment({ role: 'agent' }), NOW).detail).toContain('You do not handle this money');
  });
  it('paid shows the earning date; refunded shows the partner their own half', () => {
    expect(landlordPaymentCopy(payment({ status: 'paid', earning_from: '2026-11-13' }), NOW).detail)
      .toContain('Rent Profit Share started on 13 Nov 2026');
    expect(landlordPaymentCopy(payment({ status: 'refunded' }), NOW).detail).toContain('your UGX 510,000 is back in your float');
  });
  it('never uses banned words', () => {
    for (const status of ['queued', 'paid', 'refunded'] as const) {
      for (const role of ['partner', 'agent'] as const) {
        const c = landlordPaymentCopy(payment({ status, role, earning_from: '2026-11-13' }), NOW);
        expect(`${c.label} ${c.detail}`).not.toMatch(/\b(loan|lender|interest|ROI|returns?)\b/i);
      }
    }
  });
});

describe('supportOutcome / supportSubmittedCopy', () => {
  it('reads every server shape', () => {
    expect(supportOutcome({ status: AWAITING_LANDLORD_PAYMENT, merchant_direct: true })).toBe('merchant_queue');
    expect(supportOutcome({ status: 'active', earning_from: '2026-11-13' })).toBe('house_active');
    expect(supportOutcome({ house_active: true })).toBe('house_active');
    expect(supportOutcome({ funding_mode: 'receivable' })).toBe('receivable');
    expect(supportOutcome({ status: 'active', landlord_float_released: true })).toBe('released_to_agent');
    expect(supportOutcome({ status: 'pending_ops_approval' })).toBe('pending_approval');
    expect(supportOutcome(null)).toBe('pending_approval');
  });
  it('merchant queue toast promises no Partner Ops step', () => {
    const t = supportSubmittedCopy({ merchant_direct: true }, 510_000);
    expect(t.title).toBe('Sent to the merchant');
    expect(t.description).toContain('UGX 510,000');
    expect(t.description).not.toContain('Partner Operations');
  });
  it('house toast gives the start date', () => {
    expect(supportSubmittedCopy({ status: 'active', earning_from: '2026-11-13' }, 306_000).description).toContain('13 Nov 2026');
  });
});

describe('staff helpers', () => {
  it('attention reasons', () => {
    expect(staffAttentionReason(staffRow({ payout_status: 'failed', withdrawal_status: 'processing', can_refund: true }), NOW))
      .toContain('confirm with the merchant');
    expect(staffAttentionReason(staffRow({ can_mark_paid: true, can_refund: false, withdrawal_status: 'completed' }), NOW))
      .toContain('completed');
    expect(staffAttentionReason(staffRow({ merchant_claimed: true }), NOW)).toContain('claimed by a merchant');
    expect(staffAttentionReason(staffRow(), NOW)).toContain('Over 48 hours');
  });
  it('resolve problems mirror the server', () => {
    expect(staffResolveProblem(staffRow(), 'refund', 'short')).toMatch(/10 characters/);
    expect(staffResolveProblem(staffRow(), 'refund', 'merchant confirmed nothing sent')).toBeNull();
    expect(staffResolveProblem(staffRow(), 'paid', 'merchant confirmed nothing sent')).toMatch(/not completed/);
    expect(staffResolveProblem(staffRow({ can_refund: false, can_mark_paid: true }), 'refund', 'xxxxxxxxxxxx')).toMatch(/Resolve it as paid/);
    expect(staffResolveProblem(staffRow({ status: 'paid' }), 'paid', 'xxxxxxxxxxxx')).toMatch(/already settled/);
  });
  it('server errors in plain words', () => {
    expect(staffResolveErrorMessage({ message: 'only Financial Ops can resolve a self-support landlord payment' }))
      .toBe('Only Financial Ops can settle these payments.');
    expect(staffResolveErrorMessage({ message: 'The merchant withdrawal is completed: the landlord was paid. Resolve as paid.' }))
      .toBe('The merchant withdrawal is completed: the landlord was paid. Resolve as paid.');
  });
  it('formatDay is timezone-safe', () => {
    expect(formatDay('2026-11-13')).toBe('13 Nov 2026');
    expect(formatDay(null)).toBe('');
  });
});

describe('supportErrorMessage / steps', () => {
  it('drops the code, keeps the sentence', async () => {
    const { supportErrorMessage, MERCHANT_DIRECT_STEPS } = await import('./selfSupportDirect');
    expect(supportErrorMessage('LANDLORD_NOT_READY: Welile has not yet approved this landlord\'s payout number. Nothing was taken from your wallet.'))
      .toBe('Welile has not yet approved this landlord\'s payout number. Nothing was taken from your wallet.');
    expect(supportErrorMessage('PLAN_AGENT_RESTRICTED: This Rent Plan cannot be supported right now.')).toBe('This Rent Plan cannot be supported right now.');
    expect(supportErrorMessage('something else')).toBeNull();
    expect(MERCHANT_DIRECT_STEPS.map((s) => s.text).join(' ')).not.toMatch(/\b(loan|interest|ROI|returns?)\b/i);
  });
});
