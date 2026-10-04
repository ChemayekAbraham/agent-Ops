import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Loader2, TrendingUp, TrendingDown, Minus, CalendarRange, Calendar as CalendarIcon, ChevronDown, ChevronUp } from 'lucide-react';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip as RTooltip, CartesianGrid } from 'recharts';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { format, startOfDay, endOfDay, isAfter, isBefore } from 'date-fns';
import { cn } from '@/lib/utils';

type Granularity = 'day' | 'week' | 'month' | 'quarter' | 'year';
type Mode = 'rolling' | 'custom';

interface DateRangeVal {
  from?: Date;
  to?: Date;
}

const GRAN: Record<Granularity, { label: string; over: string; periods: number }> = {
  day: { label: 'Day', over: 'Day over day', periods: 14 },
  week: { label: 'Week', over: 'Week over week', periods: 12 },
  month: { label: 'Month', over: 'Month over month', periods: 12 },
  quarter: { label: 'Quarter', over: 'Quarter over quarter', periods: 8 },
  year: { label: 'Year', over: 'Year over year', periods: 5 },
};

const TZ = 'Africa/Kampala';

const fmtUgx = (n: number) => `UGX ${Math.round(n).toLocaleString()}`;

interface TxLite {
  amount: number | null;
  direction: string | null;
  internal_date: string | null;
  id?: string;
  subject?: string | null;
  counterparty?: string | null;
  channel?: string | null;
  transaction_id?: string | null;
  from_name?: string | null;
}

interface Bucket {
  key: string;
  label: string;
  start: number;
  in: number;
  out: number;
  net: number;
  count: number;
}

/** Date parts (year, month, day) of a timestamp as seen in the Kampala tz. */
function partsInTz(ms: number): { y: number; m: number; d: number } {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const [y, m, d] = dtf.format(new Date(ms)).split('-').map(Number);
  return { y, m, d };
}

function startOfDayUtcForTz(ms: number): number {
  const { y, m, d } = partsInTz(ms);
  return Date.UTC(y, m - 1, d);
}

/** Compute the bucket key + display label + bucket-start for a granularity. */
function bucketize(ms: number, g: Granularity): { key: string; label: string; start: number } {
  const { y, m, d } = partsInTz(ms);
  const dayStart = Date.UTC(y, m - 1, d);
  if (g === 'day') {
    return { key: `${y}-${m}-${d}`, label: `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}`, start: dayStart };
  }
  if (g === 'week') {
    // ISO-ish week: anchor to Monday.
    const dow = (new Date(dayStart).getUTCDay() + 6) % 7; // 0 = Monday
    const weekStart = dayStart - dow * 86_400_000;
    const ws = new Date(weekStart);
    return { key: `w-${weekStart}`, label: `${String(ws.getUTCDate()).padStart(2, '0')}/${String(ws.getUTCMonth() + 1).padStart(2, '0')}`, start: weekStart };
  }
  if (g === 'month') {
    return { key: `${y}-${m}`, label: `${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][m - 1]} ${String(y).slice(2)}`, start: Date.UTC(y, m - 1, 1) };
  }
  if (g === 'quarter') {
    const q = Math.floor((m - 1) / 3);
    return { key: `${y}-q${q}`, label: `Q${q + 1} ${String(y).slice(2)}`, start: Date.UTC(y, q * 3, 1) };
  }
  return { key: `${y}`, label: `${y}`, start: Date.UTC(y, 0, 1) };
}

function pctChange(curr: number, prev: number): number | null {
  if (prev === 0) return curr === 0 ? 0 : null;
  return ((curr - prev) / Math.abs(prev)) * 100;
}

