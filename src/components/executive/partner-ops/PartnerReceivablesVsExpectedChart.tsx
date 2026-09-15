import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, Legend, CartesianGrid,
} from 'recharts';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { LineChart as LineChartIcon, CalendarIcon } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import type { PromissoryNoteRow } from '@/hooks/usePromissoryOpsReport';
import type { DateRange } from 'react-day-picker';

type RangeKey = 'today' | 'yesterday' | 'weekly' | 'monthly' | 'yearly' | 'custom';

const RANGES: { key: RangeKey; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'weekly', label: 'Weekly' },
  { key: 'monthly', label: 'Monthly' },
  { key: 'yearly', label: 'Yearly' },
  { key: 'custom', label: 'Custom' },
];

const shortDay = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { day: '2-digit', month: 'short' });

const fmtDay = (d: Date) => d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });

const isoDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

interface Point {
  day: string;
  receivables: number;
  expected: number;
}

interface Range {
  key: RangeKey;
  start: Date;
  end: Date;
}

const resolveRange = (key: RangeKey, custom: DateRange | undefined): Range => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = new Date(today);
  const end = new Date(today);
  if (key === 'today') {
    // start = today
  } else if (key === 'yesterday') {
    start.setDate(start.getDate() - 1);
    end.setDate(end.getDate() - 1);
  } else if (key === 'weekly') {
    start.setDate(start.getDate() - 6);
  } else if (key === 'monthly') {
    start.setDate(1);
  } else if (key === 'yearly') {
    start.setMonth(0, 1);
  } else {
    const from = custom?.from ? new Date(custom.from) : new Date(today);
    from.setHours(0, 0, 0, 0);
    const to = custom?.to ? new Date(custom.to) : from;
    to.setHours(0, 0, 0, 0);
    return { key, start: from, end: to };
  }
  return { key, start, end };
};

/**
 * Receivables vs Expected, aggregated purely from promissory note data:
 * receivables = money collected on notes whose attached partner CAME IN;
 * expected = outstanding promise on notes still open (pending/activated)
 * whose partner has NOT yet come in. Cancelled/rejected notes excluded.
 * Cumulative lines over the chosen window.
 */
