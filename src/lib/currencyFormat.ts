/**
 * Standalone (non-React) currency formatting utility.
 * Reads the user's selected currency and cached exchange rates from localStorage
 * so that non-hook code (PDF generators, utility files, etc.) can format
 * amounts in the user's chosen currency.
 *
 * All amounts passed in are assumed to be denominated in UGX (the base currency).
 */

const STORAGE_KEY = 'welile-currency';
const RATES_KEY = 'welile-live-rates';

// Must stay in sync with src/hooks/useCurrency.tsx fallbackRates
const fallbackRates: Record<string, number> = {
  UGX: 1, KES: 0.029, TZS: 0.69, RWF: 0.35, ETB: 0.015, NGN: 0.42, GHS: 0.0035,
  ZAR: 0.0048, EGP: 0.013, MAD: 0.0027, XOF: 0.16, XAF: 0.16, USD: 1 / 3650,
  CAD: 0.00037, MXN: 0.0046, BRL: 0.0013, ARS: 0.24, COP: 1.1, EUR: 0.00025,
  GBP: 0.00021, CHF: 0.00024, SEK: 0.0028, NOK: 0.0029, PLN: 0.0011, TRY: 0.0092,
  RUB: 0.024, UAH: 0.011, CNY: 0.0019, JPY: 0.041, INR: 0.023, PKR: 0.075,
  BDT: 0.029, IDR: 4.3, MYR: 0.0012, PHP: 0.015, THB: 0.0094, VND: 6.6,
  KRW: 0.37, SGD: 0.00036, HKD: 0.0021, TWD: 0.0086, AED: 0.00099, SAR: 0.001,
  ILS: 0.001, QAR: 0.00098, KWD: 0.000083, AUD: 0.00041, NZD: 0.00045,
};

const currencyLocales: Record<string, string> = {
  UGX: 'en-UG', KES: 'en-KE', TZS: 'sw-TZ', RWF: 'rw-RW', ETB: 'am-ET',
  NGN: 'en-NG', GHS: 'en-GH', ZAR: 'en-ZA', EGP: 'ar-EG', MAD: 'ar-MA',
  XOF: 'fr-SN', XAF: 'fr-CM', USD: 'en-US', CAD: 'en-CA', MXN: 'es-MX',
  BRL: 'pt-BR', ARS: 'es-AR', COP: 'es-CO', EUR: 'de-DE', GBP: 'en-GB',
  CHF: 'de-CH', SEK: 'sv-SE', NOK: 'nb-NO', PLN: 'pl-PL', TRY: 'tr-TR',
  RUB: 'ru-RU', UAH: 'uk-UA', CNY: 'zh-CN', JPY: 'ja-JP', INR: 'hi-IN',
  PKR: 'ur-PK', BDT: 'bn-BD', IDR: 'id-ID', MYR: 'ms-MY', PHP: 'fil-PH',
  THB: 'th-TH', VND: 'vi-VN', KRW: 'ko-KR', SGD: 'en-SG', HKD: 'zh-HK',
  TWD: 'zh-TW', AED: 'ar-AE', SAR: 'ar-SA', ILS: 'he-IL', QAR: 'ar-QA',
  KWD: 'ar-KW', AUD: 'en-AU', NZD: 'en-NZ',
};

const currencySymbols: Record<string, string> = {
  UGX: 'UGX', KES: 'KSh', TZS: 'TSh', RWF: 'FRw', ETB: 'Br', NGN: '₦',
  GHS: 'GH₵', ZAR: 'R', USD: '$', CAD: 'C$', EUR: '€', GBP: '£',
  CHF: 'Fr', JPY: '¥', CNY: '¥', INR: '₹', AUD: 'A$', NZD: 'NZ$',
  SGD: 'S$', HKD: 'HK$', KRW: '₩', PHP: '₱', THB: '฿', VND: '₫',
  IDR: 'Rp', MYR: 'RM', BRL: 'R$', TRY: '₺', RUB: '₽', UAH: '₴',
  PLN: 'zł', SEK: 'kr', NOK: 'kr', AED: 'د.إ', SAR: '﷼', ILS: '₪',
};

const ZERO_DECIMAL_CURRENCIES = new Set(['UGX', 'JPY', 'KRW', 'VND', 'IDR', 'RWF', 'TZS', 'XOF', 'XAF']);

function getSelectedCode(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) || 'UGX';
  } catch {
    return 'UGX';
  }
}

