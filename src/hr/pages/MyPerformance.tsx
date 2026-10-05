import { useEffect, useMemo, useState } from 'react';
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
  notes_unapproved: number;
  notes_funded: number;
  funders_converted: number;
  topups: number;
  amount_deployed: number;
  commission_base: number;
  commission_accrued: number;
  pre_enrolment_notes: number;
  pre_enrolment_funded: number;
  pre_enrolment_amount: number;
  as_at: string;
}

interface PsoCohortRow {
  staff_ref: string;
  mon: number;
  tue: number;
  wed: number;
  thu: number;
  fri: number;
  sat: number;
  sun: number;
  total_net: number;
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

function formatUgxCompact(v: number): string {
  if (v >= 1_000_000) return `UGX ${(v / 1_000_000).toFixed(v >= 10_000_000 ? 0 : 1)}M`;
  if (v >= 1_000) return `UGX ${(v / 1_000).toFixed(0)}K`;
  return `UGX ${v.toLocaleString('en-UG')}`;
}

const WEEKDAY_LETTERS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

function fmtZero(n: number): string | number {
  return n === 0 ? '—' : n;
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

function getWindowDates(mode: WindowMode, todayStr: string): { from: string; to: string; label: string } {
  const today = new Date(`${todayStr}T12:00:00`);

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

async function fetchPsoCohort(from: string, to: string): Promise<PsoCohortRow[]> {
  const { data, error } = (await supabase.rpc('pso_cohort_volume' as any, {
    p_from: from,
    p_to: to,
  })) as unknown as { data: PsoCohortRow[] | null; error: { message: string } | null };

  if (error) throw new Error(error.message);
  return data ?? [];
}

export default function MyPerformancePage() {
  const [mode, setMode] = useState<WindowMode>('WEEKLY');
  const [todayStr, setTodayStr] = useState<string>(() => formatKampalaDate(kampalaDate()));

  useEffect(() => {
    const id = window.setInterval(() => {
      const next = formatKampalaDate(kampalaDate());
      setTodayStr((prev) => (prev === next ? prev : next));
    }, 60000);
    return () => window.clearInterval(id);
  }, []);

  const { from, to, label } = useMemo(() => getWindowDates(mode, todayStr), [mode, todayStr]);

  // Officers have personal figures; reviewers (hr, coo, ceo, super_admin) do not.
  const { data: isOfficer } = useQuery<boolean>({
    queryKey: ['pso-is-officer'],
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('pso_is_officer' as any);
      if (error) return false;
      return data === true;
    },
  });


  const {
    data: rows = [],
    isLoading,
    error,
  } = useQuery<PsoRow[]>({
    queryKey: ['pso-daily-series', todayStr, from, to],
    queryFn: () => fetchPsoSeries(from, to),
    refetchInterval: 60000,
    refetchOnWindowFocus: true,
    refetchIntervalInBackground: false,
  });

  const rollingFrom = useMemo(
    () => formatKampalaDate(subDays(new Date(`${todayStr}T12:00:00`), 6)),
    [todayStr],
  );
  const rollingTo = useMemo(() => todayStr, [todayStr]);

  const {
    data: rollingRows = [],
    isLoading: rollingLoading,
  } = useQuery<PsoRow[]>({
    queryKey: ['pso-daily-series', 'rolling-7', todayStr, rollingFrom, rollingTo],
    queryFn: () => fetchPsoSeries(rollingFrom, rollingTo),
    refetchInterval: 60000,
    refetchOnWindowFocus: true,
    refetchIntervalInBackground: false,
  });

  const staffRef = rows[0]?.staff_ref;

  
  const todayWeekdayIndex = useMemo(() => (new Date(`${todayStr}T12:00:00`).getDay() + 6) % 7, [todayStr]);

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
    queryKey: ['pso-funded-summary', todayStr, from, to],
    queryFn: async () => {
      const { data, error } = (await supabase.rpc('pso_funded_summary' as any, {
        p_from: from,
        p_to: to,
      })) as unknown as { data: PsoFundedSummary[] | null; error: { message: string } | null };
      if (error) throw new Error(error.message);
      return data?.[0] ?? null;
    },
    refetchInterval: 60000,
    refetchOnWindowFocus: true,
    refetchIntervalInBackground: false,
  });

  const {
    data: cohortRows = [],
    isLoading: cohortLoading,
    error: cohortError,
  } = useQuery<PsoCohortRow[]>({
    queryKey: ['pso-cohort-volume', todayStr, from, to],
    queryFn: () => fetchPsoCohort(from, to),
    refetchInterval: 60000,
    refetchOnWindowFocus: true,
    refetchIntervalInBackground: false,
  });

  const rankedCohort = useMemo(() => {
    let rank = 0;
    let prevTotal: number | null = null;
    let position = 0;
    return cohortRows.map((row) => {
      position += 1;
      if (prevTotal === null || row.total_net !== prevTotal) {
        rank = position;
        prevTotal = row.total_net;
      }
      return { ...row, rank };
    });
  }, [cohortRows]);

