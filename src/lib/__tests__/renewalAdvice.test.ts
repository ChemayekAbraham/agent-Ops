import { describe, expect, it } from 'vitest';
import {
  parseRentInput,
  percentChange,
  renewRpcArgs,
  renewalChanged,
  renewalChoiceProblem,
  renewalErrorMessage,
  renewalHint,
  RENEWAL_REASONS,
  type RenewalChoice,
} from '../renewalAdvice';

const choice = (over: Partial<RenewalChoice> = {}): RenewalChoice => ({
  newRent: 450000, newDays: 60, dailyRepayment: 9100, totalRepayment: 1081340, changed: true,
  reasonCode: 'landlord_raised', explanation: '  The landlord raised the rent.  ', evidenceUrl: null, ...over,
});

describe('renewalHint', () => {
  it('lower than the current rent is "lower", whatever the suggestion', () => {
    expect(renewalHint(250000, 300000, 300000)).toEqual({ kind: 'lower', aboveBy: 0, abovePct: 0 });
    expect(renewalHint(250000, 300000, 450000).kind).toBe('lower');
  });
  it('at the current rent, or up to the suggested maximum, is "within"', () => {
    expect(renewalHint(300000, 300000, 300000).kind).toBe('within');
    expect(renewalHint(450000, 300000, 450000).kind).toBe('within');
  });
  it('above the suggested maximum is "above", with the difference and its whole percent', () => {
    expect(renewalHint(500000, 300000, 400000)).toEqual({ kind: 'above', aboveBy: 100000, abovePct: 25 });
    expect(renewalHint(6000000, 300000, 300000).kind).toBe('above');
  });
  it('a zero suggestion does not divide by zero', () => {
    expect(renewalHint(100, 0, 0)).toEqual({ kind: 'above', aboveBy: 100, abovePct: 0 });
  });
});

describe('percentChange and renewalChanged', () => {
  it('is signed and whole', () => {
    expect(percentChange(300000, 450000)).toBe(50);
    expect(percentChange(300000, 150000)).toBe(-50);
    expect(percentChange(0, 100)).toBe(0);
  });
  it('is changed when the rent OR the days differ', () => {
    expect(renewalChanged(300000, 30, 300000, 30)).toBe(false);
    expect(renewalChanged(310000, 30, 300000, 30)).toBe(true);
    expect(renewalChanged(300000, 60, 300000, 30)).toBe(true);
  });
});

describe('renewalChoiceProblem (what stops a Continue tap)', () => {
  const ok = { newRent: 300000, newDays: 30, changed: false, reasonCode: null, explanation: '', minExplanation: 10 } as const;
  it('an unchanged renewal needs nothing else', () => { expect(renewalChoiceProblem(ok)).toBeNull(); });
  it('stops a rent of 0, a missing rent and missing days', () => {
    expect(renewalChoiceProblem({ ...ok, newRent: 0 })).toMatch(/above UGX 0/);
    expect(renewalChoiceProblem({ ...ok, newRent: NaN })).toMatch(/above UGX 0/);
    expect(renewalChoiceProblem({ ...ok, newDays: null })).toMatch(/number of days/);
  });
  it('a changed rent or days needs a reason and a long enough explanation', () => {
    expect(renewalChoiceProblem({ ...ok, changed: true })).toMatch(/reason/);
    expect(renewalChoiceProblem({ ...ok, changed: true, reasonCode: 'other' })).toMatch(/at least 10 characters/);
    expect(renewalChoiceProblem({ ...ok, changed: true, reasonCode: 'other', explanation: '         short' })).toMatch(/at least 10/);
    expect(renewalChoiceProblem({ ...ok, changed: true, reasonCode: 'other', explanation: 'A real explanation.' })).toBeNull();
  });
  it('uses the minimum the server reports', () => {
    expect(renewalChoiceProblem({ ...ok, changed: true, reasonCode: 'other', explanation: 'twelve chars', minExplanation: 40 })).toMatch(/at least 40/);
  });
  it('never stops a rent because it is above the suggestion (that is not an input here at all)', () => {
    expect(renewalChoiceProblem({ ...ok, newRent: 9_000_000, changed: true, reasonCode: 'landlord_raised', explanation: 'The landlord raised the rent.' })).toBeNull();
  });
});

