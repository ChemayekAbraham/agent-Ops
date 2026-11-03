import { useState } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
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
  FileSpreadsheet,
  FileText,
  Loader2,
  MapPin,
  MessageSquareWarning,
  Phone,
  PhoneIncoming,
  PhoneOutgoing,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  Users,
} from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import { type CcCallingHub } from '@/hooks/useCcCallingHub';
import { kampalaTodayYmd, shiftKampalaDays } from '@/lib/kampalaDays';
import {
  fetchAllLandlordCallLogPages,
  getWednesdayWeekStart,
  shiftYmdDays,
  useLandlordCallLog,
  useLandlordConcernsReport,
  useLandlordCoverage,
  useLandlordDailySummary,
  useLandlordRoundReport,
  useLandlordStaffPerformance,
  useLandlordWeeklyReport,
} from '@/hooks/useLandlordCallingReports';
import {
  exportLandlordCallingReportPdf,
  exportLandlordCallingReportXlsx,
  exportLandlordCallLogCsv,
  formatCallSourceLabel,
} from '@/lib/landlordCallingReportsExport';
import { formatHumanLabel } from './ccUi';

type ReportSection =
  | 'weekly'
  | 'daily'
  | 'coverage'
  | 'staff'
  | 'call_log'
  | 'concerns'
  | 'round';

const LOG_PAGE_SIZE = 50;