function DeltaBadge({ value }: { value: number | null }) {
  if (value === null) {
    return <span className="text-[11px] text-muted-foreground">new</span>;
  }
  const up = value > 0;
  const flat = Math.abs(value) < 0.05;
  const Icon = flat ? Minus : up ? TrendingUp : TrendingDown;
  const color = flat ? 'text-muted-foreground' : up ? 'text-emerald-500' : 'text-rose-500';
  return (
    <span className={`inline-flex items-center gap-0.5 text-[11px] font-medium ${color}`}>
      <Icon className="h-3 w-3" />
      {flat ? '0%' : `${up ? '+' : ''}${value.toFixed(1)}%`}
    </span>
  );
}

function inRange(ts: string | null, range: DateRangeVal): boolean {
  if (!ts || !range.from) return false;
  const d = new Date(ts);
  const from = startOfDay(range.from);
  if (isBefore(d, from)) return false;
  if (range.to) {
    const to = endOfDay(range.to);
    if (isAfter(d, to)) return false;
  }
  return true;
}

function DateRangePicker({
  label,
  range,
  onChange,
  maxDate,
}: {
  label: string;
  range: DateRangeVal;
  onChange: (r: DateRangeVal) => void;
  maxDate?: Date;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{label}</span>
      <div className="flex items-center gap-2">
        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className={cn('h-8 justify-start text-left text-xs font-normal', !range.from && 'text-muted-foreground')}
            >
              <CalendarIcon className="mr-1.5 h-3.5 w-3.5" />
              {range.from ? format(range.from, 'yyyy-MM-dd') : 'From'}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-0 pointer-events-auto" align="start">
            <Calendar
              mode="single"
              selected={range.from}
              onSelect={(d) => onChange({ ...range, from: d })}
              initialFocus
              className={cn('p-3 pointer-events-auto')}
              disabled={maxDate ? { after: maxDate } : undefined}
            />
          </PopoverContent>
        </Popover>
        <span className="text-muted-foreground text-xs">→</span>
        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className={cn('h-8 justify-start text-left text-xs font-normal', !range.to && 'text-muted-foreground')}
            >
              <CalendarIcon className="mr-1.5 h-3.5 w-3.5" />
              {range.to ? format(range.to, 'yyyy-MM-dd') : 'To'}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-0 pointer-events-auto" align="start">
            <Calendar
              mode="single"
              selected={range.to}
              onSelect={(d) => onChange({ ...range, to: d })}
              initialFocus
              className={cn('p-3 pointer-events-auto')}
              disabled={maxDate ? { after: maxDate } : undefined}
            />
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );
}

