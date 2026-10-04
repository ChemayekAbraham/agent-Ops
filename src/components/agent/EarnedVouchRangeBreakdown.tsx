import { useEffect, useMemo, useState } from 'react';
import { CalendarIcon, ShieldCheck, TrendingUp } from 'lucide-react';
import { format } from 'date-fns';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';
import { cn } from '@/lib/utils';
import { onVouchUpdated } from '@/lib/vouchEvents';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

/**
 * EarnedVouchRangeBreakdown
 * ---------------------------------------------------------------------
 * Shared component used in two places:
 *   1. Public HolisticProfile (anyone with the AI ID)
 *   2. Agent's own dashboard (AgentVouchHighlightCard expanded section)
 *
 * Calls the SECURITY DEFINER RPC `get_agent_earned_vouch_in_range`,
 * which returns aggregate UGX numbers only — no per-tenant data, safe
 * for the public profile.
 *
 * Filters: 7d / 30d / 90d / All. "All" sends NULL for window_start so
 * the RPC returns lifetime totals, matching the legacy view.
 */

type Range = '7d' | '30d' | '90d' | 'all' | 'custom';

const RANGES: { key: Exclude<Range, 'custom'>; label: string; days: number | null }[] = [
  { key: '7d',  label: '7d',  days: 7 },
  { key: '30d', label: '30d', days: 30 },
  { key: '90d', label: '90d', days: 90 },
  { key: 'all', label: 'All', days: null },
];

interface RangeData {
  found: boolean;
  collected_ugx: number;
  earned_vouch_ugx: number;
  collection_count: number;
  multiplier: number;
  floor_ugx: number;
}

interface Props {
  aiId: string;
  /** Effective limit shown as the "reconcile" line. Pass when known. */
  effectiveLimitUgx?: number;
  /** Optional className for outer wrapper. */
  className?: string;
  /** Default selected range. Defaults to "30d". */
  defaultRange?: Range;
  /**
   * When true, each row shows a verbose, itemized "how this number is
   * calculated" line (formula + inputs in UGX), and a footer note
   * explains the overall logic. Used on the public HolisticProfile so
   * any visitor can audit the math. Defaults to false (terse mode) for
   * the agent's own dashboard where space is tight.
   */
  explain?: boolean;
}

