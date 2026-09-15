import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, Legend, CartesianGrid } from 'recharts';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { LineChart as LineChartIcon } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import type { PromissoryNoteRow } from '@/hooks/usePromissoryOpsReport';

type WindowKey = '7' | '30' | '90';

const WINDOWS: { key: WindowKey; label: string }[] = [
  { key: '7', label: '7 days' },
  { key: '30', label: '30 days' },
  { key: '90', label: '90 days' },
];

const shortDay = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { day: '2-digit', month: 'short' });

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

interface Point {
  day: string;
  receivables: number;
  expected: number;
}

/**
 * Receivables (money from partners who actually came in) vs Expected
 * (promissory notes still open because the partner has not come in yet).
 * Cumulative daily lines over the chosen window.
 */
export function PartnerReceivablesVsExpectedChart() {
  const [win, setWin] = useState<WindowKey>('30');

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

  const rows = useMemo<Point[]>(() => {
    const days = Number(win);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const start = new Date(today);
    start.setDate(start.getDate() - (days - 1));

    // Daily deltas keyed by note creation day.
    const received = new Map<string, number>();
    const expected = new Map<string, number>();
    let baseReceived = 0;
    let baseExpected = 0;

    for (const n of notes ?? []) {
      const created = new Date(n.created_at);
      const key = isoDay(created);
      const cameIn = Boolean(n.came_in);
      const collected = Number(n.total_collected) || 0;
      const promised = Number(n.amount) || 0;
      const openAmount = cameIn ? 0 : Math.max(promised - collected, 0);
      const receivedAmount = cameIn ? (collected > 0 ? collected : promised) : collected;

      if (created < start) {
        baseReceived += receivedAmount;
        baseExpected += openAmount;
        continue;
      }
      received.set(key, (received.get(key) || 0) + receivedAmount);
      expected.set(key, (expected.get(key) || 0) + openAmount);
    }

    const out: Point[] = [];
    let runReceived = baseReceived;
    let runExpected = baseExpected;
    for (let i = 0; i < days; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      const key = isoDay(d);
      runReceived += received.get(key) || 0;
      runExpected += expected.get(key) || 0;
      out.push({ day: key, receivables: Math.round(runReceived), expected: Math.round(runExpected) });
    }
    return out;
  }, [notes, win]);

  const last = rows[rows.length - 1];

  return (
    <Card>
      <CardHeader className="pb-2 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-sm font-bold">
            <LineChartIcon className="h-4 w-4 text-primary" /> Receivables vs expected
          </CardTitle>
          <span className="text-[10px] uppercase tracking-widest text-muted-foreground">
            Came in vs still to come
          </span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {WINDOWS.map((w) => (
            <Button
              key={w.key}
              size="sm"
              variant={win === w.key ? 'default' : 'outline'}
              className="h-7 px-2.5 text-[11px]"
              onClick={() => setWin(w.key)}
            >
              {w.label}
            </Button>
          ))}
        </div>
        <div className="flex flex-wrap gap-4 pt-1">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Receivables in</p>
            <p className="text-lg font-black tabular-nums text-emerald-600">{formatUGX(last?.receivables ?? 0)}</p>
          </div>
          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Expected (not yet in)</p>
            <p className="text-lg font-black tabular-nums text-amber-600">{formatUGX(last?.expected ?? 0)}</p>
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        {isLoading ? (
          <Skeleton className="h-56 w-full" />
        ) : rows.length === 0 ? (
          <p className="py-12 text-center text-xs text-muted-foreground">No promissory activity in this window.</p>
        ) : (
          <div className="h-56 w-full sm:h-64">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={rows} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
                <XAxis dataKey="day" tickFormatter={shortDay} tick={{ fontSize: 10 }} interval="preserveStartEnd" />
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
                  labelFormatter={(l) => shortDay(String(l))}
                />
                <Legend
                  formatter={(v) => (v === 'receivables' ? 'Receivables in' : 'Expected (not yet in)')}
                  wrapperStyle={{ fontSize: 11 }}
                />
                <Line
                  type="monotone"
                  dataKey="receivables"
                  stroke="hsl(142 71% 40%)"
                  strokeWidth={2}
                  dot={false}
                />
                <Line
                  type="monotone"
                  dataKey="expected"
                  stroke="hsl(38 92% 50%)"
                  strokeWidth={2}
                  strokeDasharray="4 4"
                  dot={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
