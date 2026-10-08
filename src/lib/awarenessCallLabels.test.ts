import { describe, it, expect } from 'vitest';
import {
  CONSENT_OPTIONS, LABEL_30M_ACCESS, LABEL_LANDLORD_CONSENT, LABEL_PAYOUT_OTP, LABEL_SELF_PAYMENT, QUESTION_30M_ACCESS, QUESTION_EXPLAINED,
  QUESTION_LANDLORD_CONSENT, QUESTION_PAYOUT_OTP, QUESTION_SELF_PAYMENT, LANDLORD_READ_ALOUD,
  answerRowsForCall, answerShape, answersLine, consentLabel,
  defaultAwarenessSubjectForStage, isAwarenessReadOnlyStage, isNotAuthorizedError, telHref,
} from './awarenessCallLabels';
import { ANSWER_FILTER_OPTIONS } from './awarenessMonitoringLabels';

describe('defaultAwarenessSubjectForStage', () => {
  it('Landlord Ops (the tenant_ops_approved queue) starts with the landlord', () => {
    expect(defaultAwarenessSubjectForStage('tenant_ops_approved')).toBe('landlord');
  });

  it('Agent Ops (pending) and Tenant Ops (agent_ops_approved) start with the tenant, as does every other stage', () => {
    for (const stage of ['pending', 'agent_ops_approved', 'landlord_ops_approved', 'partner_ops_approved', 'coo_approved', 'service_center_review', '', null, undefined]) {
      expect(defaultAwarenessSubjectForStage(stage as string | null | undefined)).toBe('tenant');
    }
  });
});

describe('telHref', () => {
  it('keeps digits and a leading plus, and refuses a number that is too short', () => {
    expect(telHref('0700 111-222')).toBe('tel:0700111222');
    expect(telHref('+256 700 333 444')).toBe('tel:+256700333444');
    expect(telHref('123')).toBeNull();
    expect(telHref('')).toBeNull();
  });
});

describe('question and label wording', () => {
  it('uses the plan\'s exact questions and the renamed short labels', () => {
    expect(QUESTION_30M_ACCESS).toBe('Does this person know that a tenant who pays well can grow their access up to UGX 30,000,000?');
    expect(QUESTION_SELF_PAYMENT).toBe('Does this person know they can pay by themselves using the Welile merchant codes (self-payment)?');
    expect(QUESTION_EXPLAINED).toBe('Did you explain it to them on this call?');
    expect(LABEL_30M_ACCESS).toBe('Knew about 30M access');
    expect(LABEL_SELF_PAYMENT).toBe('Knew about merchant-code self-payment');
  });

  it('the answer filter carries the renamed labels, with the stored values unchanged', () => {
    const values = ANSWER_FILTER_OPTIONS.map((o) => o.value);
    expect(values).toContain('aware_30m:knew');
    expect(values).toContain('aware_merchant_codes:did_not_know');
    expect(values).toContain('explained:partly');
    expect(ANSWER_FILTER_OPTIONS.find((o) => o.value === 'aware_30m:knew')?.label).toBe('Knew about 30M access: Knew about it');
  });
});

describe('isAwarenessReadOnlyStage', () => {
  it('is read-only only for the COO and CFO stages', () => {
    expect(isAwarenessReadOnlyStage('partner_ops_approved')).toBe(true);
    expect(isAwarenessReadOnlyStage('coo_approved')).toBe(true);
    for (const stage of ['service_center_review', 'pending', 'agent_ops_approved', 'tenant_ops_approved', 'landlord_ops_approved', '', null, undefined]) {
      expect(isAwarenessReadOnlyStage(stage as string | null | undefined)).toBe(false);
    }
  });
});

describe('isNotAuthorizedError', () => {
  it('only matches the "not authorized" refusal', () => {
    expect(isNotAuthorizedError({ message: 'not authorized' })).toBe(true);
    expect(isNotAuthorizedError(new Error('Not authorised'))).toBe(true);
    expect(isNotAuthorizedError({ message: 'connection reset' })).toBe(false);
    expect(isNotAuthorizedError(null)).toBe(false);
  });
});