export function EarnedVouchRangeBreakdown({
  aiId,
  effectiveLimitUgx,
  className,
  defaultRange = '30d',
  explain = false,
}: Props) {
  const [range, setRange] = useState<Range>(defaultRange);
  const [data, setData] = useState<RangeData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshTick, setRefreshTick] = useState(0);
  const [customStart, setCustomStart] = useState<Date | undefined>(() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return d;
  });
  const [customEnd, setCustomEnd] = useState<Date | undefined>(new Date());

  // Live-refresh when a collection lands for this AI ID.
  useEffect(() => {
    return onVouchUpdated((d) => {
      if (!d.aiId || d.aiId.toUpperCase() === aiId?.toUpperCase()) {
        setRefreshTick((n) => n + 1);
      }
    });
  }, [aiId]);

  const { startAt, endAt } = useMemo(() => {
    if (range === 'custom') {
      const s = customStart ? new Date(customStart) : null;
      if (s) s.setHours(0, 0, 0, 0);
      const e = customEnd ? new Date(customEnd) : null;
      if (e) e.setHours(23, 59, 59, 999);
      return {
        startAt: s ? s.toISOString() : null,
        endAt: e ? e.toISOString() : null,
      };
    }
    const cfg = RANGES.find((r) => r.key === range);
    if (!cfg?.days) return { startAt: null, endAt: null };
    const d = new Date();
    d.setDate(d.getDate() - cfg.days);
    return { startAt: d.toISOString(), endAt: null };
  }, [range, customStart, customEnd]);

  useEffect(() => {
    let cancelled = false;
    if (!aiId) return;
    setLoading(true);

    (async () => {
      const { data: rpcData, error } = await supabase.rpc('get_agent_earned_vouch_in_range', {
        p_ai_id: aiId.toUpperCase(),
        p_start_at: startAt,
        p_end_at: endAt,
      });

      if (cancelled) return;
      if (error || !rpcData) {
        setData(null);
      } else {
        const r = rpcData as unknown as RangeData;
        setData({
          found: !!r.found,
          collected_ugx: Number(r.collected_ugx) || 0,
          earned_vouch_ugx: Number(r.earned_vouch_ugx) || 0,
          collection_count: Number(r.collection_count) || 0,
          multiplier: Number(r.multiplier) || 2,
          floor_ugx: Number(r.floor_ugx) || 100_000,
        });
      }
      setLoading(false);
    })();

    return () => { cancelled = true; };
  }, [aiId, startAt, endAt, refreshTick]);

  if (!loading && (!data || !data.found)) return null;

  // The trust engine may push the effective limit above (floor + earned)
  // — only meaningful when "All" is selected, since the limit is lifetime.
  const showTrustBoost = range === 'all' && data && effectiveLimitUgx != null;
  const trustBoost = showTrustBoost
    ? Math.max(0, (effectiveLimitUgx ?? 0) - data!.floor_ugx - data!.earned_vouch_ugx)
    : 0;

  return (
    <div className={cn(
      'rounded-xl border border-primary/30 bg-gradient-to-br from-primary/8 to-emerald-500/5 p-3',
      className,
    )}>
      <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
        <div className="flex items-center gap-1.5">
          <TrendingUp className="h-3.5 w-3.5 text-primary" />
          <p className="text-[10px] uppercase tracking-wider font-bold text-primary">
            Earned vouch breakdown
          </p>
        </div>
        <div className="flex items-center gap-0.5 rounded-md bg-background/60 p-0.5 flex-wrap">
          {RANGES.map((r) => (
            <button
              key={r.key}
              type="button"
              onClick={() => setRange(r.key)}
              className={cn(
                'px-2 py-0.5 text-[10px] font-semibold rounded transition-colors tabular-nums',
                range === r.key
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
              aria-pressed={range === r.key}
            >
              {r.label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setRange('custom')}
            className={cn(
              'px-2 py-0.5 text-[10px] font-semibold rounded transition-colors',
              range === 'custom'
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
            aria-pressed={range === 'custom'}
          >
            Custom
          </button>
        </div>
      </div>

      {range === 'custom' && (
        <div className="flex items-center gap-2 mb-2 flex-wrap">
          <DateField label="From" value={customStart} onChange={setCustomStart} max={customEnd} />
          <DateField label="To" value={customEnd} onChange={setCustomEnd} min={customStart} />
        </div>
      )}

      {loading ? (
        <div className="space-y-1.5">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-5 w-2/3" />
        </div>
      ) : data ? (
        <div className="space-y-1.5">
          {range === 'all' && (
            <Row
              label="Welile base vouch"
              sub={
                explain
                  ? `Fixed floor granted to every active agent: ${formatUGX(data.floor_ugx)}.`
                  : 'Every active agent starts here'
              }
              value={formatUGX(data.floor_ugx)}
            />
          )}
          <Row
            label={`Collected (${rangeLabel(range)})`}
            sub={
              explain
                ? `Sum of every rent collection recorded ${rangeLabel(range)} — ${data.collection_count} ${data.collection_count === 1 ? 'collection' : 'collections'} totalling ${formatUGX(data.collected_ugx)}.`
                : `${data.collection_count} ${data.collection_count === 1 ? 'collection' : 'collections'}`
            }
            value={formatUGX(data.collected_ugx)}
          />
          <Row
            label={`Earned vouch (${data.multiplier}× collected)`}
            sub={
              explain
                ? `${formatUGX(data.collected_ugx)} collected × ${data.multiplier} = ${formatUGX(data.earned_vouch_ugx)}. Welile vouches twice every shilling collected.`
                : 'Welile vouches double the rent collected'
            }
            value={formatUGX(data.earned_vouch_ugx)}
            accent
          />
          {showTrustBoost && trustBoost > 0 && (
            <Row
              label="Trust score boost"
              sub={
                explain
                  ? `Effective limit (${formatUGX(effectiveLimitUgx ?? 0)}) − base (${formatUGX(data!.floor_ugx)}) − earned (${formatUGX(data!.earned_vouch_ugx)}) = ${formatUGX(trustBoost)}. Bonus from healthy ratio × monthly book.`
                  : 'Extra vouch from your overall trust score'
              }
              value={formatUGX(trustBoost)}
            />
          )}
          {range === 'all' && effectiveLimitUgx != null && (
            <div className="flex items-center justify-between pt-2 mt-1 border-t border-primary/20">
              <div className="flex items-center gap-1.5">
                <ShieldCheck className="h-3.5 w-3.5 text-emerald-700 dark:text-emerald-400" />
                <span className="text-[11px] font-bold text-foreground">Effective Welile vouch</span>
              </div>
              <span className="text-sm font-black tabular-nums text-emerald-700 dark:text-emerald-400">
                {formatUGX(effectiveLimitUgx)}
              </span>
            </div>
          )}

          {explain && (
            <div className="mt-2 pt-2 border-t border-primary/15 space-y-1">
              <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                How this is calculated
              </p>
              <ul className="text-[10px] text-muted-foreground leading-snug list-disc pl-4 space-y-0.5">
                <li>
                  <span className="font-semibold text-foreground">Base vouch:</span>{' '}
                  every active Welile agent gets {formatUGX(data.floor_ugx)} as a starting trust floor.
                </li>
                <li>
                  <span className="font-semibold text-foreground">Earned vouch:</span>{' '}
                  Welile multiplies the rent this agent has collected by {data.multiplier} —
                  every shilling collected on schedule earns {data.multiplier} shillings of vouch.
                </li>
                {range !== 'all' && (
                  <li>
                    <span className="font-semibold text-foreground">Window:</span>{' '}
                    only collections recorded in the {rangeLabel(range)} are counted here.
                    Switch to <span className="font-semibold text-foreground">All</span> to see lifetime totals.
                  </li>
                )}
                {showTrustBoost && trustBoost > 0 && (
                  <li>
                    <span className="font-semibold text-foreground">Trust boost:</span>{' '}
                    extra vouch unlocked when the agent's healthy-tenant ratio and monthly
                    book push their trust score above the base + earned amount.
                  </li>
                )}
                <li>
                  <span className="font-semibold text-foreground">Effective limit:</span>{' '}
                  base + earned + trust boost. This is what lenders may safely lend against.
                </li>
              </ul>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

function rangeLabel(r: Range) {
  switch (r) {
    case '7d':  return 'last 7 days';
    case '30d': return 'last 30 days';
    case '90d': return 'last 90 days';
    case 'all': return 'lifetime';
    case 'custom': return 'selected range';
  }
}

function DateField({
  label, value, onChange, min, max,
}: {
  label: string;
  value: Date | undefined;
  onChange: (d: Date | undefined) => void;
  min?: Date;
  max?: Date;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn(
            'h-7 px-2 text-[10px] gap-1 font-semibold',
            !value && 'text-muted-foreground',
          )}
        >
          <CalendarIcon className="h-3 w-3" />
          <span className="text-muted-foreground">{label}:</span>
          {value ? format(value, 'd MMM yy') : 'pick'}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          selected={value}
          onSelect={onChange}
          disabled={(d) =>
            (min ? d < new Date(min.getFullYear(), min.getMonth(), min.getDate()) : false) ||
            (max ? d > new Date(max.getFullYear(), max.getMonth(), max.getDate()) : false) ||
            d > new Date()
          }
          initialFocus
          className={cn('p-3 pointer-events-auto')}
        />
      </PopoverContent>
    </Popover>
  );
}

function Row({
  label, sub, value, accent,
}: { label: string; sub?: string; value: string; accent?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className={cn('text-[11px] font-semibold leading-tight', accent ? 'text-foreground' : 'text-foreground/80')}>
          {label}
        </p>
        {sub && <p className="text-[10px] text-muted-foreground leading-tight mt-0.5">{sub}</p>}
      </div>
      <span className={cn(
        'text-[11px] font-bold tabular-nums shrink-0',
        accent ? 'text-emerald-700 dark:text-emerald-400' : 'text-foreground',
      )}>
        {value}
      </span>
    </div>
  );
}

export default EarnedVouchRangeBreakdown;