  if (error && error.message.toLowerCase().includes('not permitted')) {
    return (
      <PersonalLayout title="My performance">
        <p className="text-sm text-muted-foreground">This screen is for enrolled Platform Sales Officers.</p>
      </PersonalLayout>
    );
  }

  if (isOfficer === undefined || isLoading) {
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
      <div className="space-y-4 sm:space-y-6">
        {/* Header */}
        <div className="flex flex-wrap items-center gap-2 text-sm font-semibold text-foreground">
          <span>MY PERFORMANCE</span>
          {isOfficer === true && staffRef && (
            <>
              <span className="text-muted-foreground">·</span>
              <span>{staffRef}</span>
            </>
          )}
          <span className="text-muted-foreground">·</span>
          <span>{isOfficer === true ? 'Platform Sales Officer' : 'reviewer view'}</span>
          <span className="text-muted-foreground">·</span>
          <span>{label}</span>
          <span className="text-muted-foreground">·</span>
          <span className="text-success">LIVE</span>
          <span className="ml-1 inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
            live · refreshes every minute
          </span>
        </div>

        {/* Toggle */}
        <div className="grid w-full grid-cols-3 gap-1 rounded-lg border p-1 sm:inline-grid sm:w-auto">
          {(['DAILY', 'WEEKLY', 'MONTHLY'] as WindowMode[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              style={{ touchAction: 'manipulation', WebkitTapHighlightColor: 'transparent' }}
              className={cn(
                'min-h-11 px-3 text-xs font-semibold tracking-wide rounded-md transition-colors',
                mode === m ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {m}
            </button>
          ))}
        </div>


        {isOfficer !== true ? (
          <div className="rounded-xl border bg-card p-4">
            <p className="text-sm text-muted-foreground">
              You are viewing this as a reviewer, so there are no personal figures here. The leaderboard below is the same one every officer sees.
            </p>
          </div>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No days in this window yet.</p>
        ) : (
          <>
            {/* Zone A */}
            <div>
              <h2 className="mb-3 text-xs font-bold uppercase tracking-wider text-muted-foreground">
                Promissory notes
              </h2>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 sm:gap-3">
                <div>
                  <MetricCard
                    label="Today, net of reversals"
                    value={todayNet.toString()}
                    icon={FileText}
                    variant="default"
                  />
                  <p className="mt-1 text-[10px] leading-snug text-muted-foreground">
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
                  <p className="mt-1 text-[10px] leading-snug text-muted-foreground">
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
                  <p className="mt-1 text-[10px] leading-snug text-muted-foreground">
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
                  <p className="mt-1 text-[10px] leading-snug text-muted-foreground">
                    ÷ {rollingRows.length} days available, not 7
                  </p>
                </div>
              </div>

              <div className="mt-4 space-y-1.5 md:hidden">
                {rows.map((row) => (
                  <div
                    key={row.day}
                    className={cn(
                      'flex items-center justify-between rounded-lg border bg-card px-3 py-2',
                      row.day === todayStr && 'ring-1 ring-border'
                    )}
                  >
                    <span className="text-xs font-medium">{formatKampalaDisplay(row.day)}</span>
                    <div className="flex items-center gap-3">
                      <span className="text-base font-bold tabular-nums">{row.net_notes ?? 0}</span>
                      <div>
                        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Created</div>
                        <div className="text-xs font-semibold tabular-nums">{row.notes_created ?? 0}</div>
                      </div>
                      <div>
                        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Reversed</div>
                        <div className="text-xs font-semibold tabular-nums">{row.notes_reversed ?? 0}</div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              <div className="mt-4 hidden overflow-hidden rounded-2xl border border-border bg-card md:block">

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
        {isOfficer === true && (
        <div className="rounded-2xl border border-border bg-card p-4">
          <h2 className="mb-2 text-xs font-bold uppercase tracking-wider text-muted-foreground">
            Funded sales
          </h2>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Notes in cohort
              </div>
              <div className="text-sm font-bold tabular-nums">{fundedSummary?.notes_in_cohort ?? 0}</div>
            </div>
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Notes funded
              </div>
              <div className="text-sm font-bold tabular-nums">
                {fundedSummary?.notes_funded ?? 0} of {fundedSummary?.notes_in_cohort ?? 0}
              </div>
            </div>
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Money deployed
              </div>
              <div className="text-sm font-bold tabular-nums">
                {formatUgxCompact(fundedSummary?.amount_deployed ?? 0)}
              </div>
            </div>
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Commission accrued
              </div>
              <div className="text-sm font-bold tabular-nums">
                {formatUgxCompact(fundedSummary?.commission_accrued ?? 0)}
              </div>
            </div>
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Funders
              </div>
              <div className="text-sm font-bold tabular-nums">{fundedSummary?.funders_converted ?? 0}</div>
            </div>
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Top-ups
              </div>
              <div className="text-sm font-bold tabular-nums">{fundedSummary?.topups ?? 0}</div>
            </div>
          </div>
          <div className="mt-2 space-y-1">
            <p className="text-xs text-muted-foreground">
              as at {fundedSummary ? formatKampalaDateTime(fundedSummary.as_at) : '—'} · a closed period keeps rising, so this figure is never frozen
            </p>
            <p className="text-xs text-muted-foreground">
              funded means the booking carries a funded date, that is money actually deployed
            </p>
          </div>

        </div>
        )}

        {/* Zone C */}
        {!cohortError && (
          <div className="rounded-2xl border border-border bg-card p-4">
            <h2 className="mb-2 text-xs font-bold uppercase tracking-wider text-muted-foreground">
              LEADERBOARD · PROMISSORY NOTES
            </h2>
            <p className="mb-3 text-xs text-muted-foreground">
              ranked by net notes, highest first · every officer sees this list · staff codes only, no names · no money and no commission appear here
            </p>
            {cohortLoading ? (
              <div className="h-24 animate-pulse rounded-2xl bg-muted" />
            ) : rankedCohort.length === 0 ? (
              <p className="text-sm text-muted-foreground">No officers in this window yet.</p>
            ) : (
              <>
                <div className="space-y-2 md:hidden">
                  {rankedCohort.map((row) => {
                    const days = [row.mon, row.tue, row.wed, row.thu, row.fri, row.sat, row.sun];
                    return (
                      <div
                        key={row.staff_ref}
                        className={cn('rounded-xl border bg-card p-3', row.is_me && 'bg-muted/40')}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <span className="text-xs font-bold tabular-nums text-muted-foreground">
                              #{row.rank}
                            </span>
                            <div className="text-sm font-semibold">
                              {row.staff_ref}
                              {row.is_me && (
                                <span className="ml-2 text-[10px] uppercase tracking-wide text-muted-foreground">
                                  you
                                </span>
                              )}
                            </div>
                          </div>
                          <div className="text-right">
                            <div className="text-2xl font-bold leading-none tabular-nums">
                              {fmtZero(row.total_net ?? 0)}
                            </div>
                            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                              net notes
                            </div>
                          </div>
                        </div>
                        {mode === 'DAILY' ? (
                          <p className="mt-2 text-[11px] text-muted-foreground">today only</p>
                        ) : (
                          <div className="mt-3 grid grid-cols-7 gap-1">
                            {WEEKDAY_LETTERS.map((letter, i) => (
                              <div
                                key={i}
                                className={cn(
                                  'rounded-md bg-muted/40 py-1.5 text-center',
                                  i === todayWeekdayIndex && 'ring-1 ring-border'
                                )}
                              >
                                <div className="text-[10px] font-semibold uppercase text-muted-foreground">
                                  {letter}
                                </div>
                                <div className="text-sm font-semibold tabular-nums">{fmtZero(days[i] ?? 0)}</div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
                <div className="hidden overflow-hidden rounded-2xl border border-border md:block">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/50 text-left">
                      <tr>
                        <th className="px-4 py-2.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">#</th>
                        <th className="px-4 py-2.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Officer</th>
                        <th className="px-4 py-2.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Mon</th>
                        <th className="px-4 py-2.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Tue</th>
                        <th className="px-4 py-2.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Wed</th>
                        <th className="px-4 py-2.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Thu</th>
                        <th className="px-4 py-2.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Fri</th>
                        <th className="px-4 py-2.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Sat</th>
                        <th className="px-4 py-2.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Sun</th>
                        <th className="px-4 py-2.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Total</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {rankedCohort.map((row) => (
                        <tr key={row.staff_ref} className={cn(row.is_me && 'bg-muted/40')}>
                          <td className="px-4 py-2.5 tabular-nums">{row.rank}</td>
                          <td className="px-4 py-2.5">
                            <span className="font-medium">{row.staff_ref}</span>
                            {row.is_me && (
                              <span className="ml-2 text-xs text-muted-foreground">you</span>
                            )}
                          </td>
                          <td className="px-4 py-2.5 tabular-nums">{fmtZero(row.mon ?? 0)}</td>
                          <td className="px-4 py-2.5 tabular-nums">{fmtZero(row.tue ?? 0)}</td>
                          <td className="px-4 py-2.5 tabular-nums">{fmtZero(row.wed ?? 0)}</td>
                          <td className="px-4 py-2.5 tabular-nums">{fmtZero(row.thu ?? 0)}</td>
                          <td className="px-4 py-2.5 tabular-nums">{fmtZero(row.fri ?? 0)}</td>
                          <td className="px-4 py-2.5 tabular-nums">{fmtZero(row.sat ?? 0)}</td>
                          <td className="px-4 py-2.5 tabular-nums">{fmtZero(row.sun ?? 0)}</td>
                          <td className="px-4 py-2.5 tabular-nums">{fmtZero(row.total_net ?? 0)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}

          </div>
        )}
      </div>
    </PersonalLayout>
  );
}
