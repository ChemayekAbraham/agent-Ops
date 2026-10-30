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
  Loader2,
  PhoneCall,
  ShieldAlert,
  UserCheck,
  Users,
} from 'lucide-react';
import { toast } from 'sonner';
import PersonalLayout from '@/components/layout/PersonalLayout';
import { V360StaffPricingBanner } from '@/components/v360/V360StaffPricingBanner';
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

  // Strictly gated to HR Mark Bwayo
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
        <Card className="rounded-2xl border-destructive/30 bg-destructive/5">
          <CardContent className="flex items-center gap-3 p-5 text-sm text-destructive sm:p-6">
            <ShieldAlert className="h-5 w-5 shrink-0" />
            <div>
              <p className="font-semibold">Staff Reports is restricted to HR (Mark Bwayo)</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                This My Space page is exclusively available to HR Mark Bwayo.
              </p>
            </div>
          </CardContent>
        </Card>
      </PersonalLayout>
    );
  }

  return (
    <PersonalLayout title="Staff reports">
      <div className="space-y-4 sm:space-y-5">
        <V360StaffPricingBanner />
        {/* Mobile-First Page Header */}
        <div className="rounded-2xl border border-border/70 bg-card p-4 shadow-sm sm:p-5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <ClipboardList className="h-4 w-4" />
            </span>
            <h1 className="text-base font-bold tracking-tight sm:text-xl">HR Staff Reports</h1>
            <Badge variant="secondary" className="border-primary/30 bg-primary/10 text-[11px] font-semibold text-primary">
              HR &bull; Mark Bwayo
            </Badge>
          </div>
          <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground sm:text-sm">
            Review weekly (Wednesday&ndash;Tuesday) and monthly staff performance, call logs, verified phone numbers, and
            Rent Plan pipeline feedback with branded PDF exports.
          </p>
        </div>

        {/* Top-Level Category Tabs (Call Center Reports) */}
        <Tabs value={sectionTab} onValueChange={setSectionTab} className="space-y-4">
          <div className="-mx-1 overflow-x-auto px-1 pb-1">
            <TabsList className="inline-flex h-auto min-w-full justify-start gap-1.5 rounded-2xl border border-border/70 bg-muted/50 p-1.5 sm:min-w-0">
              <TabsTrigger
                value="call-center"
                className="min-h-[38px] shrink-0 gap-2 rounded-xl px-3.5 text-xs font-semibold data-[state=active]:shadow-sm sm:text-sm"
              >
                <PhoneCall className="h-3.5 w-3.5" />
                <span>Call Center Reports</span>
                {reportQ.data && (
                  <Badge variant="secondary" className="ml-0.5 px-1.5 py-0 text-[10px] font-bold">
                    {reportQ.data.stats.total.toLocaleString()} calls
                  </Badge>
                )}
              </TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="call-center" className="mt-0 space-y-4 sm:space-y-5">
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
                    className="h-9 flex-1 gap-1.5 rounded-xl text-xs font-semibold sm:flex-initial"
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

            {/* Mobile-First Horizontally Scrollable Staff / General Switcher */}
            <div className="-mx-1 overflow-x-auto px-1 pb-1">
              <div className="inline-flex min-w-full items-center gap-1.5 rounded-2xl border border-border/70 bg-card p-1.5 shadow-sm sm:min-w-0 sm:flex-wrap">
                <button
                  type="button"
                  onClick={() => setStaffView('general')}
                  className={`inline-flex min-h-[38px] shrink-0 items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-semibold transition-all ${
                    staffView === 'general'
                      ? 'bg-primary text-primary-foreground shadow-sm'
                      : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                  }`}
                >
                  <Users className="h-3.5 w-3.5" />
                  <span>General Team</span>
                  {reportQ.data && (
                    <Badge
                      variant={staffView === 'general' ? 'secondary' : 'outline'}
                      className="ml-0.5 px-1.5 py-0 text-[10px] font-bold"
                    >
                      {reportQ.data.stats.total}
                    </Badge>
                  )}
                </button>

                {CALLING_TEAM_STAFF.map((s) => {
                  const sData = reportQ.data?.perStaff.find((p) => p.person.id === s.id);
                  const active = staffView === s.id;
                  return (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => setStaffView(s.id)}
                      className={`inline-flex min-h-[38px] shrink-0 items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-semibold transition-all ${
                        active
                          ? 'bg-primary text-primary-foreground shadow-sm'
                          : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                      }`}
                    >
                      <UserCheck className="h-3.5 w-3.5" />
                      <span>{s.short}</span>
                      {sData && (
                        <Badge
                          variant={active ? 'secondary' : 'outline'}
                          className="ml-0.5 px-1.5 py-0 text-[10px] font-bold"
                        >
                          {sData.stats.total}
                        </Badge>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Report Content */}
            {reportQ.isLoading ? (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 xl:grid-cols-6">
                  {Array.from({ length: 6 }).map((_, i) => (
                    <Skeleton key={i} className="h-24 w-full rounded-2xl" />
                  ))}
                </div>
                <Skeleton className="h-64 w-full rounded-2xl" />
                <Skeleton className="h-80 w-full rounded-2xl" />
              </div>
            ) : reportQ.isError ? (
              <Card className="rounded-2xl border-destructive/30 bg-destructive/5">
                <CardContent className="flex items-center gap-3 p-5 text-sm text-destructive">
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
