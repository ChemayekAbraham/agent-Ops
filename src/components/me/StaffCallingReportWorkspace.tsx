import { useMemo, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  BarChart3,
  Calendar,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  Download,
  FileDown,
  FileText,
  Loader2,
  MessageSquare,
  Phone,
  PhoneCall,
  PhoneMissed,
  RefreshCw,
  Search,
  Sparkles,
  Users,
} from 'lucide-react';
import { toast } from 'sonner';
import { kampalaTodayYmd } from '@/lib/kampalaDays';
import {
  addUtcDays,
  buildMonthPeriodWindow,
  buildWeekPeriodWindow,
  formatDayLabel,
  getWedWeekStartYmd,
  listRecentMonths,
  listRecentWedTueWeeks,
  ROLE_LABEL,
  type IndividualStaffReportData,
  type StaffCallingPeriodWindow,
  type StaffReportPeriodMode,
  type TeamCallingReportData,
} from '@/hooks/useStaffCallingReport';
import {
  exportGeneralTeamCallingPdf,
  exportIndividualStaffCallingPdf,
} from '@/lib/staffCallingReportPdf';

const PAGE_SIZE = 25;

export interface PeriodFilterBarProps {
  mode: StaffReportPeriodMode;
  onModeChange: (mode: StaffReportPeriodMode) => void;
  weekStart: string;
  onWeekStartChange: (wedYmd: string) => void;
  yearMonth: string;
  onYearMonthChange: (ym: string) => void;
  periodWindow: StaffCallingPeriodWindow;
  onRefresh?: () => void;
  isFetching?: boolean;
  rightActions?: React.ReactNode;
}

export function CallingReportPeriodBar({
  mode,
  onModeChange,
  weekStart,
  onWeekStartChange,
  yearMonth,
  onYearMonthChange,
  periodWindow,
  onRefresh,
  isFetching,
  rightActions,
}: PeriodFilterBarProps) {
  const todayYmd = kampalaTodayYmd();
  const recentWeeks = useMemo(() => listRecentWedTueWeeks(20, todayYmd), [todayYmd]);
  const recentMonths = useMemo(() => listRecentMonths(15, todayYmd), [todayYmd]);

  const shiftWeek = (deltaWeeks: number) => {
    onWeekStartChange(addUtcDays(weekStart, deltaWeeks * 7));
  };

  const shiftMonth = (deltaMonths: number) => {
    const [y, m] = yearMonth.split('-').map(Number);
    const dt = new Date(Date.UTC(y || 2026, (m || 10) - 1 + deltaMonths, 1));
    const nextYm = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}`;
    onYearMonthChange(nextYm);
  };

  return (
    <Card className="border-primary/20 bg-card/95 shadow-sm">
      <CardContent className="p-4 sm:p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          {/* Left: Mode Toggle + Period Picker */}
          <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
            <div className="inline-flex rounded-lg border border-border bg-muted/40 p-1">
              <button
                type="button"
                onClick={() => onModeChange('month')}
                className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition-all ${
                  mode === 'month'
                    ? 'bg-primary text-primary-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                <Calendar className="h-3.5 w-3.5" />
                Specific Month
              </button>
              <button
                type="button"
                onClick={() => onModeChange('week')}
                className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition-all ${
                  mode === 'week'
                    ? 'bg-primary text-primary-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                <Clock className="h-3.5 w-3.5" />
                Week (Wed - Tue)
              </button>
            </div>

            {mode === 'week' ? (
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => shiftWeek(-1)}
                  title="Previous Wednesday-Tuesday week"
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>

                <select
                  aria-label="Select Wednesday to Tuesday week"
                  value={weekStart}
                  onChange={(e) => onWeekStartChange(e.target.value)}
                  className="h-8 rounded-md border border-input bg-background px-2.5 text-xs font-medium text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  {!recentWeeks.some((w) => w.weekStart === weekStart) && (
                    <option value={weekStart}>{periodWindow.shortLabel}</option>
                  )}
                  {recentWeeks.map((w) => (
                    <option key={w.weekStart} value={w.weekStart}>
                      {w.label}
                    </option>
                  ))}
                </select>

                <Input
                  type="date"
                  aria-label="Pick any date in desired week"
                  value={weekStart}
                  onChange={(e) => {
                    if (e.target.value) {
                      onWeekStartChange(getWedWeekStartYmd(e.target.value));
                    }
                  }}
                  className="h-8 w-[140px] text-xs"
                />

                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => shiftWeek(1)}
                  title="Next Wednesday-Tuesday week"
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>

                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 text-xs"
                  onClick={() => onWeekStartChange(getWedWeekStartYmd(todayYmd))}
                >
                  This week
                </Button>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => shiftMonth(-1)}
                  title="Previous month"
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>

                <select
                  aria-label="Select month"
                  value={yearMonth}
                  onChange={(e) => onYearMonthChange(e.target.value)}
                  className="h-8 rounded-md border border-input bg-background px-2.5 text-xs font-medium text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  {!recentMonths.some((m) => m.yearMonth === yearMonth) && (
                    <option value={yearMonth}>{periodWindow.shortLabel}</option>
                  )}
                  {recentMonths.map((m) => (
                    <option key={m.yearMonth} value={m.yearMonth}>
                      {m.label}
                    </option>
                  ))}
                </select>

                <Input
                  type="month"
                  aria-label="Pick specific month"
                  value={yearMonth}
                  onChange={(e) => {
                    if (e.target.value) onYearMonthChange(e.target.value);
                  }}
                  className="h-8 w-[148px] text-xs"
                />

                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => shiftMonth(1)}
                  title="Next month"
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>

                <Button
                  type="button"
                  variant={yearMonth === '2026-10' ? 'secondary' : 'ghost'}
                  size="sm"
                  className="h-8 text-xs"
                  onClick={() => onYearMonthChange('2026-10')}
                >
                  October 2026
                </Button>
              </div>
            )}
          </div>

          {/* Right: Refresh + PDF Export Actions */}
          <div className="flex flex-wrap items-center gap-2">
            {onRefresh && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onRefresh}
                disabled={isFetching}
                className="h-8 gap-1.5 text-xs"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? 'animate-spin' : ''}`} />
                Refresh
              </Button>
            )}
            {rightActions}
          </div>
        </div>

        {/* Period Window & Kampala Time Banner */}
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-2.5 text-xs text-muted-foreground">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="border-primary/30 bg-primary/5 font-semibold text-primary">
              {periodWindow.periodLabel}
            </Badge>
            <span className="inline-flex items-center gap-1 text-[11px]">
              <Clock className="h-3 w-3 text-primary" />
              Kampala Window: <strong className="font-medium text-foreground">{periodWindow.timeRangeLabel}</strong>
            </span>
          </div>
          <span className="text-[11px]">
            Includes Tenant Ops Calling Center, Landlord Ops Calling Center & Rent Plan Pipelines
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

