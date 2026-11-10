import { kampalaTodayYmd, kampalaYmd, shiftKampalaDays } from '@/lib/kampalaDays';

export type LunchAllowancePeriod = 'all' | 'today' | 'yesterday' | '7days' | '30days' | 'custom';

export const lunchAllowancePeriods: { value: LunchAllowancePeriod; label: string }[] = [
  { value: 'all', label: 'All time' },
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: '7days', label: 'Last 7 days' },
  { value: '30days', label: 'Last 30 days' },
  { value: 'custom', label: 'Custom' },
];

export function lunchAllowanceRange(period: LunchAllowancePeriod, today = kampalaTodayYmd(), customDate = today) {
  if (period === 'all') return null;
  if (period === 'custom') return { start: customDate, end: customDate };
  const end = period === 'yesterday' ? shiftKampalaDays(today, -1) : today;
  const start = period === '7days' ? shiftKampalaDays(today, -6)
    : period === '30days' ? shiftKampalaDays(today, -29) : end;
  return { start, end };
}

export function inLunchAllowanceRange(createdAt: string, range: ReturnType<typeof lunchAllowanceRange>) {
  if (!range) return true;
  const day = kampalaYmd(createdAt);
  return day !== null && day >= range.start && day <= range.end;
}