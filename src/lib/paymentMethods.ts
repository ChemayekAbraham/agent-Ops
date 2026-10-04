import { PaymentMethod } from '@/components/payments/PaymentMethodCard';

export const LOCAL_PAYMENT_METHODS: PaymentMethod[] = [
  {
    id: 'mtn-momo',
    name: 'MTN Mobile Money',
    type: 'momo',
    region: 'local',
    fee: '1%',
    feeAmount: 0.01,
    eta: 'Instant',
  },
  {
    id: 'airtel-money',
    name: 'Airtel Money',
    type: 'airtel',
    region: 'local',
    fee: '1%',
    feeAmount: 0.01,
    eta: 'Instant',
  },
  {
    id: 'mpesa',
    name: 'M-Pesa',
    type: 'momo',
    region: 'local',
    fee: '1%',
    feeAmount: 0.01,
    eta: 'Instant',
  },
  {
    id: 'orange-money',
    name: 'Orange Money',
    type: 'momo',
    region: 'local',
    fee: '1%',
    feeAmount: 0.01,
    eta: 'Instant',
  },
  {
    id: 'wave',
    name: 'Wave',
    type: 'momo',
    region: 'local',
    fee: '1%',
    feeAmount: 0.01,
    eta: 'Instant',
  },
  {
    id: 'ecocash',
    name: 'EcoCash',
    type: 'momo',
    region: 'local',
    fee: '1%',
    feeAmount: 0.01,
    eta: 'Instant',
  },
  {
    id: 'vodacom-mpesa',
    name: 'Vodacom M-Pesa',
    type: 'momo',
    region: 'local',
    fee: '1%',
    feeAmount: 0.01,
    eta: 'Instant',
  },
  {
    id: 'tigo-pesa',
    name: 'Tigo Pesa',
    type: 'momo',
    region: 'local',
    fee: '1%',
    feeAmount: 0.01,
    eta: 'Instant',
  },
  {
    id: 'moov-money',
    name: 'Moov Money',
    type: 'momo',
    region: 'local',
    fee: '1%',
    feeAmount: 0.01,
    eta: 'Instant',
  },
  {
    id: 'telebirr',
    name: 'Telebirr',
    type: 'momo',
    region: 'local',
    fee: '1%',
    feeAmount: 0.01,
    eta: 'Instant',
  },
  {
    id: 'mtn-momo-gh',
    name: 'MTN MoMo Ghana',
    type: 'momo',
    region: 'local',
    fee: '1%',
    feeAmount: 0.01,
    eta: 'Instant',
  },
  {
    id: 'vodafone-cash',
    name: 'Vodafone Cash',
    type: 'momo',
    region: 'local',
    fee: '1%',
    feeAmount: 0.01,
    eta: 'Instant',
  },
  {
    id: 'opay',
    name: 'OPay',
    type: 'momo',
    region: 'local',
    fee: '1%',
    feeAmount: 0.01,
    eta: 'Instant',
  },
  {
    id: 'palmpay',
    name: 'PalmPay',
    type: 'momo',
    region: 'local',
    fee: '1%',
    feeAmount: 0.01,
    eta: 'Instant',
  },
  {
    id: 'flutterwave',
    name: 'Flutterwave',
    type: 'momo',
    region: 'local',
    fee: '1.5%',
    feeAmount: 0.015,
    eta: 'Instant',
  },
  {
    id: 'bank-transfer-local',
    name: 'Bank Transfer',
    type: 'bank',
    region: 'local',
    fee: '0.5%',
    feeAmount: 0.005,
    eta: '1-2 hours',
  },
  {
    id: 'welile-wallet',
    name: 'Welile Wallet',
    type: 'wallet',
    region: 'local',
    fee: 'Free',
    feeAmount: 0,
    eta: 'Instant',
  },
];

export const INTERNATIONAL_PAYMENT_METHODS: PaymentMethod[] = [
  {
    id: 'card-visa-mc',
    name: 'Visa / Mastercard',
    type: 'card',
    region: 'international',
    fee: '2.9%',
    feeAmount: 0.029,
    eta: 'Instant',
    currencies: ['USD', 'EUR', 'GBP'],
  },
  {
    id: 'bank-transfer-intl',
    name: 'International Bank Transfer',
    type: 'bank',
    region: 'international',
    fee: '1.5%',
    feeAmount: 0.015,
    eta: '2-5 days',
    currencies: ['USD', 'EUR', 'GBP'],
  },
  {
    id: 'mobile-money-africa',
    name: 'Mobile Money (Africa)',
    type: 'international',
    region: 'international',
    fee: '2%',
    feeAmount: 0.02,
    eta: '1-24 hours',
    currencies: ['KES', 'TZS', 'GHS', 'ZAR'],
  },
];

export const ALL_PAYMENT_METHODS = [...LOCAL_PAYMENT_METHODS, ...INTERNATIONAL_PAYMENT_METHODS];

export const CURRENCY_SYMBOLS: Record<string, string> = {
  UGX: 'UGX',
  USD: '$',
  EUR: '€',
  GBP: '£',
  KES: 'KES',
  TZS: 'TZS',
  GHS: 'GHS',
  ZAR: 'ZAR',
};

export const SUPPORTED_CURRENCIES = ['UGX', 'USD', 'EUR', 'GBP'];

import { formatDynamic } from '@/lib/currencyFormat';

export function formatCurrency(amount: number, _currency: string = 'UGX'): string {
  return formatDynamic(amount);
}

export function calculateFee(amount: number, method: PaymentMethod): number {
  if (!method.feeAmount) return 0;
  return Math.round(amount * method.feeAmount);
}