// ------------------------------------------------------------------ Horizontal Bar Chart Component

function HorizontalBarsCard({
  title,
  subtitle,
  items,
  total,
}: {
  title: string;
  subtitle: string;
  items: Array<{ label: string; value: number; sharePct: number; tone?: 'good' | 'warn' | 'info' | 'primary' }>;
  total: number;
}) {
  const max = Math.max(1, ...items.map((i) => i.value));

  const barClass = (tone?: 'good' | 'warn' | 'info' | 'primary') => {
    if (tone === 'good') return 'bg-emerald-600 dark:bg-emerald-500';
    if (tone === 'warn') return 'bg-amber-600 dark:bg-amber-500';
    if (tone === 'info') return 'bg-sky-600 dark:bg-sky-500';
    return 'bg-primary';
  };

  return (
    <Card className="border-border/70">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold sm:text-base">{title}</CardTitle>
        <CardDescription className="text-xs">{subtitle}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2.5">
        {items.length === 0 ? (
          <p className="py-4 text-center text-xs text-muted-foreground">No entries recorded in this period.</p>
        ) : (
          items.map((it) => {
            const widthPct = Math.max(2, Math.round((it.value / max) * 100));
            const pctOfTotal = total ? Math.round((it.value / total) * 100) : 0;
            return (
              <div key={it.label} className="space-y-1">
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="font-medium text-foreground">{it.label}</span>
                  <span className="shrink-0 font-semibold tabular-nums text-foreground">
                    {it.value.toLocaleString()}{' '}
                    <span className="font-normal text-muted-foreground">({pctOfTotal}%)</span>
                  </span>
                </div>
                <div className="h-2.5 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className={`h-full rounded-full transition-all ${barClass(it.tone)}`}
                    style={{ width: `${widthPct}%` }}
                  />
                </div>
              </div>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}

// ------------------------------------------------------------------ 1. Individual Staff Report Panel

export function IndividualStaffReportPanel({
  data,
  periodWindow,
}: {
  data: IndividualStaffReportData;
  periodWindow: StaffCallingPeriodWindow;
}) {
  const { person, stats: st, channels, outcomes, themes, withWrittenNotesCount, directory, rows, excludedReveals } =
    data;
  const [exporting, setExporting] = useState(false);
  const [dirSearch, setDirSearch] = useState('');
  const [dirPage, setDirPage] = useState(0);
  const [logSearch, setLogSearch] = useState('');
  const [logPage, setLogPage] = useState(0);

  const handleDownloadPdf = async () => {
    try {
      setExporting(true);
      const fileName = await exportIndividualStaffCallingPdf(data, periodWindow);
      toast.success(`Downloaded ${fileName}`);
    } catch (err: any) {
      toast.error(err?.message || 'Failed to generate PDF report');
    } finally {
      setExporting(false);
    }
  };

  const filteredDirectory = useMemo(() => {
    const q = dirSearch.trim().toLowerCase();
    if (!q) return directory;
    return directory.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.phone.toLowerCase().includes(q) ||
        p.roleLabel.toLowerCase().includes(q) ||
        p.lastFeedback.toLowerCase().includes(q),
    );
  }, [directory, dirSearch]);

  const pagedDirectory = useMemo(
    () => filteredDirectory.slice(dirPage * PAGE_SIZE, (dirPage + 1) * PAGE_SIZE),
    [filteredDirectory, dirPage],
  );

  const filteredLogs = useMemo(() => {
    const q = logSearch.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) =>
        r.nm.toLowerCase().includes(q) ||
        r.ph.toLowerCase().includes(q) ||
        r.src.toLowerCase().includes(q) ||
        r.ol.toLowerCase().includes(q) ||
        r.fb.toLowerCase().includes(q) ||
        r.dayKey.includes(q),
    );
  }, [rows, logSearch]);

  const pagedLogs = useMemo(
    () => filteredLogs.slice(logPage * PAGE_SIZE, (logPage + 1) * PAGE_SIZE),
    [filteredLogs, logPage],
  );

  const maxDayTotal = useMemo(() => {
    let m = 1;
    periodWindow.days.forEach((d) => {
      const n = (st.byDay.get(d) || []).length;
      if (n > m) m = n;
    });
    return m;
  }, [periodWindow.days, st.byDay]);

  return (
    <div className="space-y-6">
      {/* Staff Banner Card with PDF Download */}
      <div className="rounded-xl border border-primary/25 bg-gradient-to-r from-primary/10 via-primary/5 to-transparent p-4 sm:p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge className="bg-primary text-primary-foreground">{person.short}</Badge>
              <h2 className="text-base font-bold tracking-tight sm:text-lg">
                Call & Pipeline Feedback Report - {person.display}
              </h2>
            </div>
            <p className="mt-1 text-xs text-muted-foreground sm:text-sm">
              {person.roleLabel} &bull; {periodWindow.periodLabel}
            </p>
          </div>
          <Button
            type="button"
            onClick={handleDownloadPdf}
            disabled={exporting}
            className="gap-2 self-start sm:self-auto"
          >
            {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            Download {person.short}&apos;s PDF Report
          </Button>
        </div>
      </div>

      {/* 6 KPI Summary Cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <Card className="border-l-4 border-l-primary">
          <CardContent className="p-3.5">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Total Calls & Reviews
            </p>
            <p className="mt-1 text-xl font-bold tabular-nums sm:text-2xl">{st.total.toLocaleString()}</p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              {st.known} dialed - {st.reviewOnly} reviews
            </p>
          </CardContent>
        </Card>

        <Card className="border-l-4 border-l-amber-500">
          <CardContent className="p-3.5">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              People Called
            </p>
            <p className="mt-1 text-xl font-bold tabular-nums sm:text-2xl">{st.people.toLocaleString()}</p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">100% with phone numbers</p>
          </CardContent>
        </Card>

        <Card className="border-l-4 border-l-emerald-600">
          <CardContent className="p-3.5">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Reached / Verified
            </p>
            <p className="mt-1 text-xl font-bold tabular-nums text-emerald-600 dark:text-emerald-400 sm:text-2xl">
              {st.reached.toLocaleString()} ({st.reachPct}%)
            </p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">answered / verified</p>
          </CardContent>
        </Card>

        <Card className="border-l-4 border-l-orange-500">
          <CardContent className="p-3.5">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Not Reached
            </p>
            <p className="mt-1 text-xl font-bold tabular-nums text-orange-600 dark:text-orange-400 sm:text-2xl">
              {st.notReached.toLocaleString()}
            </p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">phone off, no answer, wrong no.</p>
          </CardContent>
        </Card>

        <Card className="border-l-4 border-l-primary">
          <CardContent className="p-3.5">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Active Days
            </p>
            <p className="mt-1 text-xl font-bold tabular-nums sm:text-2xl">
              {st.activeDays} of {periodWindow.days.length}
            </p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">{periodWindow.shortLabel}</p>
          </CardContent>
        </Card>

        <Card className="border-l-4 border-l-amber-500">
          <CardContent className="p-3.5">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Avg / Active Day
            </p>
            <p className="mt-1 text-xl font-bold tabular-nums sm:text-2xl">{st.avg.toFixed(1)}</p>
            <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
              {st.busiest ? `Peak: ${formatDayLabel(st.busiest.day)} (${st.busiest.n})` : 'No active day'}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Section 1: Daily Activity Bar Chart */}
      <Card className="border-border/70">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm font-semibold sm:text-base">
            <BarChart3 className="h-4 w-4 text-primary" />
            1 - Daily Call & Pipeline Activity ({periodWindow.shortLabel})
          </CardTitle>
          <CardDescription className="text-xs">
            Calls and Rent Plan pipeline reviews grouped by Africa/Kampala calendar day
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-end gap-1.5 overflow-x-auto pb-2 pt-4">
            {periodWindow.days.map((d) => {
              const a = st.byDay.get(d) || [];
              const rch = a.filter((r) => r.answered === true || r.outcome === 'review recorded').length;
              const nr = a.length - rch;
              const rchH = Math.round((rch / maxDayTotal) * 96);
              const nrH = Math.round((nr / maxDayTotal) * 96);
              return (
                <div key={d} className="flex min-w-[34px] flex-1 flex-col items-center gap-1">
                  <span className="text-[10px] font-bold tabular-nums text-foreground">
                    {a.length > 0 ? a.length : ''}
                  </span>
                  <div className="flex h-24 w-full max-w-[26px] flex-col justify-end overflow-hidden rounded-t bg-muted/40">
                    {nr > 0 && (
                      <div
                        className="w-full bg-amber-400 transition-all"
                        style={{ height: `${ Math.max(3, nrH) }px` }}
                        title={`${formatDayLabel(d, true)}: ${nr} not reached`}
                      />
                    )}
                    {rch > 0 && (
                      <div
                        className="w-full bg-primary transition-all"
                        style={{ height: `${ Math.max(3, rchH) }px` }}
                        title={`${formatDayLabel(d, true)}: ${rch} reached / reviewed`}
                      />
                    )}
                  </div>
                  <span className="text-[10px] text-muted-foreground">{formatDayLabel(d)}</span>
                </div>
              );
            })}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <span className="h-3 w-3 rounded-sm bg-primary" />
              Reached / pipeline feedback recorded
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-3 w-3 rounded-sm bg-amber-400" />
              Not reached (phone off / no answer / failed)
            </span>
          </div>
        </CardContent>
      </Card>

      {/* Section 2: Where calls & pipeline feedback were recorded */}
      <Card className="border-border/70">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold sm:text-base">
            2 - Where Calls & Pipeline Feedback Were Recorded
          </CardTitle>
          <CardDescription className="text-xs">
            Breakdown across Tenant Ops Calling Center, Landlord Ops Calling Center, Inbound calls & Rent Plan pipelines
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0 sm:p-6 sm:pt-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Channel / Pipeline Stage</TableHead>
                  <TableHead className="text-center">Calls / Entries</TableHead>
                  <TableHead className="text-center">Share</TableHead>
                  <TableHead className="text-center">Reached</TableHead>
                  <TableHead className="text-center">Reach Rate</TableHead>
                  <TableHead className="text-center">With Written Feedback</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {channels.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="py-6 text-center text-xs text-muted-foreground">
                      No calls or pipeline reviews recorded in this period.
                    </TableCell>
                  </TableRow>
                ) : (
                  channels.map((c) => (
                    <TableRow key={c.source}>
                      <TableCell className="font-medium">{c.source}</TableCell>
                      <TableCell className="text-center font-semibold tabular-nums">{c.count}</TableCell>
                      <TableCell className="text-center tabular-nums">{c.sharePct}%</TableCell>
                      <TableCell className="text-center tabular-nums">{c.known ? c.reached : '-'}</TableCell>
                      <TableCell className="text-center tabular-nums">
                        {c.reachPct !== null ? `${c.reachPct}%` : 'Pipeline review'}
                      </TableCell>
                      <TableCell className="text-center tabular-nums">{c.withNotes}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* Section 3: Feedback & outcomes at a glance */}
      <div className="grid gap-4 lg:grid-cols-2">
        <HorizontalBarsCard
          title="3A - Call & Pipeline Outcomes at a Glance"
          subtitle={`Outcome distribution across all ${st.total.toLocaleString()} entries`}
          items={outcomes}
          total={st.total}
        />
        <HorizontalBarsCard
          title={`3B - Themes in What People Told ${person.short}`}
          subtitle={`Recurring themes across ${withWrittenNotesCount.toLocaleString()} entries with written feedback`}
          items={themes.map((t) => ({ ...t, tone: 'primary' }))}
          total={withWrittenNotesCount}
        />
      </div>

      {/* Section 4: Day-by-Day Table */}
      <Card className="border-border/70">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold sm:text-base">
            4 - Day by Day - Dates, Call Counts & Daily Feedback Summary
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0 sm:p-6 sm:pt-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date (Kampala)</TableHead>
                  <TableHead className="text-center">Calls</TableHead>
                  <TableHead className="text-center">People Called</TableHead>
                  <TableHead className="text-center">Reached</TableHead>
                  <TableHead className="text-center">Not Reached</TableHead>
                  <TableHead className="text-center">Pipeline Reviews</TableHead>
                  <TableHead>Daily Outcome Breakdown</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {periodWindow.days.map((d) => {
                  const a = st.byDay.get(d) || [];
                  if (!a.length) {
                    return (
                      <TableRow key={d} className="text-muted-foreground">
                        <TableCell className="whitespace-nowrap text-xs">{formatDayLabel(d, true)}</TableCell>
                        <TableCell className="text-center text-xs">-</TableCell>
                        <TableCell className="text-center text-xs">-</TableCell>
                        <TableCell className="text-center text-xs">-</TableCell>
                        <TableCell className="text-center text-xs">-</TableCell>
                        <TableCell className="text-center text-xs">-</TableCell>
                        <TableCell className="text-xs">No calls recorded</TableCell>
                      </TableRow>
                    );
                  }
                  const people = new Set(a.map((r) => r.pk)).size;
                  const rch = a.filter((r) => r.answered === true).length;
                  const nr = a.filter((r) => r.answered === false).length;
                  const rev = a.filter((r) => r.answered === null || r.answered === undefined).length;
                  const top = new Map<string, number>();
                  a.forEach((r) => top.set(r.ol, (top.get(r.ol) || 0) + 1));
                  const topTxt = [...top.entries()]
                    .sort((x, y) => y[1] - x[1])
                    .slice(0, 4)
                    .map(([k, v]) => `${k}: ${v}`)
                    .join('  -  ');
                  return (
                    <TableRow key={d}>
                      <TableCell className="whitespace-nowrap text-xs font-medium">{formatDayLabel(d, true)}</TableCell>
                      <TableCell className="text-center text-xs font-semibold tabular-nums">{a.length}</TableCell>
                      <TableCell className="text-center text-xs tabular-nums">{people}</TableCell>
                      <TableCell className="text-center text-xs font-medium tabular-nums text-emerald-600 dark:text-emerald-400">
                        {rch}
                      </TableCell>
                      <TableCell className="text-center text-xs tabular-nums text-orange-600 dark:text-orange-400">
                        {nr}
                      </TableCell>
                      <TableCell className="text-center text-xs tabular-nums">{rev || '-'}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{topTxt}</TableCell>
                    </TableRow>
                  );
                })}
                <TableRow className="bg-primary/5 font-bold">
                  <TableCell className="text-xs">Total ({periodWindow.shortLabel})</TableCell>
                  <TableCell className="text-center text-xs tabular-nums">{st.total}</TableCell>
                  <TableCell className="text-center text-xs tabular-nums">{st.people}</TableCell>
                  <TableCell className="text-center text-xs tabular-nums">{st.reached}</TableCell>
                  <TableCell className="text-center text-xs tabular-nums">{st.notReached}</TableCell>
                  <TableCell className="text-center text-xs tabular-nums">{st.reviewOnly || '-'}</TableCell>
                  <TableCell />
                </TableRow>
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* Section 5: Directory of People Called (with Phone Numbers) */}
      <Card className="border-border/70">
        <CardHeader className="pb-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle className="text-sm font-semibold sm:text-base">
                5 - Directory of People Called ({directory.length.toLocaleString()} distinct phone numbers)
              </CardTitle>
              <CardDescription className="text-xs">
                Every person called by {person.short} with their verified phone number, call count & latest feedback
              </CardDescription>
            </div>
            <div className="relative w-full sm:w-64">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                placeholder="Search name, phone or feedback..."
                value={dirSearch}
                onChange={(e) => {
                  setDirSearch(e.target.value);
                  setDirPage(0);
                }}
                className="h-8 pl-8 text-xs"
              />
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0 sm:p-6 sm:pt-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10 text-center">#</TableHead>
                  <TableHead>Person Called</TableHead>
                  <TableHead>Phone Number</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead className="text-center">Calls</TableHead>
                  <TableHead className="text-center">Reached</TableHead>
                  <TableHead>First Date</TableHead>
                  <TableHead>Last Date</TableHead>
                  <TableHead>Last Outcome</TableHead>
                  <TableHead>Latest Feedback Summary</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pagedDirectory.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={10} className="py-6 text-center text-xs text-muted-foreground">
                      No matching people found.
                    </TableCell>
                  </TableRow>
                ) : (
                  pagedDirectory.map((p, idx) => (
                    <TableRow key={`${p.phone}-${p.name}-${idx}`}>
                      <TableCell className="text-center text-xs text-muted-foreground">
                        {dirPage * PAGE_SIZE + idx + 1}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs font-medium">{p.name}</TableCell>
                      <TableCell className="whitespace-nowrap font-mono text-xs font-semibold text-primary">
                        {p.phone}
                      </TableCell>
                      <TableCell className="text-xs">{p.roleLabel}</TableCell>
                      <TableCell className="text-center text-xs tabular-nums">{p.calls}</TableCell>
                      <TableCell className="text-center text-xs tabular-nums">{p.reached}</TableCell>
                      <TableCell className="whitespace-nowrap text-xs">
                        {formatDayLabel(p.firstDay, true).slice(4)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs">
                        {formatDayLabel(p.lastDay, true).slice(4)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs">{p.lastOutcome}</TableCell>
                      <TableCell className="max-w-md text-xs text-muted-foreground">{p.lastFeedback}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
          {filteredDirectory.length > PAGE_SIZE && (
            <div className="flex items-center justify-between border-t border-border/60 px-4 py-3 text-xs text-muted-foreground">
              <span>
                Showing {dirPage * PAGE_SIZE + 1} -{' '}
                {Math.min((dirPage + 1) * PAGE_SIZE, filteredDirectory.length)} of{' '}
                {filteredDirectory.length.toLocaleString()} people (PDF export includes all {directory.length.toLocaleString()})
              </span>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  disabled={dirPage === 0}
                  onClick={() => setDirPage((p) => Math.max(0, p - 1))}
                >
                  Previous
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  disabled={(dirPage + 1) * PAGE_SIZE >= filteredDirectory.length}
                  onClick={() => setDirPage((p) => p + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Section 6: Complete Chronological Call & Pipeline Feedback Log */}
      <Card className="border-border/70">
        <CardHeader className="pb-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle className="text-sm font-semibold sm:text-base">
                6 - Complete Chronological Call & Pipeline Feedback Log ({rows.length.toLocaleString()} entries)
              </CardTitle>
              <CardDescription className="text-xs">
                Every call and Rent Plan pipeline review with date, Kampala time, phone number, outcome & recorded feedback
              </CardDescription>
            </div>
            <div className="relative w-full sm:w-64">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                placeholder="Filter calls by name, number, note..."
                value={logSearch}
                onChange={(e) => {
                  setLogSearch(e.target.value);
                  setLogPage(0);
                }}
                className="h-8 pl-8 text-xs"
              />
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0 sm:p-6 sm:pt-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date & Time</TableHead>
                  <TableHead>Person Called</TableHead>
                  <TableHead>Phone Number</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Channel / Pipeline Stage</TableHead>
                  <TableHead>Outcome</TableHead>
                  <TableHead>Recorded Feedback & Notes</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pagedLogs.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="py-6 text-center text-xs text-muted-foreground">
                      No matching call entries found.
                    </TableCell>
                  </TableRow>
                ) : (
                  pagedLogs.map((r, idx) => (
                    <TableRow key={`${r.ts}-${r.phone9}-${idx}`}>
                      <TableCell className="whitespace-nowrap text-xs font-medium">
                        {formatDayLabel(r.dayKey, true).slice(4)} &bull; {r.hhmm}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs font-medium">{r.nm}</TableCell>
                      <TableCell className="whitespace-nowrap font-mono text-xs font-semibold text-primary">
                        {r.ph || '-'}
                      </TableCell>
                      <TableCell className="text-xs">{ROLE_LABEL[r.role] || r.role}</TableCell>
                      <TableCell className="whitespace-nowrap text-xs">{r.src}</TableCell>
                      <TableCell className="whitespace-nowrap text-xs font-medium">{r.ol}</TableCell>
                      <TableCell className="max-w-lg text-xs text-muted-foreground">{r.fb}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
          {filteredLogs.length > PAGE_SIZE && (
            <div className="flex items-center justify-between border-t border-border/60 px-4 py-3 text-xs text-muted-foreground">
              <span>
                Showing {logPage * PAGE_SIZE + 1} -{' '}
                {Math.min((logPage + 1) * PAGE_SIZE, filteredLogs.length)} of{' '}
                {filteredLogs.length.toLocaleString()} entries (PDF export includes all {rows.length.toLocaleString()})
              </span>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  disabled={logPage === 0}
                  onClick={() => setLogPage((p) => Math.max(0, p - 1))}
                >
                  Previous
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  disabled={(logPage + 1) * PAGE_SIZE >= filteredLogs.length}
                  onClick={() => setLogPage((p) => p + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <p className="text-[11px] text-muted-foreground">
        Methodology: Duplicate records of the same staff member phoning the same person or reviewing the same role on the
        same Rent Plan within 15 minutes are merged into one entry so no call is double-counted and no feedback is lost.
        Excluded: {excludedReveals} Calling Center phone-reveals where no call outcome was submitted.
      </p>
    </div>
  );
}

// ------------------------------------------------------------------ 2. General / Team Report Panel

export function GeneralTeamReportPanel({
  teamData,
  periodWindow,
  onSelectStaffTab,
}: {
  teamData: TeamCallingReportData;
  periodWindow: StaffCallingPeriodWindow;
  onSelectStaffTab?: (staffId: string) => void;
}) {
  const {
    rows: all,
    stats: st,
    perStaff,
    outcomes,
    themes,
    withWrittenNotesCount,
    ccCategories,
    ccReachedWithFeedbackCount,
    awareness,
    pipelineDesks,
    verbatimSamples,
  } = teamData;

  const [exportingGeneral, setExportingGeneral] = useState(false);
  const [exportingAll, setExportingAll] = useState(false);
  const [exportingStaffId, setExportingStaffId] = useState<string | null>(null);

  const handleDownloadGeneralPdf = async () => {
    try {
      setExportingGeneral(true);
      const fileName = await exportGeneralTeamCallingPdf(teamData, periodWindow);
      toast.success(`Downloaded ${fileName}`);
    } catch (err: any) {
      toast.error(err?.message || 'Failed to generate General Team PDF');
    } finally {
      setExportingGeneral(false);
    }
  };

  const handleDownloadStaffPdf = async (staffReport: IndividualStaffReportData) => {
    try {
      setExportingStaffId(staffReport.person.id);
      const fileName = await exportIndividualStaffCallingPdf(staffReport, periodWindow);
      toast.success(`Downloaded ${fileName}`);
    } catch (err: any) {
      toast.error(err?.message || 'Failed to generate staff PDF');
    } finally {
      setExportingStaffId(null);
    }
  };

  const handleDownloadAllFourPdfs = async () => {
    try {
      setExportingAll(true);
      await exportGeneralTeamCallingPdf(teamData, periodWindow);
      for (const s of perStaff) {
        await exportIndividualStaffCallingPdf(s, periodWindow);
      }
      toast.success('Downloaded all 4 PDF reports (General Team + Winnie, Hanisha & Jane)');
    } catch (err: any) {
      toast.error(err?.message || 'Failed to download all PDFs');
    } finally {
      setExportingAll(false);
    }
  };

  const sources = useMemo(
    () =>
      [...new Set(all.map((r) => r.src))].sort(
        (a, b) => all.filter((r) => r.src === b).length - all.filter((r) => r.src === a).length,
      ),
    [all],
  );

  return (
    <div className="space-y-6">
      {/* Team Banner with PDF Exports */}
      <div className="rounded-xl border border-primary/25 bg-gradient-to-r from-primary/10 via-primary/5 to-transparent p-4 sm:p-5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge className="bg-primary text-primary-foreground">General Team Report</Badge>
              <h2 className="text-base font-bold tracking-tight sm:text-lg">
                Team Call & Pipeline Feedback Report - Jane, Winnie & Hanisha
              </h2>
            </div>
            <p className="mt-1 text-xs text-muted-foreground sm:text-sm">
              Tenant Ops & Landlord Ops Calling Centers + Rent Plan Pipelines &bull; {periodWindow.periodLabel}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              onClick={handleDownloadGeneralPdf}
              disabled={exportingGeneral || exportingAll}
              className="gap-2"
            >
              {exportingGeneral ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              Download General Team PDF
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={handleDownloadAllFourPdfs}
              disabled={exportingAll || exportingGeneral}
              className="gap-2 border-primary/30"
            >
              {exportingAll ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileDown className="h-4 w-4" />}
              Download All 4 PDFs
            </Button>
          </div>
        </div>
      </div>

      {/* 6 Team KPI Cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <Card className="border-l-4 border-l-primary">
          <CardContent className="p-3.5">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Total Calls & Reviews
            </p>
            <p className="mt-1 text-xl font-bold tabular-nums sm:text-2xl">{st.total.toLocaleString()}</p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              {st.known} dialed - {st.reviewOnly} pipeline reviews
            </p>
          </CardContent>
        </Card>

        <Card className="border-l-4 border-l-amber-500">
          <CardContent className="p-3.5">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              People Called
            </p>
            <p className="mt-1 text-xl font-bold tabular-nums sm:text-2xl">{st.people.toLocaleString()}</p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">100% with phone numbers</p>
          </CardContent>
        </Card>

        <Card className="border-l-4 border-l-emerald-600">
          <CardContent className="p-3.5">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Reached / Verified
            </p>
            <p className="mt-1 text-xl font-bold tabular-nums text-emerald-600 dark:text-emerald-400 sm:text-2xl">
              {st.reached.toLocaleString()} ({st.reachPct}%)
            </p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">person answered the call</p>
          </CardContent>
        </Card>

        <Card className="border-l-4 border-l-orange-500">
          <CardContent className="p-3.5">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Not Reached
            </p>
            <p className="mt-1 text-xl font-bold tabular-nums text-orange-600 dark:text-orange-400 sm:text-2xl">
              {st.notReached.toLocaleString()}
            </p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">phone off, no answer, wrong no.</p>
          </CardContent>
        </Card>

        <Card className="border-l-4 border-l-primary">
          <CardContent className="p-3.5">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Active Calling Days
            </p>
            <p className="mt-1 text-xl font-bold tabular-nums sm:text-2xl">
              {st.activeDays} of {periodWindow.days.length}
            </p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">{periodWindow.shortLabel}</p>
          </CardContent>
        </Card>

        <Card className="border-l-4 border-l-amber-500">
          <CardContent className="p-3.5">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Busiest Team Day
            </p>
            <p className="mt-1 text-xl font-bold tabular-nums sm:text-2xl">
              {st.busiest ? formatDayLabel(st.busiest.day) : '-'}
            </p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              {st.busiest ? `${st.busiest.n} calls & reviews` : 'No calls recorded'}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Section 1: Team Scoreboard */}
      <Card className="border-border/70">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm font-semibold sm:text-base">
            <Users className="h-4 w-4 text-primary" />
            1 - Team Scoreboard ({periodWindow.shortLabel})
          </CardTitle>
          <CardDescription className="text-xs">
            Side-by-side results for Winnie, Hanisha & Jane with direct individual PDF exports
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0 sm:p-6 sm:pt-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Staff Member</TableHead>
                  <TableHead className="text-center">Total Entries</TableHead>
                  <TableHead className="text-center">People Called (Numbers)</TableHead>
                  <TableHead className="text-center">Reached</TableHead>
                  <TableHead className="text-center">Not Reached</TableHead>
                  <TableHead className="text-center">Pipeline Reviews</TableHead>
                  <TableHead className="text-center">Reach Rate</TableHead>
                  <TableHead className="text-center">Active Days</TableHead>
                  <TableHead className="text-center">Avg / Day</TableHead>
                  <TableHead className="text-center">Tenants</TableHead>
                  <TableHead className="text-center">Landlords</TableHead>
                  <TableHead className="text-right">Staff PDF</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {perStaff.map((sr) => {
                  const { person: p, stats: s, rows: rs } = sr;
                  return (
                    <TableRow key={p.id}>
                      <TableCell className="whitespace-nowrap font-medium">
                        {onSelectStaffTab ? (
                          <button
                            type="button"
                            onClick={() => onSelectStaffTab(p.id)}
                            className="text-left font-semibold text-primary hover:underline"
                          >
                            {p.short} - {p.display}
                          </button>
                        ) : (
                          <span>
                            {p.short} - {p.display}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-center font-bold tabular-nums">{s.total}</TableCell>
                      <TableCell className="text-center tabular-nums">{s.people}</TableCell>
                      <TableCell className="text-center font-medium tabular-nums text-emerald-600 dark:text-emerald-400">
                        {s.reached}
                      </TableCell>
                      <TableCell className="text-center tabular-nums text-orange-600 dark:text-orange-400">
                        {s.notReached}
                      </TableCell>
                      <TableCell className="text-center tabular-nums">{s.reviewOnly || '-'}</TableCell>
                      <TableCell className="text-center font-semibold tabular-nums">{s.reachPct}%</TableCell>
                      <TableCell className="text-center tabular-nums">{s.activeDays}</TableCell>
                      <TableCell className="text-center tabular-nums">{s.avg.toFixed(1)}</TableCell>
                      <TableCell className="text-center tabular-nums">
                        {rs.filter((r) => r.role === 'tenant').length}
                      </TableCell>
                      <TableCell className="text-center tabular-nums">
                        {rs.filter((r) => r.role === 'landlord').length}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-7 gap-1 text-xs"
                          disabled={exportingStaffId === p.id}
                          onClick={() => handleDownloadStaffPdf(sr)}
                        >
                          {exportingStaffId === p.id ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <Download className="h-3 w-3" />
                          )}
                          PDF
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
                <TableRow className="bg-primary/5 font-bold">
                  <TableCell>Team Total</TableCell>
                  <TableCell className="text-center tabular-nums">{st.total}</TableCell>
                  <TableCell className="text-center tabular-nums">{st.people}</TableCell>
                  <TableCell className="text-center tabular-nums">{st.reached}</TableCell>
                  <TableCell className="text-center tabular-nums">{st.notReached}</TableCell>
                  <TableCell className="text-center tabular-nums">{st.reviewOnly}</TableCell>
                  <TableCell className="text-center tabular-nums">{st.reachPct}%</TableCell>
                  <TableCell className="text-center tabular-nums">{st.activeDays}</TableCell>
                  <TableCell className="text-center tabular-nums">{st.avg.toFixed(1)}</TableCell>
                  <TableCell className="text-center tabular-nums">
                    {all.filter((r) => r.role === 'tenant').length}
                  </TableCell>
                  <TableCell className="text-center tabular-nums">
                    {all.filter((r) => r.role === 'landlord').length}
                  </TableCell>
                  <TableCell />
                </TableRow>
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* Section 2: Where calls & Rent Plan pipeline feedback were recorded */}
      <Card className="border-border/70">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold sm:text-base">
            2 - Where Calls & Rent Plan Pipeline Feedback Were Recorded
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0 sm:p-6 sm:pt-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Channel / Pipeline Stage</TableHead>
                  {perStaff.map((s) => (
                    <TableHead key={s.person.id} className="text-center">
                      {s.person.short}
                    </TableHead>
                  ))}
                  <TableHead className="text-center">Team Total</TableHead>
                  <TableHead className="text-center">Share</TableHead>
                  <TableHead className="text-center">Reached</TableHead>
                  <TableHead className="text-center">Reach Rate</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sources.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={perStaff.length + 5} className="py-6 text-center text-xs text-muted-foreground">
                      No calls recorded in this period.
                    </TableCell>
                  </TableRow>
                ) : (
                  sources.map((src) => {
                    const a = all.filter((r) => r.src === src);
                    const known = a.filter((r) => r.answered !== null && r.answered !== undefined);
                    const rch = known.filter((r) => r.answered).length;
                    return (
                      <TableRow key={src}>
                        <TableCell className="font-medium">{src}</TableCell>
                        {perStaff.map((s) => (
                          <TableCell key={s.person.id} className="text-center tabular-nums">
                            {s.rows.filter((r) => r.src === src).length || '-'}
                          </TableCell>
                        ))}
                        <TableCell className="text-center font-semibold tabular-nums">{a.length}</TableCell>
                        <TableCell className="text-center tabular-nums">
                          {st.total ? `${Math.round((a.length / st.total) * 100)}%` : '0%'}
                        </TableCell>
                        <TableCell className="text-center tabular-nums">{known.length ? rch : '-'}</TableCell>
                        <TableCell className="text-center tabular-nums">
                          {known.length ? `${Math.round((rch / known.length) * 100)}%` : 'Pipeline review'}
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* Section 4: Feedback & Outcomes at a Glance (Team Data) */}
      <div className="grid gap-4 lg:grid-cols-2">
        <HorizontalBarsCard
          title="3 - Call & Pipeline Outcomes at a Glance (Team Data)"
          subtitle={`Across all ${st.total.toLocaleString()} team calls & pipeline reviews`}
          items={outcomes}
          total={st.total}
        />
        <HorizontalBarsCard
          title="4 - Themes in Written Feedback Across the Team"
          subtitle={`Recurring themes across ${withWrittenNotesCount.toLocaleString()} entries with written feedback`}
          items={themes.map((t) => ({ ...t, tone: 'primary' }))}
          total={withWrittenNotesCount}
        />
      </div>

      {/* Section 5: Written Feedback Themes Breakdown by Staff Member */}
      <Card className="border-border/70">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold sm:text-base">
            5 - Themes in Written Call & Pipeline Feedback by Staff Member
          </CardTitle>
          <CardDescription className="text-xs">
            What tenants and landlords told the team across {withWrittenNotesCount.toLocaleString()} entries with written notes
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0 sm:p-6 sm:pt-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Feedback Theme</TableHead>
                  {perStaff.map((s) => (
                    <TableHead key={s.person.id} className="text-center">
                      {s.person.short}
                    </TableHead>
                  ))}
                  <TableHead className="text-center">Team Mentions</TableHead>
                  <TableHead className="text-center">% of Calls with Feedback</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {themes.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={perStaff.length + 3} className="py-6 text-center text-xs text-muted-foreground">
                      No written feedback themes recorded in this period.
                    </TableCell>
                  </TableRow>
                ) : (
                  themes.map((t) => (
                    <TableRow key={t.label}>
                      <TableCell className="font-medium">{t.label}</TableCell>
                      {perStaff.map((s) => (
                        <TableCell key={s.person.id} className="text-center tabular-nums">
                          {t.byStaff[s.person.short] || '-'}
                        </TableCell>
                      ))}
                      <TableCell className="text-center font-semibold tabular-nums">{t.value}</TableCell>
                      <TableCell className="text-center tabular-nums">{t.sharePct}%</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* Section 6: Calling Center Categories & Rent Plan Pipeline Analysis */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="border-border/70">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold sm:text-base">
              6A - Calling Center Structured Feedback Categories
            </CardTitle>
            <CardDescription className="text-xs">
              {ccReachedWithFeedbackCount.toLocaleString()} reached Calling Center calls with structured category tags
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0 sm:p-6 sm:pt-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Category</TableHead>
                    {perStaff.map((s) => (
                      <TableHead key={s.person.id} className="text-center">
                        {s.person.short}
                      </TableHead>
                    ))}
                    <TableHead className="text-center">Total</TableHead>
                    <TableHead className="text-center">High Severity</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {ccCategories.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={perStaff.length + 3} className="py-6 text-center text-xs text-muted-foreground">
                        No structured categories recorded in this period.
                      </TableCell>
                    </TableRow>
                  ) : (
                    ccCategories.map((c) => (
                      <TableRow key={c.category}>
                        <TableCell className="text-xs font-medium">{c.category}</TableCell>
                        {perStaff.map((s) => (
                          <TableCell key={s.person.id} className="text-center text-xs tabular-nums">
                            {c.byStaff[s.person.short] || '-'}
                          </TableCell>
                        ))}
                        <TableCell className="text-center text-xs font-semibold tabular-nums">
                          {c.total} ({c.sharePct}%)
                        </TableCell>
                        <TableCell className="text-center text-xs font-semibold tabular-nums text-destructive">
                          {c.highSeverity}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>

        <Card className="border-border/70">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold sm:text-base">
              6B - Rent Plan Pipeline Awareness & Pre-Approval Reviews
            </CardTitle>
            <CardDescription className="text-xs">
              {awareness.totalCalls} Awareness calls ({awareness.answeredCalls} answered) &bull; Pre-approval verification & desk reviews
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Awareness Check</TableHead>
                    <TableHead className="text-center">Knew / Yes</TableHead>
                    <TableHead className="text-center">Heard / Partly</TableHead>
                    <TableHead className="text-center">Did Not Know</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {awareness.questions.map((q) => (
                    <TableRow key={q.question}>
                      <TableCell className="text-xs font-medium">{q.question}</TableCell>
                      <TableCell className="text-center text-xs tabular-nums">{q.col1}</TableCell>
                      <TableCell className="text-center text-xs tabular-nums">{q.col2}</TableCell>
                      <TableCell className="text-center text-xs tabular-nums">{q.col3}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            <div className="space-y-2 border-t border-border/60 pt-3">
              <p className="text-xs font-semibold text-foreground">Pre-Approval Pipeline Desk Actions:</p>
              {pipelineDesks.map((d) => (
                <div
                  key={d.deskAction}
                  className="flex items-start justify-between gap-3 rounded-lg border border-border/50 bg-muted/20 p-2.5 text-xs"
                >
                  <div>
                    <p className="font-semibold text-foreground">{d.deskAction}</p>
                    <p className="mt-0.5 text-muted-foreground">{d.summary}</p>
                  </div>
                  <Badge variant="secondary" className="shrink-0 tabular-nums">
                    {d.entries} entries
                  </Badge>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Section 7: Representative Verbatim Feedback Samples */}
      <Card className="border-border/70">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm font-semibold sm:text-base">
            <MessageSquare className="h-4 w-4 text-primary" />
            7 - Representative Verbatim Feedback Samples (with Date, Caller & Phone Number)
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0 sm:p-6 sm:pt-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date & Time</TableHead>
                  <TableHead className="text-center">Staff</TableHead>
                  <TableHead>Person Called / Caller</TableHead>
                  <TableHead>Phone Number</TableHead>
                  <TableHead>Category / Stage</TableHead>
                  <TableHead>Verbatim Feedback Recorded</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {verbatimSamples.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="py-6 text-center text-xs text-muted-foreground">
                      No verbatim feedback notes recorded in this period.
                    </TableCell>
                  </TableRow>
                ) : (
                  verbatimSamples.map((s, idx) => (
                    <TableRow key={`${s.dateTime}-${s.phone}-${idx}`}>
                      <TableCell className="whitespace-nowrap text-xs font-medium">{s.dateTime}</TableCell>
                      <TableCell className="text-center text-xs font-semibold">{s.staff}</TableCell>
                      <TableCell className="whitespace-nowrap text-xs font-medium">{s.person}</TableCell>
                      <TableCell className="whitespace-nowrap font-mono text-xs font-semibold text-primary">
                        {s.phone}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs">{s.category}</TableCell>
                      <TableCell className="max-w-lg text-xs text-muted-foreground">{s.feedback}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
