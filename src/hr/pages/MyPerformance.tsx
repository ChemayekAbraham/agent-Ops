import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { startOfISOWeek, subDays, format } from 'date-fns';
import { FileText, TrendingUp, CalendarDays, BarChart3 } from 'lucide-react';
import PersonalLayout from '@/components/layout/PersonalLayout';
import { MetricCard } from '@/components/MetricCard';
import { supabase } from '@/hr/api/client';
import { cn } from '@/lib/utils';

interface PsoRow {
  staff_id: string;
  staff_ref: string;
  day: string;
  notes_created: number;
  notes_reversed: number;
  net_notes: number;
  partner_registered: number;
}

interface PsoFundedSummary {
  staff_id: string;
  staff_ref: string;
  notes_in_cohort: number;
  notes_funded: number;
  amount_funded: number;
  commission_accrued: number;
  as_at: string;
}

interface PsoCohortRow {
  staff_ref: string;
  days_elapsed: number;
  notes_created: number;
  notes_reversed: number;
  net_notes: number;
  is_me: boolean;
}

type WindowMode = 'DAILY' | 'WEEKLY' | 'MONTHLY';

function getKampalaParts(d: Date): { year: number; month: number; day: number } {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Kampala',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
  };
}

function kampalaDate(d: Date = new Date()): Date {
  const p = getKampalaParts(d);
  return new Date(p.year, p.month - 1, p.day, 12, 0, 0);
}

function formatKampalaDate(d: Date): string {
  const p = getKampalaParts(d);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

function formatKampalaDisplay(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(`${d}T12:00:00`) : d;
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'Africa/Kampala',
  }).format(date);
}

function formatKampalaDateTime(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Africa/Kampala',
  }).format(new Date(iso));
}

function getWindowDates(mode: WindowMode): { from: string; to: string; label: string } {
  const today = kampalaDate();
  const todayStr = formatKampalaDate(today);

  if (mode === 'DAILY') {
    return { from: todayStr, to: todayStr, label: `DAILY · ${formatKampalaDisplay(today)}` };
  }

  if (mode === 'WEEKLY') {
    const monday = startOfISOWeek(today);
    return {
      from: formatKampalaDate(monday),
      to: todayStr,
      label: `WEEKLY · ${formatKampalaDisplay(monday)} – ${formatKampalaDisplay(today)}`,
    };
  }

  const firstOfMonth = new Date(today.getFullYear(), today.getMonth(), 1, 12, 0, 0);
  return {
    from: formatKampalaDate(firstOfMonth),
    to: todayStr,
    label: `MONTHLY · ${formatKampalaDisplay(firstOfMonth)} – ${formatKampalaDisplay(today)}`,
  };
}

async function fetchPsoSeries(from: string, to: string): Promise<PsoRow[]> {
  const { data, error } = (await supabase.rpc('pso_daily_series' as any, {
    p_from: from,
    p_to: to,
  })) as unknown as { data: PsoRow[] | null; error: { message: string } | null };

  if (error) throw new Error(error.message);
  return (data ?? []).sort((a, b) => new Date(a.day).getTime() - new Date(b.day).getTime());
}

