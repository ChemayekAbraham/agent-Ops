import { format, subDays, startOfDay, endOfDay, startOfMonth, startOfYear, addDays } from 'date-fns';
import { CalendarIcon } from 'lucide-react';
import type { DateRange } from 'react-day-picker';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

/**
 * Shared date-range filter used by the Agent Ops Overview landing page and the
 * Tenant Ops Classic home page. The presets, range resolution and custom range
 * picker are the exact behaviour that shipped on Agent Ops Overview — this file
 * is the single source of truth so the two pages cannot drift.
 */
export type PresetKey = 'today' | 'yesterday' | 'five' | 'weekend' | 'month' | 'year' | 'custom';

export const PRESETS: { key: PresetKey; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'five', label: 'Last 5 days' },
  { key: 'weekend', label: 'Weekend' },
  { key: 'month', label: 'This month' },
  { key: 'year', label: 'This year' },
  { key: 'custom', label: 'Custom range' },
];

/** Most recent Saturday + Sunday pair (inclusive), based on local device date. */
export function lastWeekend(now: Date): { start: Date; end: Date } {
  let sat = startOfDay(now);
  while (sat.getDay() !== 6) sat = subDays(sat, 1);
  return { start: sat, end: endOfDay(addDays(sat, 1)) };
}

export function resolveRange(preset: PresetKey, custom?: DateRange): { start: Date; end: Date } {
  const now = new Date();
  switch (preset) {
    case 'today':
      return { start: startOfDay(now), end: endOfDay(now) };
    case 'yesterday': {
      const y = subDays(now, 1);
      return { start: startOfDay(y), end: endOfDay(y) };
    }
    case 'five':
      return { start: startOfDay(subDays(now, 4)), end: endOfDay(now) };
    case 'weekend': {
      const w = lastWeekend(now);
      return { start: w.start, end: w.end };
    }
    case 'month':
      return { start: startOfMonth(now), end: endOfDay(now) };
    case 'year':
      return { start: startOfYear(now), end: endOfDay(now) };
    case 'custom': {
      const from = custom?.from ? startOfDay(custom.from) : startOfDay(now);
      const to = custom?.to ? endOfDay(custom.to) : endOfDay(custom?.from ?? now);
      return { start: from, end: to };
    }
  }
}

/** Lower-case phrase describing the selected window, e.g. "in the last 5 days". */
export function rangePhrase(preset: PresetKey, start: Date, end: Date): string {
  switch (preset) {
    case 'today': return 'today';
    case 'yesterday': return 'yesterday';
    case 'five': return 'in the last 5 days';
    case 'weekend': return 'this weekend';
    case 'month': return 'this month';
    case 'year': return 'this year';
    case 'custom':
      return format(start, 'dd MMM') === format(end, 'dd MMM')
        ? `on ${format(start, 'dd MMM')}`
        : `${format(start, 'dd MMM')} – ${format(end, 'dd MMM')}`;
  }
}

interface OpsDateRangeFilterProps {
  preset: PresetKey;
  custom?: DateRange;
  onPresetChange: (preset: PresetKey) => void;
  onCustomChange: (range: DateRange | undefined) => void;
  className?: string;
}

export function OpsDateRangeFilter({
  preset, custom, onPresetChange, onCustomChange, className,
}: OpsDateRangeFilterProps) {
  return (
    <div className={className ?? 'flex flex-wrap items-center gap-1.5'}>
      {PRESETS.map((p) => (
        <Button
          key={p.key}
          size="sm"
          variant={preset === p.key ? 'default' : 'outline'}
          className="h-8 text-xs"
          onClick={() => onPresetChange(p.key)}
        >
          {p.label}
        </Button>
      ))}
      {preset === 'custom' && (
        <Popover>
          <PopoverTrigger asChild>
            <Button size="sm" variant="secondary" className="h-8 text-xs">
              <CalendarIcon className="h-3.5 w-3.5 mr-1" />
              {custom?.from
                ? `${format(custom.from, 'dd MMM')}${custom.to ? ` – ${format(custom.to, 'dd MMM')}` : ''}`
                : 'Pick dates'}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-0" align="end">
            <Calendar
              mode="range"
              numberOfMonths={2}
              selected={custom}
              onSelect={onCustomChange}
              disabled={{ after: new Date() }}
              initialFocus
              className="pointer-events-auto p-3"
            />
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}
