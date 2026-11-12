import { describe, expect, it } from 'vitest';
import { canSelfPayLandlords } from './landlordSelfPayAgents';
describe('direct landlord payout without location', () => {
  it('only Alpha Ssema skips the location check', () => {
    expect(canSelfPayLandlords('9188db01-e54a-4f84-8de9-042e6b5b6bd6')).toBe(true);
    expect(canSelfPayLandlords('6a5abd4f-6527-45f9-b9fa-bdc489186b2c')).toBe(false);
  });
});
