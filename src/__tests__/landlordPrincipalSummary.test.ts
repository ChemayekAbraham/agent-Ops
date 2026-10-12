import { describe, expect, it } from 'vitest';
import { summarizePrincipalComponents } from '@/lib/landlordPrincipalSummary';

describe('landlord principal summary', () => {
  it('does not double count gross fees and their distribution', () => {
    const summary = summarizePrincipalComponents([{
      total_repayment: '1500', principal: '1000', returns: '200', agent_commission: '100',
      platform_fee: '200', access_fee: '400', registration_fee: '100',
    }]);
    expect(summary.platformMoney).toBe(500);
    expect(summary.accessFee + summary.registrationFee).toBe(500);
    expect(summary.returns + summary.commission + summary.platformFee).toBe(500);
    expect(summary.principal).toBe(1000);
  });
  it('handles legacy allocations without inventing a fee distribution', () => {
    const summary = summarizePrincipalComponents([{
      total_repayment: 1500, principal: 1000, returns: 0, agent_commission: 0,
      platform_fee: 0, access_fee: 400, registration_fee: 100,
    }]);
    expect(summary.platformMoney).toBe(500);
    expect(summary.platformFee).toBe(0);
  });
  it('returns zero totals for an empty period', () => {
    expect(summarizePrincipalComponents([]).platformMoney).toBe(0);
  });
});