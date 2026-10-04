export const TOTAL_POOL_UGX = 500_000_000;
export const TOTAL_SHARES = 25_000;
export const PRICE_PER_SHARE = 20_000;
export const POOL_PERCENT = 8;

// UGX to USD rate: US$5 = UGX 20,000 (one share) → US$1 = UGX 4,000
export const UGX_PER_USD = 4_000;

export const VALUATIONS = [
  { label: '$1B', value: 1_000_000_000 },
  { label: '$3B', value: 3_000_000_000 },
  { label: '$5B', value: 5_000_000_000 },
] as const;

export type CurrencyView = 'UGX' | 'USD';

// Convert a UGX amount to the chosen display currency.
export const toDisplayAmount = (ugx: number, view: CurrencyView) =>
  view === 'USD' ? ugx / UGX_PER_USD : ugx;

// Format a UGX amount in the chosen currency (full, with symbol).
export const formatCurrency = (ugx: number, view: CurrencyView) => {
  const amt = toDisplayAmount(ugx, view);
  if (view === 'USD') {
    return `US$${amt.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  }
  return `UGX ${Math.round(amt).toLocaleString()}`;
};

// Format a UGX amount in the chosen currency (compact, with symbol).
export const formatCurrencyCompact = (ugx: number, view: CurrencyView) => {
  const amt = toDisplayAmount(ugx, view);
  const symbol = view === 'USD' ? 'US$' : 'UGX ';
  if (amt >= 1_000_000_000) return `${symbol}${(amt / 1_000_000_000).toFixed(1)}B`;
  if (amt >= 1_000_000) return `${symbol}${(amt / 1_000_000).toFixed(1)}M`;
  if (amt >= 1_000) return `${symbol}${(amt / 1_000).toFixed(1)}K`;
  return `${symbol}${amt.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
};