function getRates(): Record<string, number> {
  try {
    const cached = localStorage.getItem(RATES_KEY);
    if (cached) {
      const { rates } = JSON.parse(cached);
      if (rates && typeof rates === 'object') return rates;
    }
  } catch {
    // ignore
  }
  return fallbackRates;
}

function convert(amountInUGX: number, code: string, rates: Record<string, number>): number {
  const rate = rates[code] ?? fallbackRates[code] ?? 1;
  return amountInUGX * rate;
}

/**
 * Format an amount (in UGX) using the user's selected currency.
 */
export function formatDynamic(amountInUGX: unknown): string {
  const safeAmount = Number(amountInUGX);
  if (!Number.isFinite(safeAmount)) {
    return getDynamicCurrencySymbol() + '0';
  }
  const code = getSelectedCode();
  const rates = getRates();
  const converted = convert(safeAmount, code, rates);
  const locale = currencyLocales[code] || 'en-US';
  const decimals = ZERO_DECIMAL_CURRENCIES.has(code) ? 0 : 2;

  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: code,
      currencyDisplay: code === 'UGX' ? 'code' : 'symbol',
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(converted);
  } catch {
    const symbol = currencySymbols[code] || code;
    return `${symbol}${converted.toFixed(decimals)}`;
  }
}

/**
 * Compact format (K / M / B) using the user's selected currency.
 */
export function formatDynamicCompact(amountInUGX: unknown): string {
  const safeAmount = Number(amountInUGX);
  if (!Number.isFinite(safeAmount)) {
    return (currencySymbols[getSelectedCode()] || getSelectedCode()) + '0';
  }
  const code = getSelectedCode();
  const rates = getRates();
  const converted = convert(safeAmount, code, rates);
  const symbol = currencySymbols[code] || code + ' ';

  if (converted >= 1_000_000_000) return `${symbol}${(converted / 1_000_000_000).toFixed(1)}B`;
  if (converted >= 1_000_000) return `${symbol}${(converted / 1_000_000).toFixed(2)}M`;
  if (converted >= 1_000) return `${symbol}${(converted / 1_000).toFixed(0)}K`;
  return `${symbol}${converted.toFixed(0)}`;
}

/**
 * Returns the symbol for the currently selected currency.
 */
export function getDynamicCurrencySymbol(): string {
  const code = getSelectedCode();
  return currencySymbols[code] || code;
}

/**
 * Returns the currently selected currency code.
 */
export function getDynamicCurrencyCode(): string {
  return getSelectedCode();
}

const currencyNames: Record<string, string> = {
  UGX: 'Uganda Shillings', KES: 'Kenyan Shillings', TZS: 'Tanzanian Shillings', RWF: 'Rwandan Francs',
  ETB: 'Ethiopian Birr', NGN: 'Nigerian Naira', GHS: 'Ghanaian Cedis', ZAR: 'South African Rand',
  EGP: 'Egyptian Pounds', MAD: 'Moroccan Dirhams', XOF: 'West African CFA Francs', XAF: 'Central African CFA Francs',
  USD: 'US Dollars', CAD: 'Canadian Dollars', MXN: 'Mexican Pesos', BRL: 'Brazilian Reais',
  ARS: 'Argentine Pesos', COP: 'Colombian Pesos', EUR: 'Euros', GBP: 'British Pounds',
  CHF: 'Swiss Francs', SEK: 'Swedish Kronor', NOK: 'Norwegian Kroner', PLN: 'Polish Zloty',
  TRY: 'Turkish Lira', RUB: 'Russian Rubles', UAH: 'Ukrainian Hryvnia', CNY: 'Chinese Yuan',
  JPY: 'Japanese Yen', INR: 'Indian Rupees', PKR: 'Pakistani Rupees', BDT: 'Bangladeshi Taka',
  IDR: 'Indonesian Rupiah', MYR: 'Malaysian Ringgit', PHP: 'Philippine Pesos', THB: 'Thai Baht',
  VND: 'Vietnamese Dong', KRW: 'South Korean Won', SGD: 'Singapore Dollars', HKD: 'Hong Kong Dollars',
  TWD: 'New Taiwan Dollars', AED: 'UAE Dirhams', SAR: 'Saudi Riyals', ILS: 'Israeli Shekels',
  QAR: 'Qatari Riyals', KWD: 'Kuwaiti Dinars', AUD: 'Australian Dollars', NZD: 'New Zealand Dollars',
};

/**
 * Returns the full name of the currently selected currency.
 */
export function getDynamicCurrencyName(): string {
  const code = getSelectedCode();
  return currencyNames[code] || code;
}