export function PartnerReceivablesVsExpectedChart() {
  const [rangeKey, setRangeKey] = useState<RangeKey>('monthly');
  const [custom, setCustom] = useState<DateRange | undefined>();
  const [pickerOpen, setPickerOpen] = useState(false);

  const { data: notes, isLoading } = useQuery({
    queryKey: ['partner-ops-receivables-vs-expected'],
    staleTime: 60_000,
    queryFn: async (): Promise<PromissoryNoteRow[]> => {
      const { data, error } = await supabase.rpc('get_promissory_ops_report' as any, {
        p_from: null,
        p_to: null,
      });
      if (error) throw error;
      return ((data as any)?.notes ?? []) as PromissoryNoteRow[];
    },
  });

  const range = useMemo(() => resolveRange(rangeKey, custom), [rangeKey, custom]);

  // A window of one day is charted hour by hour so single-day filters still show a shape.
  const hourly = useMemo(() => {
    const { start, end } = range;
    return Math.round((end.getTime() - start.getTime()) / 86_400_000) === 0;
  }, [range]);

  const rows = useMemo<Point[]>(() => {
    const { start, end } = range;
    const windowEnd = new Date(end);
    windowEnd.setHours(23, 59, 59, 999);

    const received = new Map<string, number>();
    const expected = new Map<string, number>();

    for (const n of notes ?? []) {
      const status = String(n.status ?? '').toLowerCase();
      if (status === 'cancelled' || status === 'rejected') continue;

      const promised = Number(n.amount) || 0;
      // Money actually in = what the attached partner has funded (their portfolio),
      // not the note's collection counter (which the notes flow never fills in).
      const fundedIn = n.came_in ? Number(n.portfolio_amount) || 0 : 0;
      const openAmount =
        status === 'pending' || status === 'activated' ? Math.max(promised - fundedIn, 0) : 0;

      // Received money is dated when it came in; the promise is dated when the note was raised.
      const receivedAt = new Date(n.first_portfolio_at ?? n.came_in_at ?? n.created_at);
      const raisedAt = new Date(n.created_at);
      const bucket = (d: Date) => (hourly ? String(d.getHours()) : isoDay(d));
      const inWindow = (d: Date) => d >= start && d <= windowEnd;

      if (fundedIn > 0 && inWindow(receivedAt)) {
        const key = bucket(receivedAt);
        received.set(key, (received.get(key) || 0) + fundedIn);
      }
      if (openAmount > 0 && inWindow(raisedAt)) {
        const key = bucket(raisedAt);
        expected.set(key, (expected.get(key) || 0) + openAmount);
      }
    }


    const out: Point[] = [];
    let runReceived = 0;
    let runExpected = 0;

    if (hourly) {
      for (let h = 0; h < 24; h += 1) {
        const key = String(h);
        runReceived += received.get(key) || 0;
        runExpected += expected.get(key) || 0;
        out.push({ day: `h${h}`, receivables: Math.round(runReceived), expected: Math.round(runExpected) });
      }
      return out;
    }

    for (const d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const key = isoDay(d);
      runReceived += received.get(key) || 0;
      runExpected += expected.get(key) || 0;
      out.push({ day: key, receivables: Math.round(runReceived), expected: Math.round(runExpected) });
    }
    return out;
  }, [notes, range, hourly]);

  const last = rows[rows.length - 1];
  const hasActivity = (last?.receivables ?? 0) > 0 || (last?.expected ?? 0) > 0;

  const tickLabel = (v: string) =>
    hourly ? `${String(v).replace('h', '').padStart(2, '0')}:00` : shortDay(v);

  const customLabel =
    rangeKey === 'custom' && custom?.from
      ? `${fmtDay(custom.from)} – ${custom.to ? fmtDay(custom.to) : fmtDay(custom.from)}`
      : null;

  return (
    <Card>
      <CardHeader className="pb-2 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-sm font-bold">
            <LineChartIcon className="h-4 w-4 text-primary" /> Promissory Notes Receivables vs expected
          </CardTitle>
          <span className="text-[10px] uppercase tracking-widest text-muted-foreground">
            Came in vs still to come
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {RANGES.map((r) =>
            r.key === 'custom' ? (
              <Popover key={r.key} open={pickerOpen} onOpenChange={setPickerOpen}>
                <PopoverTrigger asChild>
                  <Button
                    size="sm"
                    variant={rangeKey === 'custom' ? 'default' : 'outline'}
                    className="h-7 px-2.5 text-[11px]"
                    onClick={() => setRangeKey('custom')}
                  >
                    <CalendarIcon className="mr-1 h-3 w-3" />
                    {customLabel ?? 'Custom'}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar
                    mode="range"
                    selected={custom}
                    onSelect={(r) => {
                      setCustom(r);
                      setRangeKey('custom');
                    }}
                    numberOfMonths={2}
                    initialFocus
                    className="p-3 pointer-events-auto"
                  />
                </PopoverContent>
              </Popover>
            ) : (
              <Button
                key={r.key}
                size="sm"
                variant={rangeKey === r.key ? 'default' : 'outline'}
                className="h-7 px-2.5 text-[11px]"
                onClick={() => setRangeKey(r.key)}
              >
                {r.label}
              </Button>
            ),
          )}
        </div>
        <div className="flex flex-wrap gap-4 pt-1">
          <div className="rounded-md bg-emerald-500/10 px-3 py-1.5">
            <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Receivables in</p>
            <p className="text-lg font-black tabular-nums text-emerald-600">{formatUGX(last?.receivables ?? 0)}</p>
          </div>
          <div className="rounded-md bg-amber-500/10 px-3 py-1.5">
            <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Expected (not yet in)</p>
            <p className="text-lg font-black tabular-nums text-amber-600">{formatUGX(last?.expected ?? 0)}</p>
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        {isLoading ? (
          <Skeleton className="h-56 w-full" />
        ) : rows.length === 0 || !hasActivity ? (
          <p className="py-12 text-center text-xs text-muted-foreground">No promissory activity in this window.</p>
        ) : (
          <div className="h-56 w-full sm:h-64">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={rows} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="receivablesFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="hsl(142 71% 40%)" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="hsl(142 71% 40%)" stopOpacity={0.02} />
                  </linearGradient>
                  <linearGradient id="expectedFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="hsl(38 92% 50%)" stopOpacity={0.30} />
                    <stop offset="100%" stopColor="hsl(38 92% 50%)" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
                <XAxis dataKey="day" tickFormatter={tickLabel} tick={{ fontSize: 10 }} interval="preserveStartEnd" />
                <YAxis
                  tick={{ fontSize: 10 }}
                  tickFormatter={(v) => `${Math.round(Number(v) / 1000)}k`}
                  width={48}
                />
                <Tooltip
                  formatter={(v: number, n: string) => [
                    formatUGX(Number(v)),
                    n === 'receivables' ? 'Receivables in' : 'Expected (not yet in)',
                  ]}
                  labelFormatter={(l) => tickLabel(String(l))}
                />
                <Legend
                  formatter={(v) => (v === 'receivables' ? 'Receivables in' : 'Expected (not yet in)')}
                  wrapperStyle={{ fontSize: 11 }}
                />
                <Area
                  type="monotone"
                  dataKey="receivables"
                  stroke="hsl(142 71% 40%)"
                  strokeWidth={2}
                  fill="url(#receivablesFill)"
                  dot={false}
                />
                <Area
                  type="monotone"
                  dataKey="expected"
                  stroke="hsl(38 92% 50%)"
                  strokeWidth={2}
                  strokeDasharray="4 4"
                  fill="url(#expectedFill)"
                  dot={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
