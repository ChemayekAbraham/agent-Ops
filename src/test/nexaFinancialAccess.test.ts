import { describe, expect, it } from 'vitest';
import { isFinancialAccessQuery, buildFinancialAccessFallbackReply, generateLocalNexaReply } from '@/lib/nexaSalesEngine';

describe('public financial access guidance', () => {
  it.each(['loans in Uganda', 'credit without collateral', 'daily micro-payments', 'mobile money vs digital wallets', 'passive returns', 'savings', 'supporter partnerships', 'BNPL smartphones', 'solar kits', 'electric motorbikes', 'business advances', 'agent advances', 'working capital', 'insurance', 'school fees', 'medical access', 'financial inclusion', 'budgeting', 'interest rates', 'Access financial products & services'])('detects %s', input => {
    expect(isFinancialAccessQuery(input)).toBe(true);
  });
  it.each(['hello', 'where is the headquarters?', 'How much did I collect today?'])('does not classify unrelated %s', input => {
    expect(isFinancialAccessQuery(input)).toBe(false);
  });
  it('uses the requested public programme figures without changing financial eligibility', () => {
    const reply = buildFinancialAccessFallbackReply('financial inclusion');
    expect(reply).toContain('+UGX 10,000/day up to UGX 30,000,000');
    expect(reply).toContain('UGX 7,000/day');
    expect(reply).toContain('UGX 100,000 → UGX 15,000/month');
    expect(reply).toContain('UGX 180,000 over 12 months');
    expect(reply).toContain('90-day withdrawal notice');
    expect(reply).toContain('MTN Merchant 090777');
    expect(reply).toContain('Airtel Merchant 4380664');
    expect(reply).toContain('not your current limit or a guarantee');
  });
  it('preserves sign-in destinations and does not ask signed-in users to create another account', () => {
    const signedOut = buildFinancialAccessFallbackReply('BNPL');
    expect(signedOut).toContain('/auth?redirect=%2Fregister-tenant');
    expect(signedOut).toContain('/auth?redirect=%2Fdashboard%2Ffunder-new');
    expect(signedOut).toContain('/auth?redirect=%2Fwallet');
    expect(signedOut).toContain('/auth?redirect=%2Fmarketplace');
    expect(signedOut).toContain('Continue to free signup');
    expect(buildFinancialAccessFallbackReply('BNPL', true)).toContain('[Explore Credit](/credit)');
    expect(buildFinancialAccessFallbackReply('BNPL', true)).not.toContain('Continue to free signup');
  });
  it('never bypasses private account guidance with a financial fallback', () => {
    expect(buildFinancialAccessFallbackReply('my portfolio balance')).toContain('private figures are only available');
    expect(buildFinancialAccessFallbackReply('0700000000')).toContain('does not verify ownership');
    expect(buildFinancialAccessFallbackReply('company treasury and credit')).toContain('cannot be shared publicly');
  });
  it('does not promise the unsupported UGX 100 referral, signup rewards or free bike', () => {
    const reply = buildFinancialAccessFallbackReply('financial access');
    expect(reply).not.toContain('UGX 100 referral bonus');
    expect(reply).not.toContain('UGX 500 signup bonus');
    expect(reply).not.toContain('free Electric Bike');
    expect(reply).not.toContain('zero-fee');
  });
  it('returns the comprehensive guide for an unknown local inquiry', () => {
    expect(generateLocalNexaReply('hello there')).toBe(buildFinancialAccessFallbackReply('hello there'));
  });
});