export function LandlordCallsReport({ hub }: { hub: CcCallingHub }) {
  const { user } = useAuth();
  const todayYmd = kampalaTodayYmd();

  const [fromDate, setFromDate] = useState<string>(() => shiftKampalaDays(todayYmd, -6));
  const [toDate, setToDate] = useState<string>(() => todayYmd);
  const [weekStart, setWeekStart] = useState<string>(() => getWednesdayWeekStart(todayYmd));
  const [section, setSection] = useState<ReportSection>('weekly');
  const [logPage, setLogPage] = useState<number>(0);
  const [exportingKind, setExportingKind] = useState<'pdf' | 'xlsx' | 'csv' | null>(null);

  const cycleId = hub.cycle?.id ?? null;

  // Server-owned SECURITY DEFINER reporting RPCs (zero browser math)
  const dailyQ = useLandlordDailySummary(fromDate, toDate);
  const weeklyQ = useLandlordWeeklyReport(weekStart);
  const coverageQ = useLandlordCoverage();
  const staffQ = useLandlordStaffPerformance(fromDate, toDate);
  const callLogQ = useLandlordCallLog(fromDate, toDate, LOG_PAGE_SIZE, logPage * LOG_PAGE_SIZE);
  const concernsQ = useLandlordConcernsReport(fromDate, toDate);
  const roundQ = useLandlordRoundReport(cycleId);

  const applyPreset = (daysBack: number) => {
    const end = kampalaTodayYmd();
    const start = daysBack <= 1 ? end : shiftKampalaDays(end, -(daysBack - 1));
    setFromDate(start);
    setToDate(end);
    setWeekStart(getWednesdayWeekStart(end));
    setLogPage(0);
  };

  const shiftWeek = (deltaWeeks: number) => {
    const nextWed = shiftYmdDays(weekStart, deltaWeeks * 7);
    setWeekStart(nextWed);
    setFromDate(nextWed);
    setToDate(shiftYmdDays(nextWed, 6));
    setLogPage(0);
  };

  const refreshAll = () => {
    dailyQ.refetch();
    weeklyQ.refetch();
    coverageQ.refetch();
    staffQ.refetch();
    callLogQ.refetch();
    concernsQ.refetch();
    roundQ.refetch();
  };

  const generatedByLabel =
    (user?.user_metadata?.full_name as string | undefined) ||
    user?.email ||
    'Landlord Ops Staff';

  const handleExportPdf = async () => {
    try {
      setExportingKind('pdf');
      const allLogs = await fetchAllLandlordCallLogPages(fromDate, toDate);
      await exportLandlordCallingReportPdf({
        from: fromDate,
        to: toDate,
        weekStart,
        generatedBy: generatedByLabel,
        dailySummary: dailyQ.data ?? [],
        weeklyReport: weeklyQ.data ?? null,
        coverage: coverageQ.data ?? [],
        staffPerformance: staffQ.data ?? [],
        callLog: allLogs,
        concernsReport: concernsQ.data ?? null,
        roundReport: roundQ.data ?? null,
      });
      toast.success('Landlord calling report PDF downloaded');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to export PDF report');
    } finally {
      setExportingKind(null);
    }
  };

  const handleExportXlsx = async () => {
    try {
      setExportingKind('xlsx');
      const allLogs = await fetchAllLandlordCallLogPages(fromDate, toDate);
      await exportLandlordCallingReportXlsx({
        from: fromDate,
        to: toDate,
        weekStart,
        generatedBy: generatedByLabel,
        dailySummary: dailyQ.data ?? [],
        weeklyReport: weeklyQ.data ?? null,
        coverage: coverageQ.data ?? [],
        staffPerformance: staffQ.data ?? [],
        callLog: allLogs,
        concernsReport: concernsQ.data ?? null,
        roundReport: roundQ.data ?? null,
      });
      toast.success('Landlord calling report Excel workbook downloaded');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to export Excel workbook');
    } finally {
      setExportingKind(null);
    }
  };

  const handleExportCsv = async () => {
    try {
      setExportingKind('csv');
      const allLogs = await fetchAllLandlordCallLogPages(fromDate, toDate);
      await exportLandlordCallLogCsv(allLogs, {
        from: fromDate,
        to: toDate,
        generatedBy: generatedByLabel,
      });
      toast.success(`Exported ${allLogs.length.toLocaleString()} landlord call log rows to CSV`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to export call log CSV');
    } finally {
      setExportingKind(null);
    }
  };

  const wk = weeklyQ.data;
  const wkTotals = wk?.totals;
  const roundTotals = roundQ.data?.totals;
  const concernTotals = concernsQ.data?.totals;
  const callLogRows = callLogQ.data?.rows ?? [];
  const callLogTotal = callLogQ.data?.totalCount ?? 0;

  return (
    <div className="space-y-4" data-testid="landlord-calls-report">
      {/* Header & Controls */}
      <Card className="p-3.5 space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="h-9 w-9 rounded-xl bg-primary/10 text-primary flex items-center justify-center shrink-0">
              <BarChart3 className="h-4 w-4" />
            </div>
            <div>
              <h3 className="text-sm font-semibold">Landlord Calling Center Reports</h3>
              <p className="text-[11px] text-muted-foreground">
                Kampala-day grouping · Wednesday–Tuesday weeks · Server-verified figures across all landlord call channels
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              size="sm"
              variant="outline"
              onClick={refreshAll}
              className="h-8 text-xs gap-1"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Refresh
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={handleExportPdf}
              disabled={exportingKind !== null}
              className="h-8 text-xs gap-1"
              data-testid="export-landlord-pdf-btn"
            >
              {exportingKind === 'pdf' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <FileText className="h-3.5 w-3.5 text-rose-600" />
              )}
              Export PDF
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={handleExportXlsx}
              disabled={exportingKind !== null}
              className="h-8 text-xs gap-1"
              data-testid="export-landlord-xlsx-btn"
            >
              {exportingKind === 'xlsx' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <FileSpreadsheet className="h-3.5 w-3.5 text-emerald-600" />
              )}
              Export Excel
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={handleExportCsv}
              disabled={exportingKind !== null}
              className="h-8 text-xs gap-1"
              data-testid="export-landlord-csv-btn"
            >
              {exportingKind === 'csv' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="h-3.5 w-3.5 text-primary" />
              )}
              Call Log CSV
            </Button>
          </div>
        </div>

        {/* Date Range & Wed-Tue Week Controls */}
        <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] font-medium text-muted-foreground flex items-center gap-1 mr-1">
              <Calendar className="h-3.5 w-3.5" /> Kampala Range:
            </span>
            <Input
              type="date"
              value={fromDate}
              max={toDate}
              onChange={(e) => {
                if (e.target.value) {
                  setFromDate(e.target.value);
                  setLogPage(0);
                }
              }}
              className="h-7 text-xs w-[135px]"
              aria-label="From date"
            />
            <span className="text-xs text-muted-foreground">to</span>
            <Input
              type="date"
              value={toDate}
              min={fromDate}
              onChange={(e) => {
                if (e.target.value) {
                  setToDate(e.target.value);
                  setLogPage(0);
                }
              }}
              className="h-7 text-xs w-[135px]"
              aria-label="To date"
            />
            <div className="flex items-center gap-1 ml-1">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-[11px]"
                onClick={() => applyPreset(1)}
              >
                Today
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-[11px]"
                onClick={() => applyPreset(7)}
              >
                7 Days
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-[11px]"
                onClick={() => applyPreset(30)}
              >
                30 Days
              </Button>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            <span className="text-[11px] font-medium text-muted-foreground">
              Wed–Tue Week:
            </span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 w-7 p-0"
              onClick={() => shiftWeek(-1)}
              title="Previous Wednesday–Tuesday week"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </Button>
            <Badge variant="secondary" className="text-[11px] font-mono px-2 py-0.5">
              {wk?.week_start ?? weekStart} → {wk?.week_end ?? shiftYmdDays(weekStart, 6)}
            </Badge>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 w-7 p-0"
              onClick={() => shiftWeek(1)}
              title="Next Wednesday–Tuesday week"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </Card>

      {/* Server Summary KPI Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
        <Card className="p-3">
          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span>Weekly Calls</span>
            <Phone className="h-3.5 w-3.5 text-primary" />
          </div>
          <div className="text-xl font-bold tabular-nums mt-1">
            {wkTotals?.total_calls ?? 0}
          </div>
          <div className="text-[10px] text-muted-foreground">
            Made {wkTotals?.made_calls ?? 0} · Received {wkTotals?.received_calls ?? 0}
          </div>
        </Card>

        <Card className="p-3">
          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span>Reached / Engaged</span>
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
          </div>
          <div className="text-xl font-bold tabular-nums text-emerald-600 mt-1">
            {wkTotals?.reached_calls ?? 0} / {wkTotals?.engaged_calls ?? 0}
          </div>
          <div className="text-[10px] text-muted-foreground">
            Unreachable {wkTotals?.unreachable_calls ?? 0} · Callback {wkTotals?.callback_calls ?? 0}
          </div>
        </Card>

        <Card className="p-3">
          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span>Solved Here</span>
            <Sparkles className="h-3.5 w-3.5 text-teal-600" />
          </div>
          <div className="text-xl font-bold tabular-nums text-teal-600 mt-1">
            {wkTotals?.solved_here_total ?? 0}
          </div>
          <div className="text-[10px] text-muted-foreground">
            Resolved without forwarding
          </div>
        </Card>

        <Card className="p-3">
          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span>Forwarded Concerns</span>
            <MessageSquareWarning className="h-3.5 w-3.5 text-amber-600" />
          </div>
          <div className="text-xl font-bold tabular-nums text-amber-600 mt-1">
            {wkTotals?.forwarded_total ?? 0}
          </div>
          <div className="text-[10px] text-muted-foreground">
            Made {wkTotals?.forwarded_from_made ?? 0} · Received {wkTotals?.forwarded_from_received ?? 0}
          </div>
        </Card>

        <Card className="p-3">
          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span>Overdue Concerns</span>
            <ShieldAlert className="h-3.5 w-3.5 text-rose-600" />
          </div>
          <div className="text-xl font-bold tabular-nums text-rose-600 mt-1">
            {concernTotals?.overdue_concerns ?? 0}
          </div>
          <div className="text-[10px] text-muted-foreground">
            {concernTotals?.open_concerns ?? 0} open in range
          </div>
        </Card>

        <Card className="p-3">
          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span>Round Progress</span>
            <Users className="h-3.5 w-3.5 text-primary" />
          </div>
          <div className="text-xl font-bold tabular-nums mt-1">
            {roundTotals?.reached_count ?? 0} / {roundTotals?.total_rows ?? 0}
          </div>
          <div className="text-[10px] text-muted-foreground">
            Parked {roundTotals?.parked_count ?? 0} · Outstanding {roundTotals?.outstanding_count ?? 0}
          </div>
        </Card>
      </div>

      {/* Report Section Switcher */}
      <div className="flex flex-wrap items-center gap-1.5 border-b pb-2">
        {(
          [
            { id: 'weekly', label: 'Weekly Report (Wed–Tue)' },
            { id: 'daily', label: 'Daily Summary' },
            { id: 'coverage', label: 'Registry Coverage' },
            { id: 'staff', label: 'Staff Performance' },
            { id: 'call_log', label: `Call Log (${callLogTotal.toLocaleString()})` },
            { id: 'concerns', label: 'Concerns Report' },
            { id: 'round', label: 'Round Report' },
          ] as { id: ReportSection; label: string }[]
        ).map((tab) => (
          <Button
            key={tab.id}
            type="button"
            size="sm"
            variant={section === tab.id ? 'default' : 'outline'}
            className="h-8 text-xs"
            onClick={() => setSection(tab.id)}
          >
            {tab.label}
          </Button>
        ))}
      </div>

      {/* SECTION 1: WEEKLY REPORT (Wed-Tue) */}
      {section === 'weekly' && (
        <div className="space-y-4">
          <Card className="p-3">
            <div className="flex items-center justify-between mb-2">
              <div>
                <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Wednesday–Tuesday Daily Breakdown ({wk?.week_start ?? weekStart} to {wk?.week_end ?? ''})
                </h4>
                <p className="text-[11px] text-muted-foreground">
                  Landlord calls made vs received, reached, engaged, solved here, and forwarded concerns per Kampala day
                </p>
              </div>
            </div>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs">Kampala Day</TableHead>
                    <TableHead className="text-xs text-right">Total Calls</TableHead>
                    <TableHead className="text-xs text-right">Made</TableHead>
                    <TableHead className="text-xs text-right">Received</TableHead>
                    <TableHead className="text-xs text-right">Reached</TableHead>
                    <TableHead className="text-xs text-right">Engaged</TableHead>
                    <TableHead className="text-xs text-right">Unreachable</TableHead>
                    <TableHead className="text-xs text-right">Callbacks</TableHead>
                    <TableHead className="text-xs text-right">Solved Here</TableHead>
                    <TableHead className="text-xs text-right">Forwarded</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(wk?.per_day ?? []).map((d) => (
                    <TableRow key={d.kampala_day}>
                      <TableCell className="text-xs font-medium font-mono">{d.kampala_day}</TableCell>
                      <TableCell className="text-xs text-right font-semibold tabular-nums">{d.total_calls}</TableCell>
                      <TableCell className="text-xs text-right tabular-nums">{d.made_calls}</TableCell>
                      <TableCell className="text-xs text-right tabular-nums">{d.received_calls}</TableCell>
                      <TableCell className="text-xs text-right tabular-nums text-emerald-600">{d.reached_calls}</TableCell>
                      <TableCell className="text-xs text-right tabular-nums">{d.engaged_calls}</TableCell>
                      <TableCell className="text-xs text-right tabular-nums text-amber-600">{d.unreachable_calls}</TableCell>
                      <TableCell className="text-xs text-right tabular-nums">{d.callback_calls}</TableCell>
                      <TableCell className="text-xs text-right tabular-nums text-teal-600">{d.solved_here_total}</TableCell>
                      <TableCell className="text-xs text-right tabular-nums">{d.forwarded_total}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </Card>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card className="p-3">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                Forwarded Concerns by Recipient & Day
              </h4>
              {(wk?.forwarded_by_recipient ?? []).length === 0 ? (
                <p className="text-xs text-muted-foreground py-6 text-center">
                  No landlord concerns forwarded during this Wednesday–Tuesday week.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="text-xs">Recipient</TableHead>
                        {(wk?.day_keys ?? []).map((dk) => (
                          <TableHead key={dk} className="text-[10px] text-right font-mono">
                            {dk.slice(5)}
                          </TableHead>
                        ))}
                        <TableHead className="text-xs text-right">Made</TableHead>
                        <TableHead className="text-xs text-right">Received</TableHead>
                        <TableHead className="text-xs text-right">Total</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(wk?.forwarded_by_recipient ?? []).map((r) => (
                        <TableRow key={r.recipient_id ?? r.recipient_name}>
                          <TableCell className="text-xs font-medium">{r.recipient_name}</TableCell>
                          {(r.per_day ?? []).map((cnt, idx) => (
                            <TableCell key={idx} className="text-xs text-right tabular-nums">
                              {cnt}
                            </TableCell>
                          ))}
                          <TableCell className="text-xs text-right tabular-nums">{r.from_made}</TableCell>
                          <TableCell className="text-xs text-right tabular-nums">{r.from_received}</TableCell>
                          <TableCell className="text-xs text-right font-semibold tabular-nums">
                            {r.total_forwarded}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </Card>

            <Card className="p-3">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                Solved Here by Staff & Channel Source
              </h4>
              <div className="space-y-3">
                {(wk?.solved_here_by_staff ?? []).length === 0 ? (
                  <p className="text-xs text-muted-foreground py-3 text-center">
                    No solved-here landlord calls recorded in this week yet.
                  </p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="text-xs">Staff Member</TableHead>
                        <TableHead className="text-xs text-right">From Made</TableHead>
                        <TableHead className="text-xs text-right">From Received</TableHead>
                        <TableHead className="text-xs text-right">Total Solved</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(wk?.solved_here_by_staff ?? []).map((s) => (
                        <TableRow key={s.staff_id ?? s.staff_name}>
                          <TableCell className="text-xs font-medium">{s.staff_name}</TableCell>
                          <TableCell className="text-xs text-right tabular-nums">{s.from_made}</TableCell>
                          <TableCell className="text-xs text-right tabular-nums">{s.from_received}</TableCell>
                          <TableCell className="text-xs text-right font-semibold tabular-nums text-teal-600">
                            {s.total_solved}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}

                {(wk?.by_source ?? []).length > 0 && (
                  <div className="pt-2 border-t">
                    <div className="text-[11px] font-medium text-muted-foreground mb-1.5">
                      Calls by Source Channel
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {(wk?.by_source ?? []).map((src) => (
                        <Badge key={src.source} variant="outline" className="text-[11px] gap-1">
                          <span>{formatCallSourceLabel(src.source)}:</span>
                          <span className="font-bold">{src.calls}</span>
                          <span className="text-muted-foreground">({src.reached_calls} reached)</span>
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </Card>
          </div>
        </div>
      )}

      {/* SECTION 2: DAILY SUMMARY */}
      {section === 'daily' && (
        <Card className="p-3">
          <div className="mb-2">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Daily Staff Summary ({fromDate} to {toDate})
            </h4>
            <p className="text-[11px] text-muted-foreground">
              Per staff member and Kampala day · Voided call attempts are excluded
            </p>
          </div>
          {(dailyQ.data ?? []).length === 0 ? (
            <p className="text-xs text-muted-foreground py-8 text-center">
              No landlord calls recorded in this date range.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs">Kampala Day</TableHead>
                    <TableHead className="text-xs">Staff Member</TableHead>
                    <TableHead className="text-xs text-right">Total Calls</TableHead>
                    <TableHead className="text-xs text-right">Reached</TableHead>
                    <TableHead className="text-xs text-right">Engaged</TableHead>
                    <TableHead className="text-xs text-right">Unreachable</TableHead>
                    <TableHead className="text-xs text-right">Callbacks</TableHead>
                    <TableHead className="text-xs text-right">Made</TableHead>
                    <TableHead className="text-xs text-right">Received</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(dailyQ.data ?? []).map((r, i) => (
                    <TableRow key={`${r.kampala_day}-${r.staff_id ?? i}`}>
                      <TableCell className="text-xs font-mono">{r.kampala_day}</TableCell>
                      <TableCell className="text-xs font-medium">{r.staff_name}</TableCell>
                      <TableCell className="text-xs text-right font-semibold tabular-nums">{r.total_calls}</TableCell>
                      <TableCell className="text-xs text-right tabular-nums text-emerald-600">{r.reached_calls}</TableCell>
                      <TableCell className="text-xs text-right tabular-nums">{r.engaged_calls}</TableCell>
                      <TableCell className="text-xs text-right tabular-nums text-amber-600">{r.unreachable_calls}</TableCell>
                      <TableCell className="text-xs text-right tabular-nums">{r.callback_calls}</TableCell>
                      <TableCell className="text-xs text-right tabular-nums">{r.made_calls}</TableCell>
                      <TableCell className="text-xs text-right tabular-nums">{r.received_calls}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </Card>
      )}

      {/* SECTION 3: REGISTRY COVERAGE */}
      {section === 'coverage' && (
        <Card className="p-3">
          <div className="mb-2 flex items-center justify-between">
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1">
                <MapPin className="h-3.5 w-3.5 text-primary" /> Landlord Registry Coverage by Region & District
              </h4>
              <p className="text-[11px] text-muted-foreground">
                Every landlord in the unified registry: ever reached, reached this round, reached this month, and never called
              </p>
            </div>
          </div>
          {(coverageQ.data ?? []).length === 0 ? (
            <p className="text-xs text-muted-foreground py-8 text-center">
              Loading landlord registry coverage...
            </p>
          ) : (
            <div className="overflow-x-auto max-h-[520px]">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs">Region</TableHead>
                    <TableHead className="text-xs">District</TableHead>
                    <TableHead className="text-xs text-right">Registry Total</TableHead>
                    <TableHead className="text-xs text-right">Ever Reached</TableHead>
                    <TableHead className="text-xs text-right">Reached This Round</TableHead>
                    <TableHead className="text-xs text-right">Reached This Month</TableHead>
                    <TableHead className="text-xs text-right">Never Called</TableHead>
                    <TableHead className="text-xs text-right">Active Rent Plans</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(coverageQ.data ?? []).map((c, idx) => (
                    <TableRow key={`${c.region}-${c.district}-${idx}`}>
                      <TableCell className="text-xs font-medium">{c.region}</TableCell>
                      <TableCell className="text-xs">{c.district}</TableCell>
                      <TableCell className="text-xs text-right font-semibold tabular-nums">{c.registry_total}</TableCell>
                      <TableCell className="text-xs text-right tabular-nums text-emerald-600">{c.ever_reached}</TableCell>
                      <TableCell className="text-xs text-right tabular-nums">{c.reached_this_round}</TableCell>
                      <TableCell className="text-xs text-right tabular-nums">{c.reached_this_month}</TableCell>
                      <TableCell className="text-xs text-right tabular-nums text-amber-600">{c.never_called}</TableCell>
                      <TableCell className="text-xs text-right tabular-nums">{c.active_rent_plans_count}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </Card>
      )}

      {/* SECTION 4: STAFF PERFORMANCE */}
      {section === 'staff' && (
        <Card className="p-3">
          <div className="mb-2">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Staff Calling Performance ({fromDate} to {toDate})
            </h4>
            <p className="text-[11px] text-muted-foreground">
              Total calls, reach rate, calls per active hour, and landlord follow-ups owed or overdue
            </p>
          </div>
          {(staffQ.data ?? []).length === 0 ? (
            <p className="text-xs text-muted-foreground py-8 text-center">
              No staff calling activity in this date range.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs">Staff Member</TableHead>
                    <TableHead className="text-xs text-right">Calls</TableHead>
                    <TableHead className="text-xs text-right">Reached</TableHead>
                    <TableHead className="text-xs text-right">Engaged</TableHead>
                    <TableHead className="text-xs text-right">Unreachable</TableHead>
                    <TableHead className="text-xs text-right">Callbacks</TableHead>
                    <TableHead className="text-xs text-right">Reach Rate</TableHead>
                    <TableHead className="text-xs text-right">Active Hrs</TableHead>
                    <TableHead className="text-xs text-right">Calls / Hr</TableHead>
                    <TableHead className="text-xs text-right">Follow-ups Owed</TableHead>
                    <TableHead className="text-xs text-right">Overdue</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(staffQ.data ?? []).map((s, idx) => (
                    <TableRow key={s.staff_id ?? idx}>
                      <TableCell className="text-xs font-medium">{s.staff_name}</TableCell>
                      <TableCell className="text-xs text-right font-semibold tabular-nums">{s.total_calls}</TableCell>
                      <TableCell className="text-xs text-right tabular-nums text-emerald-600">{s.reached_calls}</TableCell>
                      <TableCell className="text-xs text-right tabular-nums">{s.engaged_calls}</TableCell>
                      <TableCell className="text-xs text-right tabular-nums text-amber-600">{s.unreachable_calls}</TableCell>
                      <TableCell className="text-xs text-right tabular-nums">{s.callback_calls}</TableCell>
                      <TableCell className="text-xs text-right tabular-nums">
                        <Badge variant={s.reach_rate_pct >= 50 ? 'default' : 'secondary'} className="text-[10px]">
                          {s.reach_rate_pct}%
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs text-right tabular-nums">{s.active_hours}</TableCell>
                      <TableCell className="text-xs text-right tabular-nums font-medium">{s.calls_per_active_hour}</TableCell>
                      <TableCell className="text-xs text-right tabular-nums">{s.followups_owed}</TableCell>
                      <TableCell className="text-xs text-right tabular-nums">
                        {s.followups_overdue > 0 ? (
                          <Badge variant="destructive" className="text-[10px]">
                            {s.followups_overdue}
                          </Badge>
                        ) : (
                          '0'
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </Card>
      )}

      {/* SECTION 5: PAGED LANDLORD CALL LOG */}
      {section === 'call_log' && (
        <Card className="p-3 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Paged Landlord Call Log ({callLogTotal.toLocaleString()} total calls)
              </h4>
              <p className="text-[11px] text-muted-foreground">
                One row per deduplicated landlord call · Phone masked automatically unless role permits full view
              </p>
            </div>
            <div className="flex items-center gap-1.5">
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                disabled={logPage === 0}
                onClick={() => setLogPage((p) => Math.max(0, p - 1))}
              >
                <ChevronLeft className="h-3.5 w-3.5" /> Prev
              </Button>
              <span className="text-xs tabular-nums px-2">
                Page {logPage + 1} of {Math.max(1, Math.ceil(callLogTotal / LOG_PAGE_SIZE))}
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                disabled={(logPage + 1) * LOG_PAGE_SIZE >= callLogTotal}
                onClick={() => setLogPage((p) => p + 1)}
              >
                Next <ChevronRight className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>

          {callLogRows.length === 0 ? (
            <p className="text-xs text-muted-foreground py-8 text-center">
              No landlord call log rows in this date range.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs">Time</TableHead>
                    <TableHead className="text-xs">Landlord</TableHead>
                    <TableHead className="text-xs">Phone</TableHead>
                    <TableHead className="text-xs">Caller</TableHead>
                    <TableHead className="text-xs">Source</TableHead>
                    <TableHead className="text-xs">Outcome</TableHead>
                    <TableHead className="text-xs">Category</TableHead>
                    <TableHead className="text-xs">Note</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {callLogRows.map((row) => (
                    <TableRow key={row.call_id}>
                      <TableCell className="text-[11px] font-mono whitespace-nowrap">
                        {row.called_at ? row.called_at.slice(0, 16).replace('T', ' ') : row.kampala_day}
                      </TableCell>
                      <TableCell className="text-xs font-medium">{row.landlord_name}</TableCell>
                      <TableCell className="text-xs font-mono whitespace-nowrap">
                        {row.phone}
                      </TableCell>
                      <TableCell className="text-xs">{row.caller_name}</TableCell>
                      <TableCell className="text-xs">
                        <span className="inline-flex items-center gap-1 text-[11px]">
                          {row.direction === 'received' ? (
                            <PhoneIncoming className="h-3 w-3 text-teal-600" />
                          ) : (
                            <PhoneOutgoing className="h-3 w-3 text-primary" />
                          )}
                          {formatCallSourceLabel(row.source)}
                        </span>
                      </TableCell>
                      <TableCell className="text-xs">
                        <Badge
                          variant={row.is_reached ? 'default' : 'secondary'}
                          className="text-[10px]"
                        >
                          {formatHumanLabel(row.outcome)}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs">{row.category_label}</TableCell>
                      <TableCell className="text-xs max-w-[260px] truncate" title={row.note ?? ''}>
                        {row.note || '—'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </Card>
      )}

      {/* SECTION 6: CONCERNS REPORT */}
      {section === 'concerns' && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <Card className="p-3">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                By Category
              </h4>
              {(concernsQ.data?.by_category ?? []).length === 0 ? (
                <p className="text-xs text-muted-foreground py-4 text-center">No concerns in range.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-xs">Category</TableHead>
                      <TableHead className="text-xs text-right">Total</TableHead>
                      <TableHead className="text-xs text-right">Open</TableHead>
                      <TableHead className="text-xs text-right">Overdue</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(concernsQ.data?.by_category ?? []).map((c) => (
                      <TableRow key={c.category_code}>
                        <TableCell className="text-xs font-medium">{c.category_label}</TableCell>
                        <TableCell className="text-xs text-right tabular-nums">{c.total_count}</TableCell>
                        <TableCell className="text-xs text-right tabular-nums">{c.open_count}</TableCell>
                        <TableCell className="text-xs text-right tabular-nums text-rose-600">{c.overdue_count}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </Card>

            <Card className="p-3">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                By Team & Recipient
              </h4>
              {(concernsQ.data?.by_team ?? []).length === 0 ? (
                <p className="text-xs text-muted-foreground py-4 text-center">No team hand-offs in range.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-xs">Team / Recipient</TableHead>
                      <TableHead className="text-xs text-right">Total</TableHead>
                      <TableHead className="text-xs text-right">Open</TableHead>
                      <TableHead className="text-xs text-right">Overdue</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(concernsQ.data?.by_team ?? []).map((t, idx) => (
                      <TableRow key={`${t.team_name}-${t.recipient_name}-${idx}`}>
                        <TableCell className="text-xs">
                          <div className="font-medium">{t.recipient_name}</div>
                          <div className="text-[10px] text-muted-foreground">{t.team_name}</div>
                        </TableCell>
                        <TableCell className="text-xs text-right tabular-nums">{t.total_count}</TableCell>
                        <TableCell className="text-xs text-right tabular-nums">{t.open_count}</TableCell>
                        <TableCell className="text-xs text-right tabular-nums text-rose-600">{t.overdue_count}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </Card>

            <Card className="p-3">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                By Age & Overdue Status
              </h4>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs">Age Bucket</TableHead>
                    <TableHead className="text-xs text-right">Total</TableHead>
                    <TableHead className="text-xs text-right">Open</TableHead>
                    <TableHead className="text-xs text-right">Overdue</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(concernsQ.data?.by_age_bucket ?? []).map((b) => (
                    <TableRow key={b.bucket_key}>
                      <TableCell className="text-xs font-medium">{b.bucket_label}</TableCell>
                      <TableCell className="text-xs text-right tabular-nums">{b.total_count}</TableCell>
                      <TableCell className="text-xs text-right tabular-nums">{b.open_count}</TableCell>
                      <TableCell className="text-xs text-right tabular-nums text-rose-600">{b.overdue_count}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
          </div>
        </div>
      )}

      {/* SECTION 7: ROUND REPORT */}
      {section === 'round' && (
        <div className="space-y-4">
          <Card className="p-3">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
              <div>
                <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Round Report — {roundQ.data?.cycle ? `Round #${roundQ.data.cycle.cycle_no}: ${roundQ.data.cycle.title}` : 'Latest Round'}
                </h4>
                <p className="text-[11px] text-muted-foreground">
                  Final reached, parked, and outstanding landlord rows for the selected calling round
                </p>
              </div>
              {roundQ.data?.cycle && (
                <Badge variant={roundQ.data.cycle.closed_at ? 'secondary' : 'default'} className="text-xs">
                  {roundQ.data.cycle.closed_at ? 'Closed Round' : 'Open Round'}
                </Badge>
              )}
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-2 mb-4">
              <div className="rounded-lg border p-2.5">
                <div className="text-[10px] text-muted-foreground">Total Landlords</div>
                <div className="text-lg font-bold tabular-nums">{roundTotals?.total_rows ?? 0}</div>
              </div>
              <div className="rounded-lg border p-2.5">
                <div className="text-[10px] text-muted-foreground">Final Reached</div>
                <div className="text-lg font-bold tabular-nums text-emerald-600">{roundTotals?.reached_count ?? 0}</div>
              </div>
              <div className="rounded-lg border p-2.5">
                <div className="text-[10px] text-muted-foreground">Engaged</div>
                <div className="text-lg font-bold tabular-nums">{roundTotals?.engaged_count ?? 0}</div>
              </div>
              <div className="rounded-lg border p-2.5">
                <div className="text-[10px] text-muted-foreground">Parked</div>
                <div className="text-lg font-bold tabular-nums text-amber-600">{roundTotals?.parked_count ?? 0}</div>
              </div>
              <div className="rounded-lg border p-2.5">
                <div className="text-[10px] text-muted-foreground">Outstanding</div>
                <div className="text-lg font-bold tabular-nums text-primary">{roundTotals?.outstanding_count ?? 0}</div>
              </div>
              <div className="rounded-lg border p-2.5">
                <div className="text-[10px] text-muted-foreground">Total Attempts</div>
                <div className="text-lg font-bold tabular-nums">{roundTotals?.total_attempts ?? 0}</div>
              </div>
            </div>

            {(roundQ.data?.by_caller ?? []).length > 0 && (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs">Caller</TableHead>
                    <TableHead className="text-xs text-right">Attempts Made</TableHead>
                    <TableHead className="text-xs text-right">Engaged</TableHead>
                    <TableHead className="text-xs text-right">Callbacks</TableHead>
                    <TableHead className="text-xs text-right">Unreached</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(roundQ.data?.by_caller ?? []).map((c, idx) => (
                    <TableRow key={c.caller_id ?? idx}>
                      <TableCell className="text-xs font-medium">{c.caller_name}</TableCell>
                      <TableCell className="text-xs text-right font-semibold tabular-nums">{c.attempts_count}</TableCell>
                      <TableCell className="text-xs text-right tabular-nums text-emerald-600">{c.engaged_count}</TableCell>
                      <TableCell className="text-xs text-right tabular-nums">{c.callback_count}</TableCell>
                      <TableCell className="text-xs text-right tabular-nums text-amber-600">{c.unreached_count}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
