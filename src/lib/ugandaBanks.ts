/**
 * Uganda Commercial Banks — for payout method selection
 */
export const UGANDA_BANKS = [
  'Absa Bank Uganda Limited',
  'Bank of Africa Uganda Limited',
  'Bank of Baroda Uganda Limited',
  'Bank of India (Uganda) Limited',
  'Cairo Bank Uganda Limited',
  'Centenary Rural Development Bank Limited (Centenary Bank)',
  'Citibank Uganda Limited',
  'DFCU Bank Limited',
  'Diamond Trust Bank Uganda Limited (DTB)',
  'Ecobank Uganda Limited',
  'Equity Bank Uganda Limited',
  'Exim Bank Uganda Limited',
  'Housing Finance Bank Uganda Limited',
  'I&M Bank (Uganda) Limited',
  'KCB Bank Uganda Limited',
  'NCBA Bank Uganda Limited',
  'Pearl Bank Uganda Limited',
  'Salaam Bank Uganda',
  'Stanbic Bank Uganda Limited',
  'Standard Chartered Bank Uganda Limited',
  'Tropical Bank Limited',
  'United Bank for Africa Uganda Limited (UBA)',
  'PostBank Uganda Limited',
] as const;

export const PAYOUT_METHODS = [
  { value: 'mobile_money', label: 'Mobile Money', icon: '📱' },
  { value: 'bank_transfer', label: 'Bank Transfer', icon: '🏦' },
  { value: 'cash', label: 'Cash Pickup', icon: '💵' },
] as const;

export type PayoutMethod = typeof PAYOUT_METHODS[number]['value'];
