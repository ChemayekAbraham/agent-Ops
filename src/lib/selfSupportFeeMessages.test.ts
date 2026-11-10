import { describe, expect, it } from 'vitest';
import { afterColon, selfSupportFeeErrorMessage } from './selfSupportFeeMessages';

describe('Agent Care refusal messages', () => {
  it('shows the server text after the colon for a closed top-up window', () => {
    expect(selfSupportFeeErrorMessage('PSM_TOPUP_WINDOW_CLOSED: Self-support portfolios are not topped up.'))
      .toBe('Self-support portfolios are not topped up.');
  });
  it('shows the server text after the colon for company-managed notes', () => {
    expect(afterColon('ERROR: COMPANY_MANAGED_NOTES_CLOSED: Promissory notes are self-support only.', 'COMPANY_MANAGED_NOTES_CLOSED'))
      .toBe('Promissory notes are self-support only.');
  });
  it('maps PLANS_EXCEED_AMOUNT to the Agent Care wording', () => {
    expect(selfSupportFeeErrorMessage('PLANS_EXCEED_AMOUNT'))
      .toBe('The promised amount must cover the selected plans, Agent Care included.');
  });
  it('leaves other errors alone', () => {
    expect(selfSupportFeeErrorMessage('PARTNER_FUNDS_SHORT')).toBeNull();
  });
});
