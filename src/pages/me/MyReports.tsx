import { useMemo, useState } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { AlertCircle, FileBarChart, ShieldAlert, UserCheck, Users } from 'lucide-react';
import PersonalLayout from '@/components/layout/PersonalLayout';
import { useAuth } from '@/hooks/useAuth';
import { kampalaTodayYmd } from '@/lib/kampalaDays';
import {
  buildMonthPeriodWindow,
  buildWeekPeriodWindow,
  CALLING_TEAM_STAFF,
  canAccessHrStaffReports,
  getCallingStaffByUserId,
   getWedWeekStartYmd,
  isCallingTeamHead,
  JANE_USER_ID,
  useStaffCallingReport,
  type StaffReportPeriodMode,
} from '@/hooks/useStaffCallingReport';
import {
  CallingReportPeriodBar,
  GeneralTeamReportPanel,
  IndividualStaffReportPanel,
} from '@/components/me/StaffCallingReportWorkspace';

export default function MyReportsPage() {
  const { user, roles } = useAuth();
  const todayYmd = kampalaTodayYmd();

  const [mode, setMode] = useState<StaffReportPeriodMode>('month');
  const [weekStart, setWeekStart] = useState<string>(() => getWedWeekStartYmd(todayYmd));
  const [yearMonth, setYearMonth] = useState<string>(() => todayYmd.slice(0, 7) || '2026-10');

  const currentStaff = useMemo(() => getCallingStaffByUserId(user?.id), [user?.id]);
  const isJaneHead = isCallingTeamHead(user?.id);
  const isHrOrOverseer = canAccessHrStaffReports(user?.id, roles);
  const canViewTeam = isJaneHead || isHrOrOverseer;

  const [activeTab, setActiveTab] = useState<string>('my');

  const periodWindow = useMemo(
    () => (mode === 'week' ? buildWeekPeriodWindow(weekStart) : buildMonthPeriodWindow(yearMonth, todayYmd)),
    [mode, weekStart, yearMonth, todayYmd],
  );

  const canAccessPage = Boolean(currentStaff) || isHrOrOverseer;
  const reportQ = useStaffCallingReport(periodWindow, canAccessPage);

  // Target individual staff report for the "My Calling Report" tab (defaults to Jane if opened by HR/overseer)
  const myPerson = currentStaff ?? CALLING_TEAM_STAFF.find((s) => s.id === JANE_USER_ID)!;
  const myReportData = useMemo(
    () => reportQ.data?.perStaff.find((s) => s.person.id === myPerson.id) ?? null,
    [reportQ.data, myPerson.id],
  );

  if (!canAccessPage) {
    return (
      <PersonalLayout title="My reports">
        <Card className="border-destructive/30 bg-destructive/5">
          <CardContent className="flex items-center gap-3 p-6 text-sm text-destructive">
            <ShieldAlert className="h-5 w-5 shrink-0" />
            <div>
              <p className="font-semibold">My Calling Reports is restricted to the Calling & Pipeline Team</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                This workspace is available to Jane, Winnie, Hanisha, and HR / Operations oversight.
              </p>
            </div>
          </CardContent>
        </Card>
      </PersonalLayout>
    );
  }

  return (
    <PersonalLayout title="My reports">
      <div className="space-y-5">
        {/* Page Header */}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <FileBarChart className="h-5 w-5 text-primary" />
              <h1 className="text-lg font-bold tracking-tight sm:text-xl">
                My Calling & Pipeline Feedback Reports
              </h1>
              {isJaneHead && (
                <Badge variant="secondary" className="border-primary/30 bg-primary/10 text-primary">
                  Team Head (Jane)
                </Badge>
              )}
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground sm:text-sm">
              Every call, verified phone number, and Rent Plan pipeline feedback across Tenant Ops & Landlord Ops
              (Calling Centers & Rent Pipelines). Filter by Wednesday–Tuesday week or specific calendar month.
            </p>
          </div>
        </div>

        {/* Period Selector Bar (Week Wed-Tue & Specific Month) */}
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
        />

        {/* Loading / Error / Content */}
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
                <p className="font-semibold">Could not load calling report</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {(reportQ.error as any)?.message || 'Please try refreshing the report.'}
                </p>
              </div>
            </CardContent>
          </Card>
        ) : reportQ.data ? (
          canViewTeam ? (
            <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
              <TabsList className="flex h-auto flex-wrap justify-start gap-1.5 bg-muted/60 p-1.5">
                <TabsTrigger value="my" className="gap-1.5 text-xs sm:text-sm">
                  <UserCheck className="h-3.5 w-3.5" />
                  My Calling Report ({myPerson.short})
                  {myReportData && (
                    <Badge variant="secondary" className="ml-1 px-1.5 py-0 text-[10px]">
                      {myReportData.stats.total}
                    </Badge>
                  )}
                </TabsTrigger>

                <TabsTrigger value="general" className="gap-1.5 text-xs sm:text-sm">
                  <Users className="h-3.5 w-3.5" />
                  General Team Report (Jane, Winnie & Hanisha)
                  <Badge variant="secondary" className="ml-1 px-1.5 py-0 text-[10px]">
                    {reportQ.data.stats.total}
                  </Badge>
                </TabsTrigger>

                {CALLING_TEAM_STAFF.filter((s) => s.id !== myPerson.id).map((s) => {
                  const sData = reportQ.data.perStaff.find((p) => p.person.id === s.id);
                  return (
                    <TabsTrigger key={s.id} value={s.id} className="gap-1.5 text-xs sm:text-sm">
                      {s.short}&apos;s Report
                      {sData && (
                        <Badge variant="outline" className="ml-1 px-1.5 py-0 text-[10px]">
                          {sData.stats.total}
                        </Badge>
                      )}
                    </TabsTrigger>
                  );
                })}
              </TabsList>

              <TabsContent value="my" className="mt-0">
                {myReportData && (
                  <IndividualStaffReportPanel data={myReportData} periodWindow={periodWindow} />
                )}
              </TabsContent>

              <TabsContent value="general" className="mt-0">
                <GeneralTeamReportPanel
                  teamData={reportQ.data}
                  periodWindow={periodWindow}
                  onSelectStaffTab={(staffId) =>
                    setActiveTab(staffId === myPerson.id ? 'my' : staffId)
                  }
                />
              </TabsContent>

              {CALLING_TEAM_STAFF.filter((s) => s.id !== myPerson.id).map((s) => {
                const sData = reportQ.data.perStaff.find((p) => p.person.id === s.id);
                return (
                  <TabsContent key={s.id} value={s.id} className="mt-0">
                    {sData && <IndividualStaffReportPanel data={sData} periodWindow={periodWindow} />}
                  </TabsContent>
                );
              })}
            </Tabs>
          ) : (
            myReportData && (
              <IndividualStaffReportPanel data={myReportData} periodWindow={periodWindow} />
            )
          )
        ) : null}
      </div>
    </PersonalLayout>
  );
}
