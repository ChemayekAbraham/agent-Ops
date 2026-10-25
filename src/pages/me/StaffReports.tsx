import { useMemo, useState } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  AlertCircle,
  ClipboardList,
  FileDown,
  Filter,
  Loader2,
  PhoneCall,
  ShieldAlert,
  UserCheck,
  Users,
} from 'lucide-react';
import { toast } from 'sonner';
import PersonalLayout from '@/components/layout/PersonalLayout';
import { useAuth } from '@/hooks/useAuth';
import { kampalaTodayYmd } from '@/lib/kampalaDays';
import {
  buildMonthPeriodWindow,
  buildWeekPeriodWindow,
  CALLING_TEAM_STAFF,
  canAccessHrStaffReports,
  getWedWeekStartYmd,
  useStaffCallingReport,
  type StaffReportPeriodMode,
} from '@/hooks/useStaffCallingReport';
import {
  CallingReportPeriodBar,
  GeneralTeamReportPanel,
  IndividualStaffReportPanel,
} from '@/components/me/StaffCallingReportWorkspace';
import {
  exportGeneralTeamCallingPdf,
  exportIndividualStaffCallingPdf,
} from '@/lib/staffCallingReportPdf';

export default function StaffReportsPage() {
  const { user, roles } = useAuth();
  const todayYmd = kampalaTodayYmd();

  const [sectionTab, setSectionTab] = useState<string>('call-center');
  const [staffView, setStaffView] = useState<string>('general');
  const [mode, setMode] = useState<StaffReportPeriodMode>('month');
  const [weekStart, setWeekStart] = useState<string>(() => getWedWeekStartYmd(todayYmd));
  const [yearMonth, setYearMonth] = useState<string>(() => todayYmd.slice(0, 7) || '2026-10');
  const [exportingAll, setExportingAll] = useState(false);

  const canAccess = canAccessHrStaffReports(user?.id, roles);

  const periodWindow = useMemo(
    () => (mode === 'week' ? buildWeekPeriodWindow(weekStart) : buildMonthPeriodWindow(yearMonth, todayYmd)),
    [mode, weekStart, yearMonth, todayYmd],
  );

  const reportQ = useStaffCallingReport(periodWindow, canAccess);

  const handleDownloadAllFourPdfs = async () => {
    if (!reportQ.data) return;
    try {
      setExportingAll(true);
      await exportGeneralTeamCallingPdf(reportQ.data, periodWindow);
      for (const s of reportQ.data.perStaff) {
        await exportIndividualStaffCallingPdf(s, periodWindow);
      }
      toast.success('Downloaded all 4 PDF reports (General Team + Jane, Winnie & Hanisha)');
    } catch (err: any) {
      toast.error(err?.message || 'Failed to download PDFs');
    } finally {
      setExportingAll(false);
    }
  };

  if (!canAccess) {
    return (
      <PersonalLayout title="Staff reports">
        <Card className="border-destructive/30 bg-destructive/5">
          <CardContent className="flex items-center gap-3 p-6 text-sm text-destructive">
            <ShieldAlert className="h-5 w-5 shrink-0" />
            <div>
              <p className="font-semibold">Staff Reports is restricted to HR & Executive Oversight</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Only HR (Mark Bwayo) and authorized management roles can view and export staff calling reports.
              </p>
            </div>
          </CardContent>
        </Card>
      </PersonalLayout>
    );
  }

  return (
    <PersonalLayout title="Staff reports">
      <div className="space-y-5">
        {/* Page Header */}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <ClipboardList className="h-5 w-5 text-primary" />
              <h1 className="text-lg font-bold tracking-tight sm:text-xl">HR Staff Reports</h1>
              <Badge variant="secondary" className="border-primary/30 bg-primary/10 text-primary">
                HR & Management
              </Badge>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground sm:text-sm">
              Review weekly (Wednesday–Tuesday) and monthly staff performance, call logs, verified phone numbers, and
              Rent Plan pipeline feedback with branded PDF exports.
            </p>
          </div>
        </div>

        {/* Top-Level Category Tabs (Call Center Reports) */}
        <Tabs value={sectionTab} onValueChange={setSectionTab} className="space-y-4">
          <TabsList className="flex h-auto flex-wrap justify-start gap-1.5 bg-muted/60 p-1.5">
            <TabsTrigger value="call-center" className="gap-2 text-xs sm:text-sm">
              <PhoneCall className="h-3.5 w-3.5" />
              Call Center Reports (Jane, Winnie, Hanisha & General)
              {reportQ.data && (
                <Badge variant="secondary" className="ml-1 px-1.5 py-0 text-[10px]">
                  {reportQ.data.stats.total.toLocaleString()} calls
                </Badge>
              )}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="call-center" className="mt-0 space-y-5">
            {/* Period Filter Bar (Week Wed-Tue & Specific Month) */}
            <CallingReportPeriodBar
              mode={mode}
              onModeChange={setMode}
              weekStart={weekStart}
              onWeekStartChange={setWeekStart}
              yearMonth={yearMonth}
              onYearMonthChange={setYearMonth}
              periodWindow={periodWindow}
              onRefresh={() => reportQ.refetch()}
              isFetching={reportQ.isFetching}
              rightActions={
                reportQ.data ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    onClick={handleDownloadAllFourPdfs}
                    disabled={exportingAll}
                    className="h-8 gap-1.5 text-xs font-semibold"
                  >
                    {exportingAll ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <FileDown className="h-3.5 w-3.5" />
                    )}
                    Export All 4 PDFs
                  </Button>
                ) : null
              }
            />

            {/* Staff / General Filter Bar */}
            <div className="flex flex-col gap-3 rounded-xl border border-border/70 bg-card p-3.5 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex flex-wrap items-center gap-1.5">
                <Button
                  type="button"
                  size="sm"
                  variant={staffView === 'general' ? 'default' : 'outline'}
                  onClick={() => setStaffView('general')}
                  className="h-8 gap-1.5 text-xs"
                >
                  <Users className="h-3.5 w-3.5" />
                  General Team Report
                  {reportQ.data && (
                    <Badge
                      variant={staffView === 'general' ? 'secondary' : 'outline'}
                      className="ml-1 px-1.5 py-0 text-[10px]"
                    >
                      {reportQ.data.stats.total}
                    </Badge>
                  )}
                </Button>

                {CALLING_TEAM_STAFF.map((s) => {
                  const sData = reportQ.data?.perStaff.find((p) => p.person.id === s.id);
                  const active = staffView === s.id;
                  return (
                    <Button
                      key={s.id}
                      type="button"
                      size="sm"
                      variant={active ? 'default' : 'outline'}
                      onClick={() => setStaffView(s.id)}
                      className="h-8 gap-1.5 text-xs"
                    >
                      <UserCheck className="h-3.5 w-3.5" />
                      {s.short} ({s.display})
                      {sData && (
                        <Badge
                          variant={active ? 'secondary' : 'outline'}
                          className="ml-1 px-1.5 py-0 text-[10px]"
                        >
                          {sData.stats.total}
                        </Badge>
                      )}
                    </Button>
                  );
                })}
              </div>

              <div className="flex items-center gap-2">
                <Filter className="h-3.5 w-3.5 text-muted-foreground" />
                <select
                  aria-label="Filter report by staff member"
                  value={staffView}
                  onChange={(e) => setStaffView(e.target.value)}
                  className="h-8 rounded-md border border-input bg-background px-2.5 text-xs font-medium text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  <option value="general">General Team Report (All 3 Staff)</option>
                  {CALLING_TEAM_STAFF.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.short} - {s.display}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Report Content */}
            {reportQ.isLoading ? (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
                  {Array.from({ length: 6 }).map((_, i) => (
                    <Skeleton key={i} className="h-24 w-full rounded-xl" />
                  ))}
                </div>
                <Skeleton className="h-72 w-full rounded-xl" />
                <Skeleton className="h-96 w-full rounded-xl" />
              </div>
            ) : reportQ.isError ? (
              <Card className="border-destructive/30 bg-destructive/5">
                <CardContent className="flex items-center gap-3 p-6 text-sm text-destructive">
                  <AlertCircle className="h-5 w-5 shrink-0" />
                  <div>
                    <p className="font-semibold">Could not load Call Center report</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {(reportQ.error as any)?.message || 'Please try refreshing the report.'}
                    </p>
                  </div>
                </CardContent>
              </Card>
            ) : reportQ.data ? (
              staffView === 'general' ? (
                <GeneralTeamReportPanel
                  teamData={reportQ.data}
                  periodWindow={periodWindow}
                  onSelectStaffTab={(staffId) => setStaffView(staffId)}
                />
              ) : (
                (() => {
                  const target = reportQ.data.perStaff.find((p) => p.person.id === staffView);
                  if (!target) return null;
                  return <IndividualStaffReportPanel data={target} periodWindow={periodWindow} />;
                })()
              )
            ) : null}
          </TabsContent>
        </Tabs>
      </div>
    </PersonalLayout>
  );
}