export function EmailPeriodComparison() {
  const [collapsed, setCollapsed] = useState(true);
  const [mode, setMode] = useState<Mode>('rolling');
  const [granularity, setGranularity] = useState<Granularity>('day');
  const [rows, setRows] = useState<TxLite[]>([]);
  const [loading, setLoading] = useState(true);

  // Restore persisted UI state on mount
  useEffect(() => {
    try {
      const raw = localStorage.getItem('welile-email-period-comparison');
      if (raw) {
        const saved = JSON.parse(raw);
        if (typeof saved.collapsed === 'boolean') setCollapsed(saved.collapsed);
        if (saved.mode === 'rolling' || saved.mode === 'custom') setMode(saved.mode);
        if (['day', 'week', 'month', 'quarter', 'year'].includes(saved.granularity)) {
          setGranularity(saved.granularity);
        }
      }
    } catch { /* ignore corrupt storage */ }
  }, []);

  // Persist UI state whenever it changes
  useEffect(() => {
    localStorage.setItem('welile-email-period-comparison', JSON.stringify({ collapsed, mode, granularity }));
  }, [collapsed, mode, granularity]);

  // Custom range state
  const today = useMemo(() => new Date(), []);
  const [rangeA, setRangeA] = useState<DateRangeVal>({ from: undefined, to: undefined });
  const [rangeB, setRangeB] = useState<DateRangeVal>({ from: undefined, to: undefined });

  const customReady = !!rangeA.from && !!rangeB.from;

  // Drilldown: which period's transactions are being viewed
  const [drill, setDrill] = useState<'a' | 'b' | null>(null);

  useEffect(() => {
    if (collapsed) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      let sinceIso: string;
      if (mode === 'rolling') {
        const ms = {
          day: 20 * 86_400_000,
          week: 16 * 7 * 86_400_000,
          month: 14 * 31 * 86_400_000,
          quarter: 10 * 92 * 86_400_000,
          year: 6 * 366 * 86_400_000,
        }[granularity];
        sinceIso = new Date(Date.now() - ms).toISOString();
      } else {
        // Custom: use the earliest 'from' of the two ranges
        const candidates = [rangeA.from, rangeB.from].filter(Boolean) as Date[];
        if (candidates.length === 0) { setLoading(false); return; }
        sinceIso = startOfDay(candidates.reduce((a, b) => (a < b ? a : b))).toISOString();
      }
      const { data, error } = await (supabase.from('gmail_transactions') as any)
        .select('id,amount,direction,internal_date,subject,counterparty,channel,transaction_id,from_name')
        .gte('internal_date', sinceIso)
        .order('internal_date', { ascending: false })
        .limit(20000);
      if (cancelled) return;
      if (error) { setRows([]); setLoading(false); return; }
      setRows((data ?? []) as TxLite[]);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [collapsed, mode, granularity, rangeA.from, rangeB.from]);

  const rollingBuckets = useMemo<Bucket[]>(() => {
    const map = new Map<string, Bucket>();
    for (const r of rows) {
      if (!r.internal_date) continue;
      const ms = new Date(r.internal_date).getTime();
      if (!Number.isFinite(ms)) continue;
      const { key, label, start } = bucketize(ms, granularity);
      let b = map.get(key);
      if (!b) { b = { key, label, start, in: 0, out: 0, net: 0, count: 0 }; map.set(key, b); }
      const amt = Number(r.amount) || 0;
      if (amt > 0) {
        if (r.direction === 'in') b.in += amt;
        else if (r.direction === 'out') b.out += amt;
      }
      b.count += 1;
    }
    const arr = Array.from(map.values()).sort((a, b) => a.start - b.start);
    for (const b of arr) b.net = b.in - b.out;
    return arr.slice(-GRAN[granularity].periods);
  }, [rows, granularity]);

  const curr = rollingBuckets[rollingBuckets.length - 1];
  const prev = rollingBuckets[rollingBuckets.length - 2];

  const rollingMetrics = useMemo(() => {
    if (!curr) return [];
    const p = prev ?? { in: 0, out: 0, net: 0, count: 0 };
    return [
      { label: 'Money in', curr: curr.in, prev: p.in, fmt: fmtUgx },
      { label: 'Money out', curr: curr.out, prev: p.out, fmt: fmtUgx },
      { label: 'Net', curr: curr.net, prev: p.net, fmt: fmtUgx },
      { label: 'Emails', curr: curr.count, prev: p.count, fmt: (n: number) => n.toLocaleString() },
    ];
  }, [curr, prev]);

  const chartData = useMemo(
    () => rollingBuckets.map((b) => ({ label: b.label, In: Math.round(b.in), Out: Math.round(b.out) })),
    [rollingBuckets],
  );

  // Custom range aggregation
  const customAgg = useMemo(() => {
    if (mode !== 'custom' || !customReady) return null;
    const a = { in: 0, out: 0, net: 0, count: 0 };
    const b = { in: 0, out: 0, net: 0, count: 0 };
    for (const r of rows) {
      if (!r.internal_date) continue;
      const inA = inRange(r.internal_date, rangeA);
      const inB = inRange(r.internal_date, rangeB);
      if (!inA && !inB) continue;
      const amt = Number(r.amount) || 0;
      const target = inA ? a : b;
      if (amt > 0) {
        if (r.direction === 'in') target.in += amt;
        else if (r.direction === 'out') target.out += amt;
      }
      target.count += 1;
    }
    a.net = a.in - a.out;
    b.net = b.in - b.out;
    return { a, b };
  }, [mode, customReady, rows, rangeA, rangeB]);

  const customMetrics = useMemo(() => {
    if (!customAgg) return [];
    const { a, b } = customAgg;
    return [
      { label: 'Money in', curr: a.in, prev: b.in, fmt: fmtUgx },
      { label: 'Money out', curr: a.out, prev: b.out, fmt: fmtUgx },
      { label: 'Net', curr: a.net, prev: b.net, fmt: fmtUgx },
      { label: 'Emails', curr: a.count, prev: b.count, fmt: (n: number) => n.toLocaleString() },
    ];
  }, [customAgg]);

  const periodALabel = rangeA.from
    ? `${format(rangeA.from, 'yyyy-MM-dd')}${rangeA.to ? ` → ${format(rangeA.to, 'yyyy-MM-dd')}` : ''}`
    : 'Period A';
  const periodBLabel = rangeB.from
    ? `${format(rangeB.from, 'yyyy-MM-dd')}${rangeB.to ? ` → ${format(rangeB.to, 'yyyy-MM-dd')}` : ''}`
    : 'Period B';

  // Transactions included in the drilled-into period, newest first.
  const drillTx = useMemo(() => {
    if (!drill) return [];
    const range = drill === 'a' ? rangeA : rangeB;
    return rows
      .filter((r) => inRange(r.internal_date, range))
      .sort((x, y) => new Date(y.internal_date ?? 0).getTime() - new Date(x.internal_date ?? 0).getTime());
  }, [drill, rows, rangeA, rangeB]);

  const drillLabel = drill === 'a' ? periodALabel : drill === 'b' ? periodBLabel : '';
  const drillTotals = useMemo(() => {
    const t = { in: 0, out: 0 };
    for (const r of drillTx) {
      const amt = Number(r.amount) || 0;
      if (amt > 0) {
        if (r.direction === 'in') t.in += amt;
        else if (r.direction === 'out') t.out += amt;
      }
    }
    return t;
  }, [drillTx]);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <CalendarRange className="h-4 w-4 text-primary" />
            Period Comparison
            {!collapsed && mode === 'rolling' && ` · ${GRAN[granularity].over}`}
          </CardTitle>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 w-7 p-0"
            onClick={() => setCollapsed((c) => !c)}
            aria-label={collapsed ? 'Expand period comparison' : 'Collapse period comparison'}
          >
            {collapsed ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
          </Button>
        </div>

        {collapsed && !loading && (
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
            {mode === 'rolling' && curr ? (
              <>
                <span className="text-[11px] text-muted-foreground">In <strong className="text-emerald-500 tabular-nums">{fmtUgx(curr.in)}</strong></span>
                <span className="text-[11px] text-muted-foreground">Out <strong className="text-rose-500 tabular-nums">{fmtUgx(curr.out)}</strong></span>
                <span className="text-[11px] text-muted-foreground">Net <strong className={curr.net >= 0 ? 'text-foreground' : 'text-rose-500'}>{fmtUgx(curr.net)}</strong></span>
                <span className="text-[11px] text-muted-foreground">Emails <strong className="text-foreground tabular-nums">{curr.count.toLocaleString()}</strong></span>
              </>
            ) : mode === 'custom' && customAgg ? (
              <>
                <span className="text-[11px] text-muted-foreground">A In <strong className="text-emerald-500 tabular-nums">{fmtUgx(customAgg.a.in)}</strong></span>
                <span className="text-[11px] text-muted-foreground">A Out <strong className="text-rose-500 tabular-nums">{fmtUgx(customAgg.a.out)}</strong></span>
                <span className="text-[11px] text-muted-foreground">A Net <strong className={customAgg.a.net >= 0 ? 'text-foreground' : 'text-rose-500'}>{fmtUgx(customAgg.a.net)}</strong></span>
                <span className="text-[11px] text-muted-foreground">Emails <strong className="text-foreground tabular-nums">{(customAgg.a.count + customAgg.b.count).toLocaleString()}</strong></span>
              </>
            ) : (
              <span className="text-[11px] text-muted-foreground">Loading…</span>
            )}
          </div>
        )}

        {!collapsed && (
          <>
            <div className="flex flex-wrap items-center gap-2 mt-3">
              <div className="flex rounded-md border overflow-hidden">
                <Button
                  size="sm"
                  variant={mode === 'rolling' ? 'default' : 'ghost'}
                  className="h-7 rounded-none px-2.5 text-xs"
                  onClick={() => setMode('rolling')}
                >
                  Rolling
                </Button>
                <Button
                  size="sm"
                  variant={mode === 'custom' ? 'default' : 'ghost'}
                  className="h-7 rounded-none px-2.5 text-xs"
                  onClick={() => setMode('custom')}
                >
                  Custom Range
                </Button>
              </div>
              {mode === 'rolling' && (
                <div className="flex flex-wrap gap-1.5">
                  {(Object.keys(GRAN) as Granularity[]).map((g) => (
                    <Button
                      key={g}
                      size="sm"
                      variant={granularity === g ? 'default' : 'outline'}
                      className="h-7 px-2.5 text-xs"
                      onClick={() => setGranularity(g)}
                    >
                      {GRAN[g].label}
                    </Button>
                  ))}
                </div>
              )}
            </div>

            {mode === 'custom' && (
              <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3 p-3 rounded-lg border bg-muted/20">
                <DateRangePicker label="Period A" range={rangeA} onChange={setRangeA} maxDate={today} />
                <DateRangePicker label="Period B" range={rangeB} onChange={setRangeB} maxDate={today} />
              </div>
            )}
          </>
        )}
      </CardHeader>
      {!collapsed && (
        <CardContent>
        {loading ? (
          <div className="flex justify-center py-10">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : mode === 'rolling' ? (
          !curr ? (
            <p className="py-10 text-center text-sm text-muted-foreground">No email transactions in this window yet.</p>
          ) : (
            <div className="space-y-4">
              <p className="text-[11px] text-muted-foreground -mt-1">
                Comparing <span className="font-medium text-foreground">{curr.label}</span>
                {prev ? <> vs previous <span className="font-medium text-foreground">{prev.label}</span></> : ' (no prior period)'} · timezone {TZ}
              </p>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                {rollingMetrics.map((m) => (
                  <div key={m.label} className="rounded-lg border bg-muted/30 p-3">
                    <p className="text-[11px] uppercase tracking-wider text-muted-foreground">{m.label}</p>
                    <p className="mt-1 text-base font-bold tabular-nums">{m.fmt(m.curr)}</p>
                    <div className="mt-1 flex items-center justify-between gap-2">
                      <DeltaBadge value={pctChange(m.curr, m.prev)} />
                      <span className="text-[10px] text-muted-foreground">prev {m.fmt(m.prev)}</span>
                    </div>
                  </div>
                ))}
              </div>

              <div className="h-56 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartData} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-border/40" />
                    <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                    <YAxis tick={{ fontSize: 10 }} tickFormatter={(v) => `${(v / 1000).toFixed(0)}k`} />
                    <RTooltip
                      contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid hsl(var(--border))', background: 'hsl(var(--background))' }}
                      formatter={(v: number, n: string) => [fmtUgx(v), n]}
                    />
                    <Bar dataKey="In" fill="hsl(var(--success, 142 71% 45%))" radius={[3, 3, 0, 0]} />
                    <Bar dataKey="Out" fill="hsl(var(--destructive))" radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-muted-foreground border-b">
                      <th className="py-1.5 pr-2 font-medium">{GRAN[granularity].label}</th>
                      <th className="py-1.5 px-2 font-medium text-right">In</th>
                      <th className="py-1.5 px-2 font-medium text-right">Out</th>
                      <th className="py-1.5 px-2 font-medium text-right">Net</th>
                      <th className="py-1.5 px-2 font-medium text-right">Emails</th>
                      <th className="py-1.5 pl-2 font-medium text-right">Net Δ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rollingBuckets.slice().reverse().map((b, i, arr) => {
                      const older = arr[i + 1];
                      return (
                        <tr key={b.key} className="border-b border-border/50 last:border-0">
                          <td className="py-1.5 pr-2 font-medium">{b.label}</td>
                          <td className="py-1.5 px-2 text-right tabular-nums text-emerald-500">{fmtUgx(b.in)}</td>
                          <td className="py-1.5 px-2 text-right tabular-nums text-rose-500">{fmtUgx(b.out)}</td>
                          <td className={`py-1.5 px-2 text-right tabular-nums ${b.net >= 0 ? 'text-foreground' : 'text-rose-500'}`}>{fmtUgx(b.net)}</td>
                          <td className="py-1.5 px-2 text-right tabular-nums text-muted-foreground">{b.count.toLocaleString()}</td>
                          <td className="py-1.5 pl-2 text-right">{older ? <DeltaBadge value={pctChange(b.net, older.net)} /> : <span className="text-[11px] text-muted-foreground">—</span>}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )
        ) : !customReady ? (
          <p className="py-10 text-center text-sm text-muted-foreground">Pick both date ranges to compare.</p>
        ) : !customAgg || (customAgg.a.count === 0 && customAgg.b.count === 0) ? (
          <p className="py-10 text-center text-sm text-muted-foreground">No email transactions found in the selected ranges.</p>
        ) : (
          <div className="space-y-4">
            <p className="text-[11px] text-muted-foreground -mt-1">
              Comparing <span className="font-medium text-foreground">{periodALabel}</span>
              {' vs '}
              <span className="font-medium text-foreground">{periodBLabel}</span>
              {' · timezone '}{TZ}
            </p>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              {customMetrics.map((m) => (
                <div key={m.label} className="rounded-lg border bg-muted/30 p-3">
                  <p className="text-[11px] uppercase tracking-wider text-muted-foreground">{m.label}</p>
                  <p className="mt-1 text-base font-bold tabular-nums">{m.fmt(m.curr)}</p>
                  <div className="mt-1 flex items-center justify-between gap-2">
                    <DeltaBadge value={pctChange(m.curr, m.prev)} />
                    <span className="text-[10px] text-muted-foreground">{periodBLabel.slice(0, 20)}… {m.fmt(m.prev)}</span>
                  </div>
                </div>
              ))}
            </div>

            {/* Simple bar chart of just the two periods */}
            <div className="h-40 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={[
                    { label: 'Period A', In: Math.round(customAgg.a.in), Out: Math.round(customAgg.a.out) },
                    { label: 'Period B', In: Math.round(customAgg.b.in), Out: Math.round(customAgg.b.out) },
                  ]}
                  margin={{ top: 6, right: 8, left: 0, bottom: 0 }}
                >
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border/40" />
                  <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 10 }} tickFormatter={(v) => `${(v / 1000).toFixed(0)}k`} />
                  <RTooltip
                    contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid hsl(var(--border))', background: 'hsl(var(--background))' }}
                    formatter={(v: number, n: string) => [fmtUgx(v), n]}
                  />
                  <Bar dataKey="In" fill="hsl(var(--success, 142 71% 45%))" radius={[3, 3, 0, 0]} />
                  <Bar dataKey="Out" fill="hsl(var(--destructive))" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-muted-foreground border-b">
                    <th className="py-1.5 pr-2 font-medium">Period</th>
                    <th className="py-1.5 px-2 font-medium text-right">In</th>
                    <th className="py-1.5 px-2 font-medium text-right">Out</th>
                    <th className="py-1.5 px-2 font-medium text-right">Net</th>
                    <th className="py-1.5 px-2 font-medium text-right">Emails</th>
                    <th className="py-1.5 pl-2 font-medium text-right"></th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    className="border-b border-border/50 cursor-pointer hover:bg-muted/40 transition-colors"
                    onClick={() => setDrill('a')}
                  >
                    <td className="py-1.5 pr-2 font-medium">{periodALabel}</td>
                    <td className="py-1.5 px-2 text-right tabular-nums text-emerald-500">{fmtUgx(customAgg.a.in)}</td>
                    <td className="py-1.5 px-2 text-right tabular-nums text-rose-500">{fmtUgx(customAgg.a.out)}</td>
                    <td className={`py-1.5 px-2 text-right tabular-nums ${customAgg.a.net >= 0 ? 'text-foreground' : 'text-rose-500'}`}>{fmtUgx(customAgg.a.net)}</td>
                    <td className="py-1.5 px-2 text-right tabular-nums text-muted-foreground">{customAgg.a.count.toLocaleString()}</td>
                    <td className="py-1.5 pl-2 text-right text-muted-foreground">View →</td>
                  </tr>
                  <tr
                    className="cursor-pointer hover:bg-muted/40 transition-colors"
                    onClick={() => setDrill('b')}
                  >
                    <td className="py-1.5 pr-2 font-medium">{periodBLabel}</td>
                    <td className="py-1.5 px-2 text-right tabular-nums text-emerald-500">{fmtUgx(customAgg.b.in)}</td>
                    <td className="py-1.5 px-2 text-right tabular-nums text-rose-500">{fmtUgx(customAgg.b.out)}</td>
                    <td className={`py-1.5 px-2 text-right tabular-nums ${customAgg.b.net >= 0 ? 'text-foreground' : 'text-rose-500'}`}>{fmtUgx(customAgg.b.net)}</td>
                    <td className="py-1.5 px-2 text-right tabular-nums text-muted-foreground">{customAgg.b.count.toLocaleString()}</td>
                    <td className="py-1.5 pl-2 text-right text-muted-foreground">View →</td>
                  </tr>
                </tbody>
              </table>
              <p className="mt-2 text-[11px] text-muted-foreground">Tap a period row to see its exact transactions.</p>
            </div>
          </div>
        )}
      </CardContent>
    )}

      <Sheet open={drill !== null} onOpenChange={(o) => !o && setDrill(null)}>
        <SheetContent side="right" className="w-full sm:max-w-lg flex flex-col">
          <SheetHeader>
            <SheetTitle className="text-sm">
              {drill === 'a' ? 'Period A' : 'Period B'} transactions
            </SheetTitle>
            <SheetDescription className="text-xs">
              {drillLabel} · {drillTx.length.toLocaleString()} emails · timezone {TZ}
            </SheetDescription>
          </SheetHeader>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <div className="rounded-md border bg-muted/30 p-2">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">In</p>
              <p className="text-sm font-bold tabular-nums text-emerald-500">{fmtUgx(drillTotals.in)}</p>
            </div>
            <div className="rounded-md border bg-muted/30 p-2">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Out</p>
              <p className="text-sm font-bold tabular-nums text-rose-500">{fmtUgx(drillTotals.out)}</p>
            </div>
          </div>
          <div className="mt-3 flex-1 overflow-y-auto -mx-2 px-2">
            {drillTx.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">No transactions in this period.</p>
            ) : (
              <ul className="space-y-1.5">
                {drillTx.map((r, i) => {
                  const amt = Number(r.amount) || 0;
                  const isIn = r.direction === 'in';
                  return (
                    <li key={r.id ?? i} className="rounded-md border p-2.5">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate text-xs font-medium">
                            {r.counterparty || r.from_name || r.subject || 'Unknown'}
                          </p>
                          <p className="truncate text-[11px] text-muted-foreground">
                            {r.internal_date ? format(new Date(r.internal_date), 'yyyy-MM-dd HH:mm') : '—'}
                            {r.channel ? ` · ${r.channel}` : ''}
                            {r.transaction_id ? ` · ${r.transaction_id}` : ''}
                          </p>
                        </div>
                        <span className={`shrink-0 text-xs font-semibold tabular-nums ${isIn ? 'text-emerald-500' : 'text-rose-500'}`}>
                          {isIn ? '+' : '−'}{fmtUgx(amt)}
                        </span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </Card>
  );
}
