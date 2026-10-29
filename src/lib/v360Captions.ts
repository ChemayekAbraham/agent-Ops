import { V360_MODEL_A_EXAMPLE } from '@/lib/contractEngine360';

/** Server figures from v360_plan_summary. The client only labels them. */
export interface V360CaptionSource {
  daily_rate: number | null;
  partner_monthly: number;
  partner_12_months: number;
  remaining_receivable: number;
  missed_days: number;
  vacant_days: number;
  maturity_on: string | null;
  buffer_drawn: number;
}

function ugx(value: number): string {
  return `UGX ${Math.round(value).toLocaleString('en-US')}`;
}

function asNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function v360CaptionLines(source: V360CaptionSource): { label: string; value: string }[] {
  const daily = source.daily_rate == null ? null : asNumber(source.daily_rate);
  return [
    { label: 'Daily rate', value: daily == null ? '—' : ugx(daily) },
    {
      label: 'Partner Returns 15%/mo × 12',
      value: `${ugx(asNumber(source.partner_monthly))} a month, ${ugx(asNumber(source.partner_12_months))} over 12 months`,
    },
    { label: 'Remaining 360-day receivable', value: ugx(asNumber(source.remaining_receivable)) },
    { label: 'Missed days', value: String(Math.round(asNumber(source.missed_days))) },
    { label: 'Vacant days', value: String(Math.round(asNumber(source.vacant_days))) },
    { label: 'Maturity', value: source.maturity_on || '—' },
    { label: 'Buffer drawn', value: ugx(asNumber(source.buffer_drawn)) },
  ];
}

export const V360_NEW_QUOTE_EXAMPLE_SENTENCE =
  `Illustrative new 360-day Rent Plan only. Rent UGX ${V360_MODEL_A_EXAMPLE.principal.toLocaleString('en-US')} gives Gross UGX ${V360_MODEL_A_EXAMPLE.gross.toLocaleString('en-US')} and Daily UGX ${V360_MODEL_A_EXAMPLE.daily.toLocaleString('en-US')}. Partner Returns are 15% a month for 12 months. Existing Rent Plans keep their approved terms. This example does not turn new-plan pricing on.`;