describe('renewRpcArgs', () => {
  it('an unchanged renewal sends only the previous plan, as the old call did', () => {
    expect(renewRpcArgs('p1', null)).toEqual({ p_prev_request_id: 'p1' });
    expect(renewRpcArgs('p1', null, { latitude: 0.35, longitude: 32.58 })).toEqual({ p_prev_request_id: 'p1', p_latitude: 0.35, p_longitude: 32.58 });
  });
  it('an unchanged choice sends the figures but no reason', () => {
    expect(renewRpcArgs('p1', choice({ changed: false, reasonCode: null, explanation: '' }))).toEqual({ p_prev_request_id: 'p1', p_new_rent_amount: 450000, p_new_days: 60 });
  });
  it('a changed choice sends rent, days, reason, the trimmed explanation, and the evidence link when there is one', () => {
    expect(renewRpcArgs('p1', choice())).toEqual({
      p_prev_request_id: 'p1', p_new_rent_amount: 450000, p_new_days: 60, p_change_reason_code: 'landlord_raised', p_change_explanation: 'The landlord raised the rent.',
    });
    expect(renewRpcArgs('p1', choice({ evidenceUrl: 'https://x.test/a.webp' })).p_evidence_url).toBe('https://x.test/a.webp');
  });
  it('offers exactly the four reason codes the database accepts', () => {
    expect(RENEWAL_REASONS.map((r) => r.code)).toEqual(['landlord_raised', 'moved_house', 'tenant_requested_lower', 'other']);
  });
});

describe('renewalErrorMessage', () => {
  it('turns each renewal error into one plain line', () => {
    expect(renewalErrorMessage(new Error('RENEWAL_EXPLANATION_REQUIRED: changing the rent or the number of days needs a reason'), 10)).toBe('Pick a reason and explain the change in at least 10 characters.');
    expect(renewalErrorMessage('RENEWAL_DAYS_NOT_ALLOWED: 45 days is not an allowed plan length')).toMatch(/not offered/);
    expect(renewalErrorMessage('RENEWAL_AMOUNT_INVALID: the new rent must be more than UGX 0')).toMatch(/above UGX 0/);
    expect(renewalErrorMessage('RENEWAL_OTP_MISMATCH: the code the tenant confirmed was for a different rent')).toMatch(/new code/);
    expect(renewalErrorMessage('RENEWAL_OTP_REQUIRED: the tenant must confirm')).toMatch(/code sent to their phone/);
    expect(renewalErrorMessage('NOT_YOUR_REQUEST: this tenant is handled by another agent')).toMatch(/another agent/);
    expect(renewalErrorMessage('DAILY_ELIGIBILITY_BLOCKED')).toMatch(/50%/);
  });
  it('keeps the code function\'s own plain sentences and never returns an empty line', () => {
    expect(renewalErrorMessage(new Error('Wrong code. Check with the tenant and try again.'))).toBe('Wrong code. Check with the tenant and try again.');
    expect(renewalErrorMessage('')).toBe('Something went wrong. Please try again.');
    expect(renewalErrorMessage(null)).toBe('Something went wrong. Please try again.');
    expect(renewalErrorMessage({ message: 'SOMETHING_ELSE: odd failure' })).toBe('odd failure');
  });
  it('uses the regulatory wording and none of the banned words', () => {
    const all = ['RENEWAL_EXPLANATION_REQUIRED', 'RENEWAL_DAYS_NOT_ALLOWED', 'RENEWAL_AMOUNT_INVALID', 'RENEWAL_OTP_MISMATCH', 'PLAN_NOT_COMPLETED'].map((c) => renewalErrorMessage(c)).join(' ');
    expect(all).not.toMatch(/\b(loan|lender|interest|ROI)\b/i);
    expect(renewalErrorMessage('PLAN_NOT_COMPLETED')).toMatch(/Rent Plan/);
  });
});

describe('parseRentInput', () => {
  it('reads grouped and plain digits, and gives NaN for nothing', () => {
    expect(parseRentInput('1,200,000')).toBe(1200000);
    expect(parseRentInput('UGX 450000')).toBe(450000);
    expect(parseRentInput('')).toBeNaN();
    expect(parseRentInput('abc')).toBeNaN();
  });
});
