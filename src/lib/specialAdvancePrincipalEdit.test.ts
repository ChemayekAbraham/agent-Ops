import { describe, expect, it } from 'vitest';
import { canEditRecordedPrincipal, RECORDED_ADVANCE_MARKER } from './specialAdvances';
const base = { decision_reason: RECORDED_ADVANCE_MARKER, status: 'disbursed', repayments: [], topups: [] };
describe('Edit principal on Special Advances', () => {
  it('is allowed for a recorded already-issued advance with no repayment or top-up', () => {
    expect(canEditRecordedPrincipal(base)).toBe(true);
  });
  it('is refused for an advance issued through Welile', () => {
    expect(canEditRecordedPrincipal({ ...base, decision_reason: 'Approved' })).toBe(false);
  });
  it('is refused once a repayment is recorded', () => {
    expect(canEditRecordedPrincipal({ ...base, repayments: [{}] })).toBe(false);
  });
  it('is refused once a top-up is recorded', () => {
    expect(canEditRecordedPrincipal({ ...base, topups: [{}] })).toBe(false);
  });
});

import { isRecordedAdvance } from './specialAdvances';
describe('Edit name on Special Advances', () => {
  it('is offered for a recorded advance even after a repayment', () => {
    expect(isRecordedAdvance({ decision_reason: RECORDED_ADVANCE_MARKER })).toBe(true);
  });
  it('is not offered for an advance issued through Welile', () => {
    expect(isRecordedAdvance({ decision_reason: 'Approved' })).toBe(false);
  });
});
