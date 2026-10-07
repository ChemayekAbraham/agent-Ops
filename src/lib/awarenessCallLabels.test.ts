import { describe, it, expect } from 'vitest';
import {
  LABEL_30M_ACCESS, LABEL_SELF_PAYMENT, QUESTION_30M_ACCESS, QUESTION_EXPLAINED, QUESTION_SELF_PAYMENT,
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
