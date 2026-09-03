import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { KPICard } from './KPICard';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { FunderFunnelDrilldown } from './FunderFunnelDrilldown';
import { cn } from '@/lib/utils';
import { Eye, MousePointerClick, Lock, Wallet, CalendarIcon, ChevronRight } from 'lucide-react';
import {
  subDays,
  startOfDay,
  endOfDay,
  startOfWeek,
  startOfMonth,
  endOfMonth,
  format,
  differenceInCalendarDays,
} from 'date-fns';

const STEPS = [
  { key: 'funder_house_repayment_terms_viewed', label: 'Viewed repayment terms', icon: Eye, color: 'bg-primary/10 text-primary' },
  { key: 'funder_house_selected', label: 'Selected a house', icon: MousePointerClick, color: 'bg-blue-500/10 text-blue-600' },
  { key: 'funder_selection_locked', label: 'Locked selection', icon: Lock, color: 'bg-amber-500/10 text-amber-600' },
  { key: 'funder_funding_started', label: 'Started funding', icon: Wallet, color: 'bg-emerald-500/10 text-emerald-600' },
] as const;

type StepKey = (typeof STEPS)[number]['key'];

type FunderDetail = {
  userId: string;
  count: number;
  firstAt: string;
  lastAt: string;
  houseIds: string[];
};

type FunnelData = {
  events: Record<StepKey, number>;
  progressed: Record<StepKey, number>;
  /** Per step: the funders who reached it, richest-activity first. */
  details: Record<StepKey, FunderDetail[]>;
  /** All houses a funder selected in the range (used for drill-down). */
  housesByUser: Record<string, string[]>;
};

type PresetKey = 'today' | 'week' | '7d' | '30d' | 'month' | '90d' | 'custom';

const PRESETS: { key: Exclude<PresetKey, 'custom'>; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'week', label: 'This week' },
  { key: '7d', label: 'Last 7 days' },
  { key: '30d', label: 'Last 30 days' },
  { key: 'month', label: 'This month' },
  { key: '90d', label: 'Last 90 days' },
];

function rangeForPreset(preset: Exclude<PresetKey, 'custom'>): { from: Date; to: Date } {
  const now = new Date();
  switch (preset) {
    case 'today':
      return { from: startOfDay(now), to: endOfDay(now) };
    case 'week':
      return { from: startOfWeek(now, { weekStartsOn: 1 }), to: endOfDay(now) };
    case '7d':
      return { from: startOfDay(subDays(now, 6)), to: endOfDay(now) };
    case 'month':
      return { from: startOfMonth(now), to: endOfMonth(now) };
    case '90d':
      return { from: startOfDay(subDays(now, 89)), to: endOfDay(now) };
    case '30d':
    default:
      return { from: startOfDay(subDays(now, 29)), to: endOfDay(now) };
  }
}

