import React, { createContext, useContext, useState, useEffect, ReactNode, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';

export interface Currency {
  code: string;
  symbol: string;
  name: string;
  flag: string;
  locale: string;
  rate: number; // Exchange rate relative to UGX (base)
}

// Base currencies with default rates (will be updated with live rates)
const baseCurrencies: Omit<Currency, 'rate'>[] = [
  // Africa
  { code: 'UGX', symbol: 'UGX', name: 'Ugandan Shilling', flag: '🇺🇬', locale: 'en-UG' },
  { code: 'KES', symbol: 'KSh', name: 'Kenyan Shilling', flag: '🇰🇪', locale: 'en-KE' },
  { code: 'TZS', symbol: 'TSh', name: 'Tanzanian Shilling', flag: '🇹🇿', locale: 'sw-TZ' },
  { code: 'RWF', symbol: 'FRw', name: 'Rwandan Franc', flag: '🇷🇼', locale: 'rw-RW' },
  { code: 'ETB', symbol: 'Br', name: 'Ethiopian Birr', flag: '🇪🇹', locale: 'am-ET' },
  { code: 'NGN', symbol: '₦', name: 'Nigerian Naira', flag: '🇳🇬', locale: 'en-NG' },
  { code: 'GHS', symbol: 'GH₵', name: 'Ghanaian Cedi', flag: '🇬🇭', locale: 'en-GH' },
  { code: 'ZAR', symbol: 'R', name: 'South African Rand', flag: '🇿🇦', locale: 'en-ZA' },
  { code: 'EGP', symbol: 'E£', name: 'Egyptian Pound', flag: '🇪🇬', locale: 'ar-EG' },
  { code: 'MAD', symbol: 'DH', name: 'Moroccan Dirham', flag: '🇲🇦', locale: 'ar-MA' },
  { code: 'XOF', symbol: 'CFA', name: 'West African CFA Franc', flag: '🇸🇳', locale: 'fr-SN' },
  { code: 'XAF', symbol: 'FCFA', name: 'Central African CFA Franc', flag: '🇨🇲', locale: 'fr-CM' },
  
  // Americas
  { code: 'USD', symbol: '$', name: 'US Dollar', flag: '🇺🇸', locale: 'en-US' },
  { code: 'CAD', symbol: 'C$', name: 'Canadian Dollar', flag: '🇨🇦', locale: 'en-CA' },
  { code: 'MXN', symbol: 'MX$', name: 'Mexican Peso', flag: '🇲🇽', locale: 'es-MX' },
  { code: 'BRL', symbol: 'R$', name: 'Brazilian Real', flag: '🇧🇷', locale: 'pt-BR' },
  { code: 'ARS', symbol: 'AR$', name: 'Argentine Peso', flag: '🇦🇷', locale: 'es-AR' },
  { code: 'COP', symbol: 'CO$', name: 'Colombian Peso', flag: '🇨🇴', locale: 'es-CO' },
  
  // Europe
  { code: 'EUR', symbol: '€', name: 'Euro', flag: '🇪🇺', locale: 'de-DE' },
  { code: 'GBP', symbol: '£', name: 'British Pound', flag: '🇬🇧', locale: 'en-GB' },
  { code: 'CHF', symbol: 'Fr', name: 'Swiss Franc', flag: '🇨🇭', locale: 'de-CH' },
  { code: 'SEK', symbol: 'kr', name: 'Swedish Krona', flag: '🇸🇪', locale: 'sv-SE' },
  { code: 'NOK', symbol: 'kr', name: 'Norwegian Krone', flag: '🇳🇴', locale: 'nb-NO' },
  { code: 'PLN', symbol: 'zł', name: 'Polish Zloty', flag: '🇵🇱', locale: 'pl-PL' },
  { code: 'TRY', symbol: '₺', name: 'Turkish Lira', flag: '🇹🇷', locale: 'tr-TR' },
  { code: 'RUB', symbol: '₽', name: 'Russian Ruble', flag: '🇷🇺', locale: 'ru-RU' },
  { code: 'UAH', symbol: '₴', name: 'Ukrainian Hryvnia', flag: '🇺🇦', locale: 'uk-UA' },
  
  // Asia
  { code: 'CNY', symbol: '¥', name: 'Chinese Yuan', flag: '🇨🇳', locale: 'zh-CN' },
  { code: 'JPY', symbol: '¥', name: 'Japanese Yen', flag: '🇯🇵', locale: 'ja-JP' },
  { code: 'INR', symbol: '₹', name: 'Indian Rupee', flag: '🇮🇳', locale: 'hi-IN' },
  { code: 'PKR', symbol: '₨', name: 'Pakistani Rupee', flag: '🇵🇰', locale: 'ur-PK' },
  { code: 'BDT', symbol: '৳', name: 'Bangladeshi Taka', flag: '🇧🇩', locale: 'bn-BD' },
  { code: 'IDR', symbol: 'Rp', name: 'Indonesian Rupiah', flag: '🇮🇩', locale: 'id-ID' },
  { code: 'MYR', symbol: 'RM', name: 'Malaysian Ringgit', flag: '🇲🇾', locale: 'ms-MY' },
  { code: 'PHP', symbol: '₱', name: 'Philippine Peso', flag: '🇵🇭', locale: 'fil-PH' },
  { code: 'THB', symbol: '฿', name: 'Thai Baht', flag: '🇹🇭', locale: 'th-TH' },
  { code: 'VND', symbol: '₫', name: 'Vietnamese Dong', flag: '🇻🇳', locale: 'vi-VN' },
  { code: 'KRW', symbol: '₩', name: 'South Korean Won', flag: '🇰🇷', locale: 'ko-KR' },
  { code: 'SGD', symbol: 'S$', name: 'Singapore Dollar', flag: '🇸🇬', locale: 'en-SG' },
  { code: 'HKD', symbol: 'HK$', name: 'Hong Kong Dollar', flag: '🇭🇰', locale: 'zh-HK' },
  { code: 'TWD', symbol: 'NT$', name: 'Taiwan Dollar', flag: '🇹🇼', locale: 'zh-TW' },
  
  // Middle East
  { code: 'AED', symbol: 'د.إ', name: 'UAE Dirham', flag: '🇦🇪', locale: 'ar-AE' },
  { code: 'SAR', symbol: '﷼', name: 'Saudi Riyal', flag: '🇸🇦', locale: 'ar-SA' },
  { code: 'ILS', symbol: '₪', name: 'Israeli Shekel', flag: '🇮🇱', locale: 'he-IL' },
  { code: 'QAR', symbol: 'ر.ق', name: 'Qatari Riyal', flag: '🇶🇦', locale: 'ar-QA' },
  { code: 'KWD', symbol: 'د.ك', name: 'Kuwaiti Dinar', flag: '🇰🇼', locale: 'ar-KW' },
  
  // Oceania
  { code: 'AUD', symbol: 'A$', name: 'Australian Dollar', flag: '🇦🇺', locale: 'en-AU' },
  { code: 'NZD', symbol: 'NZ$', name: 'New Zealand Dollar', flag: '🇳🇿', locale: 'en-NZ' },
];

// Fallback rates (used when API is unavailable)
const fallbackRates: Record<string, number> = {
  UGX: 1, KES: 0.029, TZS: 0.69, RWF: 0.35, ETB: 0.015, NGN: 0.42, GHS: 0.0035,
  ZAR: 0.0048, EGP: 0.013, MAD: 0.0027, XOF: 0.16, XAF: 0.16, USD: 1 / 3650,
  CAD: 0.00037, MXN: 0.0046, BRL: 0.0013, ARS: 0.24, COP: 1.1, EUR: 0.00025,
  GBP: 0.00021, CHF: 0.00024, SEK: 0.0028, NOK: 0.0029, PLN: 0.0011, TRY: 0.0092,
  RUB: 0.024, UAH: 0.011, CNY: 0.0019, JPY: 0.041, INR: 0.023, PKR: 0.075,
  BDT: 0.029, IDR: 4.3, MYR: 0.0012, PHP: 0.015, THB: 0.0094, VND: 6.6,
  KRW: 0.37, SGD: 0.00036, HKD: 0.0021, TWD: 0.0086, AED: 0.00099, SAR: 0.001,
  ILS: 0.001, QAR: 0.00098, KWD: 0.000083, AUD: 0.00041, NZD: 0.00045
};

// Initialize currencies with fallback rates
export let currencies: Currency[] = baseCurrencies.map(c => ({
  ...c,
  rate: fallbackRates[c.code] || 0.00027 // Default to USD rate if not found
}));

interface CurrencyContextType {
  currency: Currency;
  setCurrency: (currency: Currency) => void;
  formatAmount: (amountInUGX: number, showSymbol?: boolean) => string;
  formatAmountCompact: (amountInUGX: number) => string;
  convertFromUGX: (amountInUGX: number) => number;
  convertToUGX: (amount: number) => number;
  getCurrencyByCode: (code: string) => Currency | undefined;
  isLoadingRates: boolean;
  lastUpdated: Date | null;
  refreshRates: () => Promise<void>;
  usdRate: number; // Current USD to UGX rate
}

const CurrencyContext = createContext<CurrencyContextType | undefined>(undefined);

const STORAGE_KEY = 'welile-currency';
const PHONE_CURRENCY_SET_KEY = 'welile-phone-currency-set';

// Map phone prefixes to currency codes
const phonePrefixToCurrency: Record<string, string> = {
  '+256': 'UGX', // Uganda
  '+254': 'KES', // Kenya
  '+255': 'TZS', // Tanzania
  '+250': 'RWF', // Rwanda
  '+251': 'ETB', // Ethiopia
  '+234': 'NGN', // Nigeria
  '+233': 'GHS', // Ghana
  '+27': 'ZAR',  // South Africa
};

// Detect currency based on browser locale/timezone
const detectUserCurrency = (): Currency => {
  if (typeof navigator === 'undefined') return currencies[0]; // UGX
  
  try {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const locale = navigator.language;
    
    // Map timezones/locales to currencies
    const timezoneMap: Record<string, string> = {
      'Africa/Kampala': 'UGX',
      'Africa/Nairobi': 'KES',
      'Africa/Dar_es_Salaam': 'TZS',
      'Africa/Kigali': 'RWF',
      'Africa/Addis_Ababa': 'ETB',
      'Africa/Lagos': 'NGN',
      'Africa/Accra': 'GHS',
      'Africa/Johannesburg': 'ZAR',
      'Africa/Cairo': 'EGP',
      'Africa/Casablanca': 'MAD',
      'America/New_York': 'USD',
      'America/Los_Angeles': 'USD',
      'America/Chicago': 'USD',
      'America/Toronto': 'CAD',
      'America/Mexico_City': 'MXN',
      'America/Sao_Paulo': 'BRL',
      'Europe/London': 'GBP',
      'Europe/Paris': 'EUR',
      'Europe/Berlin': 'EUR',
      'Europe/Rome': 'EUR',
      'Europe/Madrid': 'EUR',
      'Europe/Amsterdam': 'EUR',
      'Europe/Zurich': 'CHF',
      'Europe/Stockholm': 'SEK',
      'Europe/Oslo': 'NOK',
      'Europe/Warsaw': 'PLN',
      'Europe/Istanbul': 'TRY',
      'Europe/Moscow': 'RUB',
      'Europe/Kiev': 'UAH',
      'Asia/Shanghai': 'CNY',
      'Asia/Tokyo': 'JPY',
      'Asia/Kolkata': 'INR',
      'Asia/Karachi': 'PKR',
      'Asia/Dhaka': 'BDT',
      'Asia/Jakarta': 'IDR',
      'Asia/Kuala_Lumpur': 'MYR',
      'Asia/Manila': 'PHP',
      'Asia/Bangkok': 'THB',
      'Asia/Ho_Chi_Minh': 'VND',
      'Asia/Seoul': 'KRW',
      'Asia/Singapore': 'SGD',
      'Asia/Hong_Kong': 'HKD',
      'Asia/Taipei': 'TWD',
      'Asia/Dubai': 'AED',
      'Asia/Riyadh': 'SAR',
      'Asia/Jerusalem': 'ILS',
      'Australia/Sydney': 'AUD',
      'Pacific/Auckland': 'NZD',
    };
    
    const detectedCode = timezoneMap[timezone];
    if (detectedCode) {
      const currency = currencies.find(c => c.code === detectedCode);
      if (currency) return currency;
    }
    
    // Fallback to locale-based detection
    const localeCountry = locale.split('-')[1]?.toUpperCase();
    const localeMap: Record<string, string> = {
      'UG': 'UGX', 'KE': 'KES', 'TZ': 'TZS', 'RW': 'RWF', 'ET': 'ETB',
      'NG': 'NGN', 'GH': 'GHS', 'ZA': 'ZAR', 'EG': 'EGP', 'MA': 'MAD',
      'US': 'USD', 'CA': 'CAD', 'MX': 'MXN', 'BR': 'BRL', 'AR': 'ARS',
      'GB': 'GBP', 'DE': 'EUR', 'FR': 'EUR', 'IT': 'EUR', 'ES': 'EUR',
      'CH': 'CHF', 'SE': 'SEK', 'NO': 'NOK', 'PL': 'PLN', 'TR': 'TRY',
      'RU': 'RUB', 'UA': 'UAH', 'CN': 'CNY', 'JP': 'JPY', 'IN': 'INR',
      'PK': 'PKR', 'BD': 'BDT', 'ID': 'IDR', 'MY': 'MYR', 'PH': 'PHP',
      'TH': 'THB', 'VN': 'VND', 'KR': 'KRW', 'SG': 'SGD', 'HK': 'HKD',
      'TW': 'TWD', 'AE': 'AED', 'SA': 'SAR', 'IL': 'ILS', 'AU': 'AUD',
      'NZ': 'NZD',
    };
    
    const localeCode = localeMap[localeCountry];
    if (localeCode) {
      const currency = currencies.find(c => c.code === localeCode);
      if (currency) return currency;
    }
  } catch {
    // Ignore errors
  }
  
  return currencies[0]; // Default to UGX
};

export const CurrencyProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [currency, setCurrencyState] = useState<Currency>(() => {
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const found = currencies.find(c => c.code === stored);
        if (found) return found;
      }
    }
    return detectUserCurrency();
  });
  const [liveRates, setLiveRates] = useState<Record<string, number>>(fallbackRates);
  const [isLoadingRates, setIsLoadingRates] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  // Fetch real-time exchange rates — single attempt, no retry, no dependency on currency
  const fetchLiveRates = useCallback(async () => {
    setIsLoadingRates(true);
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);

      const response = await fetch('https://api.exchangerate-api.com/v4/latest/USD', {
        signal: controller.signal,
        mode: 'cors',
      });
      clearTimeout(timeout);

      if (!response.ok) throw new Error('Failed to fetch rates');

      const data = await response.json();
      const usdRates = data.rates as Record<string, number>;
      const ugxPerUsd = usdRates.UGX || 3700;

      const newRates: Record<string, number> = { UGX: 1 };
      Object.entries(usdRates).forEach(([code, rateVsUsd]) => {
        newRates[code] = (rateVsUsd as number) / ugxPerUsd;
      });

      // Pin USD to the agreed fixed rate: 1 USD = UGX 3,650
      newRates.USD = 1 / 3650;

      setLiveRates(newRates);
      setLastUpdated(new Date());

      currencies = baseCurrencies.map(c => ({
        ...c,
        rate: newRates[c.code] || fallbackRates[c.code] || 0.00027
      }));

      localStorage.setItem('welile-live-rates', JSON.stringify({
        rates: newRates,
        timestamp: Date.now()
      }));
    } catch (error) {
      // Silently use cached or fallback rates — do NOT log repeatedly
      try {
        const cached = localStorage.getItem('welile-live-rates');
        if (cached) {
          const { rates, timestamp } = JSON.parse(cached);
          setLiveRates({ ...rates, USD: 1 / 3650 });
          setLastUpdated(new Date(timestamp));
        }
      } catch {
        // Use fallback rates — already set as default
      }
    } finally {
      setIsLoadingRates(false);
    }
  }, []); // No dependencies — rates are currency-agnostic

  // Refresh rates function for manual refresh
  const refreshRates = useCallback(async () => {
    await fetchLiveRates();
  }, [fetchLiveRates]);

  // Fetch rates on mount — ONE TIME ONLY, stable dependency
  useEffect(() => {
    // Check if we have recent cached rates (less than 30 days old)
    const cached = localStorage.getItem('welile-live-rates');
    if (cached) {
      try {
        const { rates, timestamp } = JSON.parse(cached);
        const age = Date.now() - timestamp;
        if (age < 30 * 24 * 60 * 60 * 1000) {
          setLiveRates({ ...rates, USD: 1 / 3650 });
          setLastUpdated(new Date(timestamp));
          currencies = baseCurrencies.map(c => ({
            ...c,
            rate: rates[c.code] || fallbackRates[c.code] || 0.00027
          }));
          return; // Rates are fresh enough, skip fetch
        }
      } catch {
        // Continue to fetch
      }
    }
    
    // DEFER initial fetch to after first paint
    const scheduleId = 'requestIdleCallback' in window
      ? (window as any).requestIdleCallback(() => fetchLiveRates(), { timeout: 5000 })
      : setTimeout(() => fetchLiveRates(), 3000);
    
    return () => {
      if ('requestIdleCallback' in window) {
        (window as any).cancelIdleCallback(scheduleId);
      } else {
        clearTimeout(scheduleId);
      }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-set currency based on user's phone number after login.
  // 🇺🇬 RULE: Any user with a Ugandan phone (+256) is ALWAYS shown UGX,
  // overriding browser timezone, locale, or any previously stored preference.
  useEffect(() => {
    const checkPhoneCurrency = async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.user?.id) return;

      const { data: profile } = await supabase
        .from('profiles')
        .select('phone')
        .eq('id', session.user.id)
        .maybeSingle();

      if (!profile?.phone) return;

      const phone = profile.phone.replace(/\s/g, '');
      const normalizedPhone = phone.startsWith('0') ? '+256' + phone.slice(1) : phone;

      // Force UGX for Ugandan users — non-negotiable
      if (normalizedPhone.startsWith('+256')) {
        const ugx = currencies.find(c => c.code === 'UGX');
        if (ugx) setCurrency(ugx);
        localStorage.setItem(PHONE_CURRENCY_SET_KEY, 'true');
        return;
      }

      // Other countries: only auto-set on first login (don't override user choice)
      if (localStorage.getItem(PHONE_CURRENCY_SET_KEY)) return;

      for (const [prefix, code] of Object.entries(phonePrefixToCurrency)) {
        if (normalizedPhone.startsWith(prefix)) {
          if (!localStorage.getItem(STORAGE_KEY)) {
            const matchedCurrency = currencies.find(c => c.code === code);
            if (matchedCurrency) setCurrency(matchedCurrency);
          }
          localStorage.setItem(PHONE_CURRENCY_SET_KEY, 'true');
          return;
        }
      }
      localStorage.setItem(PHONE_CURRENCY_SET_KEY, 'true');
    };

    checkPhoneCurrency();
  }, []);

  const setCurrency = (newCurrency: Currency) => {
    // Get the currency with live rate
    const currencyWithLiveRate = {
      ...newCurrency,
      rate: liveRates[newCurrency.code] || newCurrency.rate
    };
    setCurrencyState(currencyWithLiveRate);
    localStorage.setItem(STORAGE_KEY, newCurrency.code);
  };

  const convertFromUGX = (amountInUGX: number): number => {
    const rate = liveRates[currency.code] || currency.rate;
    return amountInUGX * rate;
  };

  const convertToUGX = (amount: number): number => {
    const rate = liveRates[currency.code] || currency.rate;
    return amount / rate;
  };

  const formatAmount = (amountInUGX: number, showSymbol = true): string => {
    const converted = convertFromUGX(amountInUGX);
    
    try {
      const formatted = new Intl.NumberFormat(currency.locale, {
        style: showSymbol ? 'currency' : 'decimal',
        currency: currency.code,
        currencyDisplay: currency.code === 'UGX' ? 'code' : 'symbol',
        minimumFractionDigits: currency.code === 'UGX' || currency.code === 'JPY' || currency.code === 'KRW' ? 0 : 2,
        maximumFractionDigits: currency.code === 'UGX' || currency.code === 'JPY' || currency.code === 'KRW' ? 0 : 2,
      }).format(converted);
      return formatted;
    } catch {
      return `${currency.symbol}${converted.toFixed(2)}`;
    }
  };

  const formatAmountCompact = (amountInUGX: number): string => {
    const converted = convertFromUGX(amountInUGX);
    
    if (converted >= 1000000000) {
      return `${currency.symbol}${(converted / 1000000000).toFixed(1)}B`;
    }
    if (converted >= 1000000) {
      return `${currency.symbol}${(converted / 1000000).toFixed(2)}M`;
    }
    if (converted >= 1000) {
      return `${currency.symbol}${(converted / 1000).toFixed(0)}K`;
    }
    return `${currency.symbol}${converted.toFixed(0)}`;
  };

  const getCurrencyByCode = (code: string): Currency | undefined => {
    const baseCurrency = currencies.find(c => c.code === code);
    if (baseCurrency) {
      return {
        ...baseCurrency,
        rate: liveRates[code] || baseCurrency.rate
      };
    }
    return undefined;
  };

  // Get USD rate for display (1 USD = X UGX)
  const usdRate = liveRates.USD ? 1 / liveRates.USD : 3650;

  const value: CurrencyContextType = {
    currency: {
      ...currency,
      rate: liveRates[currency.code] || currency.rate
    },
    setCurrency,
    formatAmount,
    formatAmountCompact,
    convertFromUGX,
    convertToUGX,
    getCurrencyByCode,
    isLoadingRates,
    lastUpdated,
    refreshRates,
    usdRate,
  };

  return (
    <CurrencyContext.Provider value={value}>
      {children}
    </CurrencyContext.Provider>
  );
};

export const useCurrency = (): CurrencyContextType => {
  const context = useContext(CurrencyContext);
  if (!context) {
    throw new Error('useCurrency must be used within a CurrencyProvider');
  }
  return context;
};
