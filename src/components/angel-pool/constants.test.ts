import { describe, it, expect } from 'vitest';
import {
  UGX_PER_USD,
  PRICE_PER_SHARE,
  toDisplayAmount,
  formatCurrency,
  formatCurrencyCompact,
} from './constants';

// The single source of truth for the angel pool: US$5 = UGX 20,000.
const USD_PER_SHARE = 5;

describe('angel pool USD ↔ UGX conversion', () => {
  it('locks the rate at UGX 4,000 per US$1', () => {
    expect(UGX_PER_USD).toBe(4_000);
  });

  it('prices one share at UGX 20,000', () => {
    expect(PRICE_PER_SHARE).toBe(20_000);
  });

  it('maps US$5 to exactly UGX 20,000 (one share)', () => {
    expect(USD_PER_SHARE * UGX_PER_USD).toBe(20_000);
    expect(USD_PER_SHARE * UGX_PER_USD).toBe(PRICE_PER_SHARE);
  });

  it('converts UGX 20,000 back to US$5', () => {
    expect(PRICE_PER_SHARE / UGX_PER_USD).toBe(USD_PER_SHARE);
    expect(toDisplayAmount(PRICE_PER_SHARE, 'USD')).toBe(5);
  });

  it('toDisplayAmount keeps UGX unchanged and divides for USD', () => {
    expect(toDisplayAmount(20_000, 'UGX')).toBe(20_000);
    expect(toDisplayAmount(20_000, 'USD')).toBe(5);
    expect(toDisplayAmount(1_000_000, 'USD')).toBe(250);
  });

  it('round-trips any UGX amount through USD without loss', () => {
    for (const ugx of [20_000, 100_000, 1_000_000, 500_000_000]) {
      const usd = toDisplayAmount(ugx, 'USD');
      expect(usd * UGX_PER_USD).toBe(ugx);
    }
  });
});

describe('angel pool currency formatting', () => {
  it('formats one share consistently in both currencies', () => {
    expect(formatCurrency(20_000, 'UGX')).toBe('UGX 20,000');
    expect(formatCurrency(20_000, 'USD')).toBe('US$5');
  });

  it('formats compact values for both currencies', () => {
    expect(formatCurrencyCompact(20_000, 'UGX')).toBe('UGX 20.0K');
    expect(formatCurrencyCompact(20_000, 'USD')).toBe('US$5');
    // US$5 valuation example: 0.01% of $5B = $500,000 = UGX 2,000,000,000
    expect(formatCurrencyCompact(2_000_000_000, 'USD')).toBe('US$500.0K');
    expect(formatCurrencyCompact(2_000_000_000, 'UGX')).toBe('UGX 2.0B');
  });
});

// Guards the exact arithmetic every UI component uses for future-value estimates:
// (companyOwnership%) * valuationUSD * UGX_PER_USD. This is duplicated inline across
// AngelCalculator, CapitalOpportunityEntry, FunderCapitalOpportunities and useMyAngelShares,
// so this test pins the shared rate they all multiply by.
describe('angel pool future-value estimate uses the locked rate', () => {
  it('computes UGX future value from a USD valuation via UGX_PER_USD', () => {
    const companyOwnershipPct = 0.01; // 0.01%
    const valuationUsd = 5_000_000_000; // $5B
    const futureValUgx = (companyOwnershipPct / 100) * valuationUsd * UGX_PER_USD;
    // 0.0001 * 5,000,000,000 = 500,000 USD → * 4,000 = 2,000,000,000 UGX
    expect(futureValUgx).toBe(2_000_000_000);
    // Equivalent in USD must reflect US$5 = UGX 20,000.
    expect(toDisplayAmount(futureValUgx, 'USD')).toBe(500_000);
  });
});