describe('landlord questions', () => {
  it('uses the exact wording and labels', () => {
    expect(QUESTION_LANDLORD_CONSENT).toBe("Does the landlord consent to receive this tenant's rent through Welile?");
    expect(QUESTION_PAYOUT_OTP).toBe('Does the landlord know about the payment code (OTP)? When they are paid, Welile sends an SMS from WELILE with a 6-digit code valid for 1 hour, to share only with the agent paying them.');
    expect(LABEL_LANDLORD_CONSENT).toBe('Landlord consent');
    expect(LABEL_PAYOUT_OTP).toBe('Knew about payment code (OTP)');
    expect(CONSENT_OPTIONS.map((o) => [o.value, o.label])).toEqual([
      ['consents', 'Consents'], ['unsure', 'Not sure, wants to think'], ['refuses', 'Does not consent'],
    ]);
    expect(consentLabel('refuses')).toBe('Does not consent');
    expect(LANDLORD_READ_ALOUD).toContain('SMS from WELILE');
    expect(`${QUESTION_LANDLORD_CONSENT} ${QUESTION_PAYOUT_OTP} ${LANDLORD_READ_ALOUD}`).not.toMatch(/\b(loan|lender|ROI|interest)\b/i);
  });
});

describe('answerShape and answerRowsForCall', () => {
  const base = { aware_30m: 'knew', aware_merchant_codes: null, landlord_consent: null, aware_payout_otp: null, explained: 'yes' };

  it('a call that was not answered has no answers', () => {
    const c = { ...base, subject_type: 'landlord' as const, call_result: 'no_answer' as const, aware_30m: null, explained: null };
    expect(answerShape(c)).toBe('none');
    expect(answerRowsForCall(c)).toEqual([]);
    expect(answersLine(c)).toBe('—');
  });

  it('tenant and agent calls read the three original questions', () => {
    for (const subject_type of ['tenant', 'agent'] as const) {
      const rows = answerRowsForCall({ ...base, subject_type, call_result: 'answered', aware_merchant_codes: 'heard' });
      expect(rows.map((r) => [r.label, r.value])).toEqual([
        ['Knew about 30M access', 'Knew about it'], ['Knew about merchant-code self-payment', 'Heard but unsure'], ['Explained on the call', 'Yes, fully explained'],
      ]);
    }
  });

  it('a landlord call with the new questions reads consent and payment code, and flags "Does not consent"', () => {
    const rows = answerRowsForCall({ ...base, subject_type: 'landlord', call_result: 'answered', landlord_consent: 'refuses', aware_payout_otp: 'did_not_know' });
    expect(rows.map((r) => [r.label, r.value])).toEqual([
      ['Knew about 30M access', 'Knew about it'], ['Landlord consent', 'Does not consent'], ['Knew about payment code (OTP)', 'Did not know'], ['Explained on the call', 'Yes, fully explained'],
    ]);
    expect(rows.find((r) => r.key === 'consent')?.destructive).toBe(true);
    expect(rows.filter((r) => r.destructive)).toHaveLength(1);
  });

  it('an older landlord call reads "Old question" for self-payment and "Not asked" for the new questions', () => {
    const c = { ...base, subject_type: 'landlord' as const, call_result: 'answered' as const, aware_merchant_codes: 'knew' };
    expect(answerShape(c)).toBe('landlord_old');
    expect(answerRowsForCall(c).map((r) => [r.label, r.value])).toEqual([
      ['Knew about 30M access', 'Knew about it'], ['Knew about merchant-code self-payment', 'Old question'],
      ['Landlord consent', 'Not asked'], ['Knew about payment code (OTP)', 'Not asked'], ['Explained on the call', 'Yes, fully explained'],
    ]);
    expect(answersLine(c)).toContain('Old question');
  });
});
