import { useMemo } from 'react';
import { addDays, endOfDay, format, startOfDay } from 'date-fns';
import { CalendarRange, Users, Banknote } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { formatUGX } from '@/lib/rentCalculations';
import { useTenantRepaymentForecast } from '@/hooks/useTenantRepaymentForecast';

function kampalaToday() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Kampala',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const y = parts.find((p) => p.type === 'year')?.value;
  const m = parts.find((p) => p.type === 'month')?.value;
  const d = parts.find((p) => p.type === 'day')?.value;
  return `${y}-${m}-${d}`;
}

const toDate = (day: string) => new Date(`${day}T12:00:00`);
const compact = (v: number) =>
  v >= 1_000_000 ? `${(v / 1_000_000).toFixed(1)}M` : v >= 1_000 ? `${Math.round(v / 1_000)}K` : `${v}`;

/**
 * Next 7 days (tomorrow → +7), one row per calendar date with the amount the
 * platform expects to collect that day. Figures come straight from
 * `ops_tenant_repayment_forecast` — nothing is recomputed on the client.
 */
export function NextSevenDaysExpected() {
  const today = toDate(kampalaToday());
  const start = startOfDay(addDays(today, 1));
  const end = endOfDay(addDays(today, 7));
  const startIso = format(start, 'yyyy-MM-dd');
  const endIso = format(end, 'yyyy-MM-dd');

  const { data, isLoading, isError } = useTenantRepaymentForecast(startIso, endIso);

  const rows = useMemo(
    () =>
      (data?.daily ?? []).map((r) => ({
        ...r,
        label: format(toDate(r.day), 'EEE dd MMM'),
        short: format(toDate(r.day), 'dd MMM'),
      })),
    [data],
  );

  const total = rows.reduce((s, r) => s + Number(r.scheduled_ugx || 0), 0);
  const peak = rows.reduce((a, b) => (Number(b.scheduled_ugx) > Number(a?.scheduled_ugx ?? -1) ? b : a), rows[0]);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
        <Card className="p-3">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Banknote className="h-3.5 w-3.5" /> Expected · next 7 days
          </div>
          <p className="text-lg font-bold mt-1">{formatUGX(total)}</p>
          <p className="text-[11px] text-muted-foreground">
            {format(start, 'dd MMM')} → {format(end, 'dd MMM')}
          </p>
        </Card>
        <Card className="p-3">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Users className="h-3.5 w-3.5" /> Active plans
          </div>
          <p className="text-lg font-bold mt-1">{data?.drivers?.active_plans ?? 0}</p>
          <p className="text-[11px] text-muted-foreground">
            Avg {formatUGX(Number(data?.drivers?.avg_daily_ugx ?? 0))} per day
          </p>
        </Card>
        <Card className="p-3">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <CalendarRange className="h-3.5 w-3.5" /> Biggest day
          </div>
          <p className="text-lg font-bold mt-1">{peak ? formatUGX(Number(peak.scheduled_ugx)) : formatUGX(0)}</p>
          <p className="text-[11px] text-muted-foreground">{peak ? peak.label : 'No schedule on record'}</p>
        </Card>
      </div>

      <Card className="p-3">
        <div className="flex flex-wrap items-center gap-2 mb-2">
          <h3 className="text-sm font-semibold mr-auto">Expected collections per day</h3>
          <Badge variant="outline" className="text-[10px]">Tomorrow onwards · East Africa Time</Badge>
        </div>

        {isError ? (
          <p className="text-sm text-destructive py-6 text-center">Could not load the forecast.</p>
        ) : isLoading ? (
          <p className="text-sm text-muted-foreground py-6 text-center">Loading forecast…</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground py-6 text-center">Nothing is scheduled in the next 7 days.</p>
        ) : (
          <>
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={rows}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="short" tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
                  <YAxis tickFormatter={compact} tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
                  <Tooltip
                    formatter={(v: any) => [formatUGX(Number(v)), 'Expected']}
                    contentStyle={{ background: 'hsl(var(--popover))', border: '1px solid hsl(var(--border))', borderRadius: 8, fontSize: 11 }}
                  />
                  <Bar dataKey="scheduled_ugx" name="Expected" fill="hsl(var(--primary))" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>

            <div className="mt-3 space-y-2">
              {rows.map((r) => (
                <div
                  key={r.day}
                  className="flex items-center justify-between rounded-lg border border-border/60 bg-muted/20 px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{r.label}</p>
                    <p className="text-[11px] text-muted-foreground">{r.plans} plans due</p>
                  </div>
                  <p className="text-sm font-semibold tabular-nums">{formatUGX(Number(r.scheduled_ugx || 0))}</p>
                </div>
              ))}
            </div>
          </>
        )}

        <p className="text-[11px] text-muted-foreground mt-3">
          Expected amounts come from funded, active rent plans and their daily repayment schedule. Today is excluded —
          it is still counting under the other tabs.
        </p>
      </Card>
    </div>
  );
}

export default NextSevenDaysExpected;