export function FunderFunnelPanel() {
  const [preset, setPreset] = useState<PresetKey>('today');
  const [customFrom, setCustomFrom] = useState<Date | undefined>(startOfDay(new Date()));
  const [customTo, setCustomTo] = useState<Date | undefined>(endOfDay(new Date()));
  const [drillStep, setDrillStep] = useState<StepKey | null>(null);

  const range = useMemo(() => {
    if (preset === 'custom') {
      const from = customFrom ? startOfDay(customFrom) : startOfDay(subDays(new Date(), 29));
      const to = customTo ? endOfDay(customTo) : endOfDay(new Date());
      return from <= to ? { from, to } : { from: to, to: from };
    }
    return rangeForPreset(preset);
  }, [preset, customFrom, customTo]);

  const days = differenceInCalendarDays(range.to, range.from) + 1;

  const { data, isLoading } = useQuery<FunnelData>({
    queryKey: ['exec-funder-funnel-panel', range.from.toISOString(), range.to.toISOString()],
    staleTime: 300_000,
    queryFn: async () => {
      const { data: rows, error } = await supabase
        .from('system_events')
        .select('event_type, user_id, created_at, related_entity_id')
        .in('event_type', STEPS.map((s) => s.key))
        .gte('created_at', range.from.toISOString())
        .lte('created_at', range.to.toISOString())
        .order('created_at', { ascending: true })
        .limit(20000);
      if (error) throw error;

      const events = {} as Record<StepKey, number>;
      const perStep = {} as Record<StepKey, Record<string, FunderDetail>>;
      STEPS.forEach((s) => {
        events[s.key] = 0;
        perStep[s.key] = {};
      });

      // First "viewed terms" timestamp per funder within the range — later
      // steps only count as progression if they happen at or after it.
      const firstView: Record<string, string> = {};
      (rows || []).forEach((r: any) => {
        if (r.event_type === 'funder_house_repayment_terms_viewed' && r.user_id && !firstView[r.user_id]) {
          firstView[r.user_id] = r.created_at;
        }
      });

      const housesByUser: Record<string, Set<string>> = {};

      (rows || []).forEach((r: any) => {
        const key = r.event_type as StepKey;
        if (!(key in events)) return;
        events[key]++;
        if (!r.user_id) return;
        const fv = firstView[r.user_id];
        if (!fv || r.created_at < fv) return;

        const bucket = perStep[key];
        if (!bucket[r.user_id]) {
          bucket[r.user_id] = {
            userId: r.user_id,
            count: 0,
            firstAt: r.created_at,
            lastAt: r.created_at,
            houseIds: [],
          };
        }
        const d = bucket[r.user_id];
        d.count++;
        if (r.created_at < d.firstAt) d.firstAt = r.created_at;
        if (r.created_at > d.lastAt) d.lastAt = r.created_at;
        if (r.related_entity_id && !d.houseIds.includes(r.related_entity_id)) {
          d.houseIds.push(r.related_entity_id);
        }
        if (key === 'funder_house_selected' && r.related_entity_id) {
          (housesByUser[r.user_id] ||= new Set<string>()).add(r.related_entity_id);
        }
      });

      const progressed = {} as Record<StepKey, number>;
      const details = {} as Record<StepKey, FunderDetail[]>;
      STEPS.forEach((s) => {
        const list = Object.values(perStep[s.key]).sort(
          (a, b) => b.count - a.count || (a.lastAt < b.lastAt ? 1 : -1),
        );
        details[s.key] = list;
        progressed[s.key] = list.length;
      });

      return {
        events,
        progressed,
        details,
        housesByUser: Object.fromEntries(
          Object.entries(housesByUser).map(([k, v]) => [k, Array.from(v)]),
        ),
      };
    },
  });

  const base = data?.progressed.funder_house_repayment_terms_viewed ?? 0;
  const pct = (n: number) => (base > 0 ? Math.round((n / base) * 100) : 0);
  const rangeLabel = `${format(range.from, 'd MMM yyyy')} – ${format(range.to, 'd MMM yyyy')}`;

  return (
    <div className="rounded-2xl border border-border bg-card p-3 sm:p-4 space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 className="text-sm font-semibold">Funder conversion funnel</h3>
          <p className="text-[11px] text-muted-foreground">
            Funders who opened “View repayment terms” and how far they went ·{' '}
            {format(range.from, 'd MMM yyyy')} – {format(range.to, 'd MMM yyyy')} ({days} day{days === 1 ? '' : 's'})
          </p>
        </div>
      </div>

      {/* Date range controls */}
      <div className="flex flex-wrap items-center gap-1.5">
        {PRESETS.map((p) => (
          <button
            key={p.key}
            type="button"
            onClick={() => setPreset(p.key)}
            className={cn(
              'rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors touch-manipulation',
              preset === p.key
                ? 'border-primary bg-primary/10 text-primary'
                : 'border-border text-muted-foreground hover:bg-muted',
            )}
          >
            {p.label}
          </button>
        ))}

        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className={cn(
                'h-7 rounded-full px-2.5 text-[11px] font-medium',
                preset === 'custom' && 'border-primary text-primary',
              )}
            >
              <CalendarIcon className="mr-1 h-3.5 w-3.5" />
              {preset === 'custom'
                ? `${customFrom ? format(customFrom, 'd MMM') : '—'} – ${customTo ? format(customTo, 'd MMM') : '—'}`
                : 'Custom range'}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-3 space-y-3" align="start">
            <div className="flex flex-col gap-3 sm:flex-row">
              <div>
                <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">From</p>
                <Calendar
                  mode="single"
                  selected={customFrom}
                  onSelect={(d) => { if (d) { setCustomFrom(d); setPreset('custom'); } }}
                  disabled={{ after: new Date() }}
                  initialFocus
                  className={cn('rounded-md border p-3 pointer-events-auto')}
                />
              </div>
              <div>
                <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">To</p>
                <Calendar
                  mode="single"
                  selected={customTo}
                  onSelect={(d) => { if (d) { setCustomTo(d); setPreset('custom'); } }}
                  disabled={{ after: new Date() }}
                  className={cn('rounded-md border p-3 pointer-events-auto')}
                />
              </div>
            </div>
          </PopoverContent>
        </Popover>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-3">
        {STEPS.map((s) => (
          <KPICard
            key={s.key}
            title={s.label}
            value={(data?.progressed[s.key] ?? 0).toLocaleString()}
            icon={s.icon}
            color={s.color}
            loading={isLoading}
            onClick={() => setDrillStep(s.key)}
            subtitle={
              s.key === 'funder_house_repayment_terms_viewed'
                ? `${(data?.events[s.key] ?? 0).toLocaleString()} clicks`
                : `${pct(data?.progressed[s.key] ?? 0)}% of viewers`
            }
          />
        ))}
      </div>

      <div className="space-y-2">
        {STEPS.map((s, i) => {
          const value = data?.progressed[s.key] ?? 0;
          const width = base > 0 ? Math.max(4, (value / base) * 100) : 0;
          const prev = i === 0 ? null : data?.progressed[STEPS[i - 1].key] ?? 0;
          const dropOff = prev && prev > 0 ? Math.round(((prev - value) / prev) * 100) : 0;
          return (
            <button
              key={s.key}
              type="button"
              onClick={() => setDrillStep(s.key)}
              className="w-full space-y-1 rounded-lg p-1 text-left transition-colors hover:bg-muted/50 touch-manipulation"
            >
              <div className="flex items-center justify-between text-[11px]">
                <span className="font-medium flex items-center gap-1">
                  {s.label}
                  <ChevronRight className="h-3 w-3 text-muted-foreground" />
                </span>
                <span className="text-muted-foreground">
                  {value.toLocaleString()} funder{value === 1 ? '' : 's'} · {pct(value)}%
                  {i > 0 && dropOff > 0 && (
                    <span className="text-destructive"> · −{dropOff}% vs previous</span>
                  )}
                </span>
              </div>
              <div className="h-2.5 w-full rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full rounded-full bg-primary transition-all"
                  style={{ width: `${width}%` }}
                />
              </div>
            </button>
          );
        })}
      </div>

      {!isLoading && base === 0 && (
        <p className="text-[11px] text-muted-foreground">No funder activity in this range.</p>
      )}

      <p className="text-[10px] text-muted-foreground">
        A funder counts at a step only if the action happened at or after their first
        “View repayment terms” click inside the selected range.
      </p>

      <FunderFunnelDrilldown
        open={!!drillStep}
        onOpenChange={(o) => !o && setDrillStep(null)}
        stepLabel={STEPS.find((s) => s.key === drillStep)?.label ?? ''}
        rangeLabel={rangeLabel}
        details={drillStep ? data?.details[drillStep] ?? [] : []}
        housesByUser={data?.housesByUser ?? {}}
      />
    </div>
  );
}
