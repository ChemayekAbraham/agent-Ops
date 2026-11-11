import { describe, it, expect } from 'vitest';
import {
  emptyTermDraft, isAgentEditable, missingForSubmit, parseAmount, partnershipDraftErrors, partnershipErrorMessage,
  planDueDate, termDraftErrors, termLengthDays, termToDraft,
  type FeeRow, type TermRow,
} from '@/lib/welileSchoolsPartnership';

const term = (over: Partial<TermRow> = {}): TermRow => ({
  id: 't1', school_id: 's1', name: 'Term 1 2027', start_date: '2027-02-02', end_date: '2027-04-30', plan_due_date: '2027-04-16', ...over,
});
const fee = (over: Partial<FeeRow> = {}): FeeRow => ({ id: 'f1', term_id: 't1', class_name: 'S1', boarding_status: 'day', amount: 850000, ...over });
const fullPartnership = {
  bursar_name: 'Jane', bursar_phone: '0772123456', payout_method: 'mobile_money' as const, payout_provider: 'MTN',
  payout_account_name: 'Migeera SS', payout_account_number: '0772123456', agreement_path: 's1/agreement.pdf',
};

describe('planDueDate', () => {
  it('is two weeks before the term ends (matches the database column)', () => {
    expect(planDueDate('2027-04-30')).toBe('2027-04-16');
    expect(planDueDate('2027-03-10')).toBe('2027-02-24');
  });
  it('returns null for a missing or malformed date', () => {
    expect(planDueDate('')).toBeNull();
    expect(planDueDate('30/04/2027')).toBeNull();
  });
});

describe('termLengthDays', () => {
  it('counts whole days', () => {
    expect(termLengthDays('2027-02-02', '2027-04-30')).toBe(87);
  });
});

describe('parseAmount', () => {
  it('accepts typed amounts with separators', () => {
    expect(parseAmount('1,450,000')).toBe(1450000);
    expect(parseAmount(' 850 000 ')).toBe(850000);
  });
  it('rejects zero, negatives, text and over the 50M cap', () => {
    expect(parseAmount('0')).toBeNull();
    expect(parseAmount('-5')).toBeNull();
    expect(parseAmount('abc')).toBeNull();
    expect(parseAmount('50000001')).toBeNull();
  });
});

describe('termDraftErrors', () => {
  it('passes a complete term', () => {
    expect(termDraftErrors({ id: null, name: 'Term 1', start_date: '2027-02-02', end_date: '2027-04-30', fees: [{ class_name: 'S1', boarding_status: 'day', amount: '850000' }] })).toEqual([]);
  });
  it('mirrors the database limits: 4 weeks minimum, 200 days maximum', () => {
    expect(termDraftErrors({ ...emptyTermDraft(), name: 'Short', start_date: '2027-02-02', end_date: '2027-02-20', fees: [{ class_name: 'S1', boarding_status: 'day', amount: '1' }] }))
      .toContain('A term must be at least 4 weeks long');
    expect(termDraftErrors({ ...emptyTermDraft(), name: 'Long', start_date: '2027-01-01', end_date: '2027-08-01', fees: [{ class_name: 'S1', boarding_status: 'day', amount: '1' }] }))
      .toContain('A term cannot be longer than 200 days');
  });
  it('flags a missing class, a bad amount and a duplicate class', () => {
    const errors = termDraftErrors({
      id: null, name: 'Term 1', start_date: '2027-02-02', end_date: '2027-04-30',
      fees: [
        { class_name: '', boarding_status: 'day', amount: '5' },
        { class_name: 'S1', boarding_status: 'day', amount: 'x' },
        { class_name: 's1', boarding_status: 'day', amount: '5' },
      ],
    });
    expect(errors).toContain('Fee 1: enter the class');
    expect(errors).toContain('S1: enter an amount above 0');
    expect(errors.some((e) => e.includes('listed twice'))).toBe(true);
  });
  it('allows the same class as day and as boarding', () => {
    expect(termDraftErrors({
      id: null, name: 'Term 1', start_date: '2027-02-02', end_date: '2027-04-30',
      fees: [{ class_name: 'S1', boarding_status: 'day', amount: '850000' }, { class_name: 'S1', boarding_status: 'boarding', amount: '1450000' }],
    })).toEqual([]);
  });
});

describe('partnershipDraftErrors', () => {
  it('checks the bursar and mobile money numbers', () => {
    const errors = partnershipDraftErrors({ bursar_name: 'Jane', bursar_phone: '123', payout_method: 'mobile_money', payout_provider: 'MTN', payout_account_name: 'X', payout_account_number: '12' });
    expect(errors.bursar_phone).toBeTruthy();
    expect(errors.payout_account_number).toBeTruthy();
  });
  it('does not check a bank account number as a phone number', () => {
    expect(partnershipDraftErrors({ bursar_name: '', bursar_phone: '', payout_method: 'bank', payout_provider: 'Stanbic', payout_account_name: 'X', payout_account_number: '9030012345678' })).toEqual({});
  });
});

describe('missingForSubmit', () => {
  it('is empty when everything ops needs is present', () => {
    expect(missingForSubmit(fullPartnership, [term()], [fee()], '2026-11-11')).toEqual([]);
  });
  it('lists every missing piece', () => {
    expect(missingForSubmit(null, [], [], '2026-11-11')).toEqual([
      'bursar contact', 'school payout account', 'signed partnership agreement', 'a current or upcoming term with fees',
    ]);
  });
  it('ignores a term that has ended or has no fees', () => {
    expect(missingForSubmit(fullPartnership, [term({ end_date: '2026-08-01' })], [fee()], '2026-11-11')).toEqual(['a current or upcoming term with fees']);
    expect(missingForSubmit(fullPartnership, [term()], [], '2026-11-11')).toEqual(['a current or upcoming term with fees']);
  });
});

describe('isAgentEditable', () => {
  it('lets the agent edit only a new, draft or sent-back partnership', () => {
    expect(isAgentEditable(null)).toBe(true);
    expect(isAgentEditable('draft')).toBe(true);
    expect(isAgentEditable('changes_requested')).toBe(true);
    expect(isAgentEditable('submitted')).toBe(false);
    expect(isAgentEditable('approved')).toBe(false);
  });
});

describe('termToDraft', () => {
  it('keeps only that term\'s fees, as whole shillings', () => {
    const draft = termToDraft(term(), [fee(), fee({ id: 'f2', term_id: 't2', class_name: 'S2' })]);
    expect(draft.fees).toEqual([{ class_name: 'S1', boarding_status: 'day', amount: '850000' }]);
  });
});

describe('partnershipErrorMessage', () => {
  it('turns database codes into plain words', () => {
    expect(partnershipErrorMessage({ message: 'PARTNERSHIP_LOCKED' })).toMatch(/locked/i);
    expect(partnershipErrorMessage({ message: 'Still missing: bursar contact' })).toBe('Still missing: bursar contact');
  });
});