export default function MyPerformancePage() {
  const [mode, setMode] = useState<WindowMode>('WEEKLY');
  const { from, to, label } = useMemo(() => getWindowDates(mode), [mode]);

  const {
    data: rows = [],
    isLoading,
    error,
  } = useQuery<PsoRow[]>({
    queryKey: ['pso-daily-series', from, to],
    queryFn: () => fetchPsoSeries(from, to),
  });

  const rollingFrom = useMemo(() => formatKampalaDate(subDays(kampalaDate(), 6)), []);
  const rollingTo = useMemo(() => formatKampalaDate(kampalaDate()), []);

  const {
    data: rollingRows = [],
    isLoading: rollingLoading,
  } = useQuery<PsoRow[]>({
    queryKey: ['pso-daily-series', 'rolling-7', rollingFrom, rollingTo],
    queryFn: () => fetchPsoSeries(rollingFrom, rollingTo),
  });

  const staffRef = rows[0]?.staff_ref;

  const todayStr = useMemo(() => formatKampalaDate(kampalaDate()), []);

  const { todayNet, todayReversals, netSum, rollingAverage, periodAverage } = useMemo(() => {
    const todayRow = rows.find((r) => r.day === todayStr);
    const sum = rows.reduce((acc, r) => acc + (r.net_notes ?? 0), 0);
    const avg = rows.length ? (sum / rows.length).toFixed(1) : '0.0';
    const rollingSum = rollingRows.reduce((acc, r) => acc + (r.net_notes ?? 0), 0);
    const rollingAvg = rollingRows.length ? (rollingSum / rollingRows.length).toFixed(1) : '0.0';
    return {
      todayNet: todayRow?.net_notes ?? 0,
      todayReversals: todayRow?.notes_reversed ?? 0,
      netSum: sum,
      periodAverage: avg,
      rollingAverage: rollingAvg,
    };
  }, [rows, rollingRows, todayStr]);

  const { data: fundedSummary = null } = useQuery<PsoFundedSummary | null>({
    queryKey: ['pso-funded-summary', from, to],
    queryFn: async () => {
      const { data, error } = (await supabase.rpc('pso_funded_summary' as any, {
        p_from: from,
        p_to: to,
      })) as unknown as { data: PsoFundedSummary[] | null; error: { message: string } | null };
      if (error) throw new Error(error.message);
      return data?.[0] ?? null;
    },
  });

  if (error && error.message.toLowerCase().includes('not permitted')) {
    return (
      <PersonalLayout title="My performance">
        <p className="text-sm text-muted-foreground">This screen is for enrolled Platform Sales Officers.</p>
      </PersonalLayout>
    );
  }

  if (isLoading) {
    return (
      <PersonalLayout title="My performance">
        <div className="space-y-4">
          <div className="h-6 w-48 animate-pulse rounded bg-muted" />
          <div className="h-9 w-64 animate-pulse rounded bg-muted" />
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-28 animate-pulse rounded-2xl bg-muted" />
            ))}
          </div>
          <div className="h-48 animate-pulse rounded-2xl bg-muted" />
        </div>
      </PersonalLayout>
    );
  }

  return (
    <PersonalLayout title="My performance">
      <div className="space-y-4">
        {/* Header */}
        <div className="flex flex-wrap items-center gap-2 text-sm font-semibold text-foreground">
          <span>MY PERFORMANCE</span>
          {staffRef && (
            <>
              <span className="text-muted-foreground">·</span>
              <span>{staffRef}</span>
            </>
          )}
          <span className="text-muted-foreground">·</span>
          <span>Platform Sales Officer</span>
          <span className="text-muted-foreground">·</span>
          <span>{label}</span>
          <span className="text-muted-foreground">·</span>
          <span className="text-success">LIVE</span>
          <span className="ml-1 inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
            live figures — nothing is frozen at v1.0
          </span>
        </div>

        {/* Toggle */}
        <div className="inline-flex rounded-lg border border-border bg-card p-1">
          {(['DAILY', 'WEEKLY', 'MONTHLY'] as WindowMode[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={cn(
                'px-3 py-1.5 text-xs font-semibold transition-colors rounded-md',
                mode === m ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {m}
            </button>
          ))}
        </div>

        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No days in this window yet.</p>
        ) : (
          <>
            {/* Zone A */}
            <div>
              <h2 className="mb-3 text-xs font-bold uppercase tracking-wider text-muted-foreground">
                Promissory notes
              </h2>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <div>
                  <MetricCard
                    label="Today, net of reversals"
                    value={todayNet.toString()}
                    icon={FileText}
                    variant="default"
                  />
                  <p className="mt-1 text-[10px] text-muted-foreground">
                    net of {todayReversals} reversals today
                  </p>
                </div>
                <div>
                  <MetricCard
                    label="Period average / day"
                    value={periodAverage}
                    icon={TrendingUp}
                    variant="default"
                  />
                  <p className="mt-1 text-[10px] text-muted-foreground">
                    {netSum} net notes ÷ {rows.length} days elapsed, counted from your appointment date
                  </p>
                </div>
                <div>
                  <MetricCard
                    label="Days elapsed"
                    value={rows.length.toString()}
                    icon={CalendarDays}
                    variant="default"
                  />
                  <p className="mt-1 text-[10px] text-muted-foreground">
                    your series starts on the day you were appointed, not the start of the period
                  </p>
                </div>
                <div>
                  <MetricCard
                    label="Rolling 7-day"
                    value={rollingLoading ? '…' : rollingAverage}
                    icon={BarChart3}
                    variant="default"
                  />
                  <p className="mt-1 text-[10px] text-muted-foreground">
                    ÷ {rollingRows.length} days available, not 7
                  </p>
                </div>
              </div>

              <div className="mt-4 overflow-hidden rounded-2xl border border-border bg-card">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-left">
                    <tr>
                      <th className="px-4 py-2.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                        Day
                      </th>
                      <th className="px-4 py-2.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                        Created
                      </th>
                      <th className="px-4 py-2.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                        Reversed
                      </th>
                      <th className="px-4 py-2.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                        Net
                      </th>
                      <th className="px-4 py-2.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                        Registered
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {rows.map((row) => (
                      <tr key={row.day}>
                        <td className="px-4 py-2.5 tabular-nums">{formatKampalaDisplay(row.day)}</td>
                        <td className="px-4 py-2.5 tabular-nums">{row.notes_created ?? 0}</td>
                        <td className="px-4 py-2.5 tabular-nums">{row.notes_reversed ?? 0}</td>
                        <td className="px-4 py-2.5 tabular-nums">{row.net_notes ?? 0}</td>
                        <td className="px-4 py-2.5 tabular-nums">{row.partner_registered ?? 0}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}

        {/* Zone B */}
        <div className="rounded-2xl border border-border bg-card p-4">
          <h2 className="mb-2 text-xs font-bold uppercase tracking-wider text-muted-foreground">
            Funded sales
          </h2>
          <div className="space-y-1 text-sm">
            <p>Notes in cohort: {fundedSummary?.notes_in_cohort ?? 0}</p>
            <p>Notes funded: {fundedSummary?.notes_funded ?? 0} of {fundedSummary?.notes_in_cohort ?? 0}</p>
            <p>Money funded: UGX {(fundedSummary?.amount_funded ?? 0).toLocaleString('en-UG')}</p>
            <p>Commission accrued: UGX {(fundedSummary?.commission_accrued ?? 0).toLocaleString('en-UG')}</p>
            <p className="text-xs text-muted-foreground">
              as at {fundedSummary ? formatKampalaDateTime(fundedSummary.as_at) : '—'} · a closed period keeps rising, so this figure is never frozen
            </p>
            <p className="text-xs text-muted-foreground">
              funded means the booking carries a funded date, that is money actually deployed
            </p>
          </div>
        </div>
      </div>
    </PersonalLayout>
  );
}
