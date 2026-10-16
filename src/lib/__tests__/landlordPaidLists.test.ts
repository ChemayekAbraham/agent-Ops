import { describe, expect, it } from 'vitest';
import { FUNDED_TAB_NOTE, PAID_LIST_HELP, PAID_LIST_LABEL, PAID_LIST_TABS, isPaidListTab, paidListErrorMessage } from '../landlordPaidLists';

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
