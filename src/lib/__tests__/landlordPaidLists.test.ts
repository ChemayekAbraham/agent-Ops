import { describe, expect, it } from 'vitest';
import { FUNDED_TAB_NOTE, PAID_LIST_HELP, PAID_LIST_LABEL, PAID_LIST_TABS, isPaidListTab, paidListErrorMessage, matchesPaidVerification, type PaidListRow } from '../landlordPaidLists';

describe('Paid & Repaying verification filters', () => {
  const state = (verified: boolean | null, verification_status: string | null) => ({ verified, verification_status } as PaidListRow);
  it('not verified includes pending, rejected and resubmitted but excludes verified', () => {
    for (const status of ['pending', 'rejected', 'resubmitted', null]) expect(matchesPaidVerification(state(false, status), 'not_verified')).toBe(true);
    expect(matchesPaidVerification(state(true, 'verified'), 'not_verified')).toBe(false);
    expect(matchesPaidVerification(state(false, 'verified'), 'not_verified')).toBe(false);
  });
  it('rejected includes only rejected records', () => {
    expect(matchesPaidVerification(state(false, 'rejected'), 'rejected')).toBe(true);
    for (const status of ['pending', 'verified', 'resubmitted', null]) expect(matchesPaidVerification(state(false, status), 'rejected')).toBe(false);
  });
  it('all keeps every verification state', () => {
    for (const status of ['pending', 'verified', 'rejected', null]) expect(matchesPaidVerification(state(false, status), 'all')).toBe(true);
  });
});

describe('landlord paid list tabs', () => {
  it('has the two tabs, labelled as asked, each with a one-line explanation', () => {
    expect(PAID_LIST_TABS).toEqual(['paid_repaying', 'completed']);
    expect(PAID_LIST_LABEL).toEqual({ paid_repaying: 'Paid & Repaying', completed: 'Completed' });
    expect(PAID_LIST_HELP.paid_repaying).toMatch(/received money.*repaying/);
    expect(PAID_LIST_HELP.completed).toMatch(/paid off fully.*no active Rent Plan/);
  });
  it('recognises only the two new tabs, never an existing one', () => {
    expect(isPaidListTab('paid_repaying')).toBe(true);
    expect(isPaidListTab('completed')).toBe(true);
    for (const existing of ['all', 'verified', 'pending', 'rejected', 'resubmitted', 'funded', 'has_tenants', 'no_tenants', '', null, undefined]) expect(isPaidListTab(existing as string)).toBe(false);
  });
  it('words the Funded note exactly', () => {
    expect(FUNDED_TAB_NOTE).toBe('Money is with the agent, not yet paid to the landlord');
  });
  it('explains a failed load, and uses no banned words', () => {
    expect(paidListErrorMessage(new Error('NOT_AUTHORISED: x'))).toMatch(/don't have access/);
    expect(paidListErrorMessage(new Error('boom'))).toMatch(/couldn't load/);
    expect(`${Object.values(PAID_LIST_HELP).join(' ')} ${paidListErrorMessage('x')}`).not.toMatch(/\b(loan|lender|interest|ROI)\b/i);
  });
});
