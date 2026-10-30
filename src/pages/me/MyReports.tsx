import { useMemo, useState } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { AlertCircle, FileBarChart, ShieldAlert, UserCheck, Users } from 'lucide-react';
import PersonalLayout from '@/components/layout/PersonalLayout';
import { V360StaffPricingBanner } from '@/components/v360/V360StaffPricingBanner';
import { useAuth } from '@/hooks/useAuth';
import { kampalaTodayYmd } from '@/lib/kampalaDays';
import {
  buildMonthPeriodWindow,
  buildWeekPeriodWindow,
  CALLING_TEAM_STAFF,
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
  const { user } = useAuth();
  const todayYmd = kampalaTodayYmd();

  const [mode, setMode] = useState<StaffReportPeriodMode>('month');
  const [weekStart, setWeekStart] = useState<string>(() => getWedWeekStartYmd(todayYmd));
  const [yearMonth, setYearMonth] = useState<string>(() => todayYmd.slice(0, 7) || '2026-10');

  const currentStaff = useMemo(() => getCallingStaffByUserId(user?.id), [user?.id]);
  const isJaneHead = isCallingTeamHead(user?.id);

  const [activeTab, setActiveTab] = useState<string>('my');

  const periodWindow = useMemo(
    () => (mode === 'week' ? buildWeekPeriodWindow(weekStart) : buildMonthPeriodWindow(yearMonth, todayYmd)),
    [mode, weekStart, yearMonth, todayYmd],
  );

  // Strictly accessible to the 3 calling staff (Jane, Winnie, Hanisha)
  const canAccessPage = Boolean(currentStaff);
  const reportQ = useStaffCallingReport(periodWindow, canAccessPage);

  const myPerson = currentStaff ?? CALLING_TEAM_STAFF.find((s) => s.id === JANE_USER_ID)!;
  const myReportData = useMemo(
    () => reportQ.data?.perStaff.find((s) => s.person.id === myPerson.id) ?? null,
    [reportQ.data, myPerson.id],
  );

  if (!canAccessPage) {
    return (
      <PersonalLayout title="My reports">
        <Card className="rounded-2xl border-destructive/30 bg-destructive/5">
          <CardContent className="flex items-center gap-3 p-5 text-sm text-destructive sm:p-6">
            <ShieldAlert className="h-5 w-5 shrink-0" />
            <div>
              <p className="font-semibold">My Calling Reports is restricted to the Calling &amp; Pipeline Team</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                This workspace is strictly available to Jane, Winnie, and Hanisha in their personal My Space.
              </p>
            </div>
          </CardContent>
        </Card>
      </PersonalLayout>
    );
  }

  return (
    <PersonalLayout title="My reports">
      <div className="space-y-4 sm:space-y-5">
        <V360StaffPricingBanner />
        {/* Mobile-First Header */}
        <div className="rounded-2xl border border-border/70 bg-card p-4 shadow-sm sm:p-5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <FileBarChart className="h-4 w-4" />
            </span>
            <h1 className="text-base font-bold tracking-tight sm:text-xl">
              My Calling &amp; Pipeline Reports
            </h1>
            <Badge variant="secondary" className="border-primary/30 bg-primary/10 text-[11px] font-semibold text-primary">
              {isJaneHead ? 'Team Head (Jane)' : myPerson.short}
            </Badge>
          </div>
          <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground sm:text-sm">
            {isJaneHead
              ? 'View your personal calling report, the General Team report, and individual reports for Winnie and Hanisha across Tenant Ops & Landlord Ops.'
              : `Your verified calling & Rent Plan pipeline feedback report (${myPerson.display}) across Tenant Ops & Landlord Ops.`}
          </p>
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
                <p className="font-semibold">Could not load calling report</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {(reportQ.error as any)?.message || 'Please try refreshing the report.'}
                </p>
              </div>
            </CardContent>
          </Card>
        ) : reportQ.data ? (
          isJaneHead ? (
            /* Jane (Head) sees her own report + General Team tab + Winnie & Hanisha tabs */
            <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
              <div className="-mx-1 overflow-x-auto px-1 pb-1">
                <TabsList className="inline-flex h-auto min-w-full justify-start gap-1.5 rounded-2xl border border-border/70 bg-muted/50 p-1.5 sm:min-w-0 sm:flex-wrap">
                  <TabsTrigger
                    value="my"
                    className="min-h-[38px] shrink-0 gap-1.5 rounded-xl px-3 text-xs font-semibold data-[state=active]:shadow-sm sm:text-sm"
                  >
                    <UserCheck className="h-3.5 w-3.5" />
                    <span>My Report ({myPerson.short})</span>
                    {myReportData && (
                      <Badge variant="secondary" className="ml-0.5 px-1.5 py-0 text-[10px] font-bold">
                        {myReportData.stats.total}
                      </Badge>
                    )}
                  </TabsTrigger>

                  <TabsTrigger
                    value="general"
                    className="min-h-[38px] shrink-0 gap-1.5 rounded-xl px-3 text-xs font-semibold data-[state=active]:shadow-sm sm:text-sm"
                  >
                    <Users className="h-3.5 w-3.5" />
                    <span>General Team</span>
                    <Badge variant="secondary" className="ml-0.5 px-1.5 py-0 text-[10px] font-bold">
                      {reportQ.data.stats.total}
                    </Badge>
                  </TabsTrigger>

                  {CALLING_TEAM_STAFF.filter((s) => s.id !== myPerson.id).map((s) => {
                    const sData = reportQ.data.perStaff.find((p) => p.person.id === s.id);
                    return (
                      <TabsTrigger
                        key={s.id}
                        value={s.id}
                        className="min-h-[38px] shrink-0 gap-1.5 rounded-xl px-3 text-xs font-semibold data-[state=active]:shadow-sm sm:text-sm"
                      >
                        <span>{s.short}&apos;s Report</span>
                        {sData && (
                          <Badge variant="outline" className="ml-0.5 px-1.5 py-0 text-[10px] font-bold">
                            {sData.stats.total}
                          </Badge>
                        )}
                      </TabsTrigger>
                    );
                  })}
                </TabsList>
              </div>

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
            /* Winnie and Hanisha see ONLY their own report */
            myReportData && (
              <IndividualStaffReportPanel data={myReportData} periodWindow={periodWindow} />
            )
          )
        ) : null}
      </div>
    </PersonalLayout>
  );
}
