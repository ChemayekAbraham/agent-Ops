import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Switch } from '@/components/ui/switch';
import {
  Headphones,
  ListTodo,
  Phone,
  History,
  BarChart3,
  Clock,
  PhoneIncoming,
  AlertTriangle,
  Sparkles,
  CheckCircle2,
  PhoneOff,
  Flame,
  ArrowUpRight,
  Radio,
  ShieldAlert,
  Settings,
  Users,
  Bookmark,
} from 'lucide-react';
import {
  CC_PAGE_SIZE,
  type CcFilterSelection,
  type CcRow,
  type CcRowState,
  useCcCallingHub,
} from '@/hooks/useCcCallingHub';
import {
  useConcernStaffOptions,
  useForwardedConcerns,
  useReceivedCalls,
} from '@/hooks/useCallingConcerns';
import { CycleControls } from '@/components/ops/calling/CycleControls';
import { OpenAttemptQueue } from '@/components/ops/calling/OpenAttemptQueue';
import { FollowupsDuePanel } from '@/components/ops/calling/FollowupsDuePanel';
import { RecordOutcomeDialog } from '@/components/ops/calling/RecordOutcomeDialog';
import { CallingPausedNotice } from '@/components/executive/crm/call-centre/CallingPausedNotice';
import { formatTalkTime } from '@/lib/callCentre';
import { useSessionPersistedState } from '@/hooks/useSessionPersistedState';
import { useAuth } from '@/hooks/useAuth';
import { useLandlordCallCenterDialer } from './useLandlordCallCenterDialer';
import { LandlordLiveCallPanel } from './LandlordLiveCallPanel';
import { LandlordCallCenterHistory } from './LandlordCallCenterHistory';
import { LandlordCallsReport } from './LandlordCallsReport';
import { LandlordReceivedCallsTab } from './LandlordReceivedCallsTab';
import { LandlordConcernsReviewTab } from './LandlordConcernsReviewTab';
import { LandlordCallDetailsDialog } from './LandlordCallDetailsDialog';
import { LandlordTimelineDrawer } from './LandlordTimelineDrawer';
import {
  type LandlordExtraFilters,
  LandlordWorkQueuePanel,
} from './LandlordWorkQueuePanel';
import {
  type LandlordRegistryRecord,
  useAssignLandlordCallers,
  useLandlordSavedQueues,
} from './useLandlordRegistryBatch';
import { CcEmptyState, CcKpiTile, CcPill, CcSectionCard, formatHumanLabel } from './ccUi';

const ALLOWED_LANDLORD_CC_ROLES = ['landlord_ops', 'operations', 'hr', 'super_admin'] as const;
const ROUND_MANAGER_ROLES = ['operations', 'hr', 'super_admin'] as const;

export function LandlordCallingCenter() {
  const { roles } = useAuth();
  const hasAccess = useMemo(
    () =>
      !roles ||
      roles.length === 0 ||
      roles.some((r) => (ALLOWED_LANDLORD_CC_ROLES as readonly string[]).includes(r)),
    [roles],
  );
  const canManageRounds = useMemo(
    () =>
      Boolean(
        roles?.some((r) => (ROUND_MANAGER_ROLES as readonly string[]).includes(r)),
      ),
    [roles],
  );

  const [tab, setTab] = useSessionPersistedState<string>('lcc:tab', 'overview');
  const [stateFilter, setStateFilter] = useSessionPersistedState<CcRowState | 'all'>('lcc:state', 'all');
  const [search, setSearch] = useSessionPersistedState<string>('lcc:search', '');
  const [filters, setFilters] = useSessionPersistedState<CcFilterSelection>('lcc:filters', {});
  const [extraFilters, setExtraFilters] = useSessionPersistedState<LandlordExtraFilters>(
    'lcc:extraFilters',
    {
      rentPlanStatus: 'all',
      verification: 'all',
      lastOutcome: 'all',
    },
  );
  const [sortKey, setSortKey] = useSessionPersistedState<string | null>('lcc:sort', null);
  const [page, setPage] = useState(0);

  const [inspectRow, setInspectRow] = useState<CcRow | null>(null);
  const [timelineTarget, setTimelineTarget] = useState<{
    subjectId: string;
    landlordId?: string | null;
    userId?: string | null;
    name?: string | null;
    phones?: string[] | null;
  } | null>(null);

  const [activeAttempt, setActiveAttempt] = useState<{
    id: string;
    cycle_row_id: string;
    name: string;
  } | null>(null);

  const hub = useCcCallingHub('landlord', {
    state: stateFilter,
    search,
    filters,
    sortKey,
    page,
  });

  const dialer = useLandlordCallCenterDialer(hub);
  const { callingPaused } = dialer;

  const receivedCalls = useReceivedCalls(30);
  const openConcerns = useForwardedConcerns({ days: 60, scope: 'all' });
  const staffOptions = useConcernStaffOptions();
  const savedQueues = useLandlordSavedQueues();
  const assignCallers = useAssignLandlordCallers();
  const [selectedCallerIds, setSelectedCallerIds] = useState<string[]>([]);

  const counts = hub.totalCounts;
  const openAttemptsCount = (hub.openAttempts ?? []).length;
  const followupsCount = (hub.followups ?? []).length;

  const landlordConcerns = useMemo(
    () => (openConcerns.data ?? []).filter((c) => !c.subject_type || c.subject_type === 'landlord'),
    [openConcerns.data],
  );
  const unresolvedConcernsCount = landlordConcerns.filter(
    (c) => c.status !== 'completed',
  ).length;
  const urgentConcernsCount = landlordConcerns.filter(
    (c) => c.status !== 'completed' && (c.priority === 'critical' || c.priority === 'high'),
  ).length;
  const inboundFollowupsCount = (receivedCalls.data ?? []).filter(
    (r) => (!r.linked_kind || r.linked_kind === 'landlord') && r.status === 'open',
  ).length;

  const isCallLive = dialer.live;

  const handleDialRow = async (row: CcRow) => {
    const started = await dialer.dial(row);
    if (started) setTab('live');
  };

  const resetFilters = () => {
    setFilters({});
    setExtraFilters({
      rentPlanStatus: 'all',
      verification: 'all',
      lastOutcome: 'all',
    });
    setSortKey(null);
    setSearch('');
    setStateFilter('all');
    setPage(0);
  };

  const handleFairCallerSplit = async () => {
    const cycleId = hub.cycle?.id;
    if (!cycleId) {
      toast.error('Open a calling round first before splitting callers.');
      return;
    }
    if (selectedCallerIds.length === 0) {
      toast.error('Select at least one staff member to split the round across.');
      return;
    }
    try {
      const res = await assignCallers.mutateAsync({
        cycleId,
        staffIds: selectedCallerIds,
      });
      toast.success(
        `Assigned ${res.assigned_rows} pending landlords across ${res.staff_count} caller(s).`,
      );
    } catch (e: any) {
      toast.error(e?.message || 'Could not assign callers');
    }
  };

  if (!hasAccess) {
    return (
      <div className="p-6 max-w-lg mx-auto">
        <CcSectionCard
          title="Landlord Calling Center Access Restricted"
          subtitle="Authorized roles: Landlord Ops, Operations, HR, and Super Admin"
          icon={ShieldAlert}
          tone="rose"
        >
          <p className="text-xs text-muted-foreground">
            Your account does not currently have permission to open the Landlord Ops Calling Center. Please contact Operations or an Administrator if you need access.
          </p>
        </CcSectionCard>
      </div>
    );
  }

  const totalRound =
    (counts?.to_call ?? 0) +
    (counts?.engaged ?? 0) +
    (counts?.unreachable ?? 0) +
    (counts?.parked ?? 0) +
    (counts?.callback ?? 0);
  const resolvedRound = counts?.engaged ?? 0;
  const progressPct = totalRound > 0 ? Math.round((resolvedRound / totalRound) * 100) : 0;
  const pendingReady = (counts?.to_call ?? 0) + (counts?.unreachable ?? 0) + (counts?.callback ?? 0);

  return (
    <div className="space-y-4">
      <CallingPausedNotice />

      {/* Hero command header */}
      <div className="relative overflow-hidden rounded-2xl border border-primary/25 bg-gradient-to-br from-primary/10 via-card to-card p-4 sm:p-5 shadow-xs">
        <div
          aria-hidden
          className="pointer-events-none absolute -top-20 -right-16 h-56 w-56 rounded-full bg-primary/15 blur-3xl"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -bottom-24 left-1/3 h-48 w-48 rounded-full bg-emerald-500/10 blur-3xl"
        />

        <div className="relative flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3 min-w-0">
            <div className="h-11 w-11 rounded-2xl bg-primary text-primary-foreground shadow-sm ring-4 ring-primary/15 flex items-center justify-center shrink-0">
              <Headphones className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-base sm:text-xl font-bold tracking-tight text-foreground">
                  Landlord Calling Center
                </h1>
                <CcPill tone="emerald" icon={Radio} pulse>
                  Registry Calling Engine
                </CcPill>
                {hub.cycle?.title && (
                  <CcPill tone="primary" icon={Sparkles}>
                    Round #{hub.cycle.cycle_number} · {hub.cycle.title}
                  </CcPill>
                )}
              </div>
              <p className="text-xs text-muted-foreground mt-1 max-w-2xl">
                Reach every registered landlord across Rent Plans, house listings, and payout reviews · verify payout numbers · log inbound calls & resolve landlord issues.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            {dialer.current ? (
              <Button
                size="sm"
                variant={isCallLive ? 'default' : 'secondary'}
                onClick={() => setTab('live')}
                className="gap-1.5 rounded-xl shadow-xs animate-pulse"
              >
                <Phone className="h-3.5 w-3.5" />
                {isCallLive
                  ? `On Call · ${dialer.current.name} (${formatTalkTime(dialer.call.elapsed)})`
                  : `Log Outcome · ${dialer.current.name}`}
              </Button>
            ) : !callingPaused ? (
              <Button
                size="sm"
                onClick={async () => {
                  const s = await dialer.dialNextPending();
                  if (s) setTab('live');
                }}
                disabled={dialer.isRevealing || pendingReady === 0}
                className="gap-1.5 rounded-xl shadow-sm"
              >
                <Phone className="h-3.5 w-3.5" />
                Start Calling ({pendingReady} ready)
              </Button>
            ) : null}
          </div>
        </div>

        {/* Round progress bar */}
        {totalRound > 0 && (
          <div className="relative mt-4 rounded-xl border border-border/60 bg-background/70 backdrop-blur-xs px-3.5 py-2.5">
            <div className="flex items-center justify-between gap-2 text-xs mb-1.5">
              <span className="font-medium text-foreground flex items-center gap-1.5">
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                Active Landlord Round Completion
              </span>
              <span className="tabular-nums font-semibold text-foreground">
                {resolvedRound} / {totalRound} landlords engaged{' '}
                <span className="text-muted-foreground font-normal">({progressPct}%)</span>
              </span>
            </div>
            <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
              <div
                className="h-full rounded-full bg-gradient-to-r from-primary via-emerald-500 to-emerald-400 transition-all duration-500"
                style={{ width: `${progressPct}%` }}
              />
            </div>
          </div>
        )}
      </div>

      {/* Main 8-Tab Navigation: Overview, Work Queue, Live Call, Received Calls, Issues Review, History, Reports, Settings */}
      <Tabs value={tab} onValueChange={setTab} className="space-y-4">
        <div className="overflow-x-auto -mx-1 px-1">
          <TabsList className="h-auto p-1 bg-muted/60 backdrop-blur-xs rounded-2xl border border-border/60 inline-flex w-auto min-w-full sm:min-w-0 gap-1">
            <TabsTrigger
              value="overview"
              className="text-xs gap-1.5 rounded-xl px-3 py-2 data-[state=active]:bg-background data-[state=active]:shadow-xs"
            >
              <Sparkles className="h-3.5 w-3.5" /> Overview
            </TabsTrigger>
            <TabsTrigger
              value="queue"
              className="text-xs gap-1.5 rounded-xl px-3 py-2 data-[state=active]:bg-background data-[state=active]:shadow-xs"
            >
              <ListTodo className="h-3.5 w-3.5" /> Work Queue
              {totalRound > 0 ? (
                <Badge variant="secondary" className="h-4 px-1.5 text-[10px] rounded-full">
                  {totalRound}
                </Badge>
              ) : null}
            </TabsTrigger>
            <TabsTrigger
              value="live"
              className="text-xs gap-1.5 rounded-xl px-3 py-2 data-[state=active]:bg-background data-[state=active]:shadow-xs"
            >
              <Phone className="h-3.5 w-3.5" /> Live Call
              {(dialer.current || openAttemptsCount > 0) && (
                <Badge
                  variant={dialer.current ? 'default' : 'destructive'}
                  className="h-4 px-1.5 text-[10px] rounded-full"
                >
                  {dialer.current ? 'LIVE' : openAttemptsCount}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger
              value="received"
              className="text-xs gap-1.5 rounded-xl px-3 py-2 data-[state=active]:bg-background data-[state=active]:shadow-xs"
            >
              <PhoneIncoming className="h-3.5 w-3.5" /> Received Calls
              {inboundFollowupsCount > 0 && (
                <Badge variant="secondary" className="h-4 px-1.5 text-[10px] rounded-full">
                  {inboundFollowupsCount}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger
              value="concerns"
              className="text-xs gap-1.5 rounded-xl px-3 py-2 data-[state=active]:bg-background data-[state=active]:shadow-xs"
            >
              <AlertTriangle className="h-3.5 w-3.5" /> Issues Review
              {unresolvedConcernsCount > 0 && (
                <Badge variant="destructive" className="h-4 px-1.5 text-[10px] rounded-full">
                  {unresolvedConcernsCount}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger
              value="history"
              className="text-xs gap-1.5 rounded-xl px-3 py-2 data-[state=active]:bg-background data-[state=active]:shadow-xs"
            >
              <History className="h-3.5 w-3.5" /> History
            </TabsTrigger>
            <TabsTrigger
              value="reports"
              className="text-xs gap-1.5 rounded-xl px-3 py-2 data-[state=active]:bg-background data-[state=active]:shadow-xs"
            >
              <BarChart3 className="h-3.5 w-3.5" /> Reports
            </TabsTrigger>
            <TabsTrigger
              value="settings"
              className="text-xs gap-1.5 rounded-xl px-3 py-2 data-[state=active]:bg-background data-[state=active]:shadow-xs"
            >
              <Settings className="h-3.5 w-3.5" /> Settings
            </TabsTrigger>
          </TabsList>
        </div>

        {/* OVERVIEW TAB */}
        <TabsContent value="overview" className="space-y-4">
          {canManageRounds && <CycleControls hub={hub} />}

          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5">
            <CcKpiTile
              label="Total in Round"
              value={totalRound}
              sublabel="Registered landlords"
              icon={ListTodo}
              tone="slate"
              onClick={() => {
                setStateFilter('all');
                setTab('queue');
              }}
            />
            <CcKpiTile
              label="Ready to Call"
              value={counts?.to_call ?? 0}
              sublabel="Pending first dial"
              icon={Phone}
              tone="primary"
              onClick={() => {
                setStateFilter('to_call');
                setTab('queue');
              }}
            />
            <CcKpiTile
              label="Retry Needed"
              value={counts?.unreachable ?? 0}
              sublabel="Unreachable / busy"
              icon={PhoneOff}
              tone="amber"
              onClick={() => {
                setStateFilter('unreachable');
                setTab('queue');
              }}
            />
            <CcKpiTile
              label="Engaged"
              value={counts?.engaged ?? 0}
              sublabel={`${progressPct}% round completion`}
              icon={CheckCircle2}
              tone="emerald"
              progress={progressPct}
              onClick={() => {
                setStateFilter('engaged');
                setTab('queue');
              }}
            />
            <CcKpiTile
              label="Follow-ups Due"
              value={followupsCount}
              sublabel="Scheduled callbacks"
              icon={Clock}
              tone={followupsCount > 0 ? 'violet' : 'slate'}
              onClick={() => setTab('queue')}
            />
            <CcKpiTile
              label="Open Issues"
              value={unresolvedConcernsCount}
              sublabel={
                urgentConcernsCount > 0
                  ? `${urgentConcernsCount} high / critical`
                  : 'Awaiting review'
              }
              icon={urgentConcernsCount > 0 ? Flame : AlertTriangle}
              tone={
                urgentConcernsCount > 0
                  ? 'rose'
                  : unresolvedConcernsCount > 0
                    ? 'amber'
                    : 'slate'
              }
              onClick={() => setTab('concerns')}
            />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
            <CcSectionCard
              title="Outbound Queue & Dialing"
              subtitle="Work through landlords by Rent Plan value, region, district, or verification status"
              icon={Phone}
              tone="primary"
              actions={
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs gap-1"
                  onClick={() => setTab('queue')}
                >
                  Open Queue <ArrowUpRight className="h-3.5 w-3.5" />
                </Button>
              }
            >
              <div className="space-y-3 text-xs">
                <p className="text-muted-foreground leading-relaxed">
                  <strong>{pendingReady}</strong> landlords are ready to be called right now. Click any row to inspect their Houses, Tenants, Rent Plans, and Payout Number before dialing.
                </p>
                <div className="flex flex-wrap gap-2">
                  {!callingPaused && (
                    <Button
                      size="sm"
                      onClick={async () => {
                        const s = await dialer.dialNextPending();
                        if (s) setTab('live');
                      }}
                      disabled={dialer.isRevealing || pendingReady === 0}
                      className="gap-1.5 rounded-xl"
                    >
                      <Phone className="h-3.5 w-3.5" /> Dial Next Landlord
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setTab('queue')}
                    className="rounded-xl"
                  >
                    Browse Full Queue
                  </Button>
                </div>
              </div>
            </CcSectionCard>

            <CcSectionCard
              title="Inbound Landlord Calls"
              subtitle="Capture calls when landlords reach out directly"
              icon={PhoneIncoming}
              tone="sky"
              actions={
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs gap-1"
                  onClick={() => setTab('received')}
                >
                  Open Log <ArrowUpRight className="h-3.5 w-3.5" />
                </Button>
              }
            >
              <div className="space-y-3 text-xs">
                <p className="text-muted-foreground leading-relaxed">
                  <strong>{(receivedCalls.data ?? []).length}</strong> inbound calls logged ·{' '}
                  <strong className="text-amber-600">{inboundFollowupsCount}</strong> open for follow-up.
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setTab('received')}
                  className="gap-1.5 rounded-xl"
                >
                  <PhoneIncoming className="h-3.5 w-3.5" /> Log or Review Inbound Calls
                </Button>
              </div>
            </CcSectionCard>

            <CcSectionCard
              title="Landlord Issues & Escalations"
              subtitle="Payout inquiries, property disputes, and requests for more tenants"
              icon={AlertTriangle}
              tone={unresolvedConcernsCount > 0 ? 'rose' : 'emerald'}
              actions={
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs gap-1"
                  onClick={() => setTab('concerns')}
                >
                  Review <ArrowUpRight className="h-3.5 w-3.5" />
                </Button>
              }
            >
              <div className="space-y-3 text-xs">
                <p className="text-muted-foreground leading-relaxed">
                  <strong className="text-destructive">{unresolvedConcernsCount}</strong> open landlord issue(s) need attention ({urgentConcernsCount} high / critical priority).
                </p>
                <Button
                  size="sm"
                  variant={unresolvedConcernsCount > 0 ? 'default' : 'outline'}
                  onClick={() => setTab('concerns')}
                  className="gap-1.5 rounded-xl"
                >
                  <AlertTriangle className="h-3.5 w-3.5" /> Open Issues Queue
                </Button>
              </div>
            </CcSectionCard>
          </div>

          <OpenAttemptQueue hub={hub} onOpenForm={(a) => setActiveAttempt(a)} />
          <FollowupsDuePanel hub={hub} />
        </TabsContent>

        {/* WORK QUEUE TAB */}
        <TabsContent value="queue" className="space-y-3">
          <OpenAttemptQueue hub={hub} onOpenForm={(a) => setActiveAttempt(a)} />
          <LandlordWorkQueuePanel
            hub={hub}
            callingPaused={callingPaused}
            isRevealing={dialer.isRevealing}
            stateFilter={stateFilter}
            onStateFilterChange={setStateFilter}
            search={search}
            onSearchChange={setSearch}
            filters={filters}
            onFiltersChange={setFilters}
            extraFilters={extraFilters}
            onExtraFiltersChange={setExtraFilters}
            sortKey={sortKey}
            onSortKeyChange={setSortKey}
            page={page}
            pageSize={CC_PAGE_SIZE}
            onPageChange={setPage}
            onResetFilters={resetFilters}
            onDialRow={(row) => void handleDialRow(row)}
            onInspectRow={(row) => setInspectRow(row)}
            onOpenTimeline={(row, reg?: LandlordRegistryRecord | null) =>
              setTimelineTarget({
                subjectId: row.subject_id,
                landlordId: reg?.landlord_id ?? row.subject_id,
                userId: reg?.user_id ?? null,
                name: row.name || reg?.full_name || 'Landlord',
                phones: reg?.phones ?? null,
              })
            }
          />
        </TabsContent>

        {/* LIVE CALL TAB */}
        <TabsContent value="live" className="space-y-3">
          <LandlordLiveCallPanel hub={hub} dialer={dialer} />
          <OpenAttemptQueue hub={hub} onOpenForm={(a) => setActiveAttempt(a)} />
        </TabsContent>

        {/* RECEIVED CALLS TAB */}
        <TabsContent value="received">
          <LandlordReceivedCallsTab />
        </TabsContent>

        {/* ISSUES REVIEW TAB */}
        <TabsContent value="concerns">
          <LandlordConcernsReviewTab />
        </TabsContent>

        {/* HISTORY TAB */}
        <TabsContent value="history">
          <LandlordCallCenterHistory cycleId={hub.cycle?.id} hub={hub} />
        </TabsContent>

        {/* REPORTS TAB */}
        <TabsContent value="reports">
          <LandlordCallsReport hub={hub} />
        </TabsContent>

        {/* SETTINGS TAB */}
        <TabsContent value="settings" className="space-y-4">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <CcSectionCard
              title="Dialer & Calling Preferences"
              subtitle="Personal calling behavior and system calling status"
              icon={Settings}
              tone="primary"
            >
              <div className="space-y-3 text-xs">
                {callingPaused ? (
                  <CallingPausedNotice />
                ) : (
                  <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 flex items-center justify-between">
                    <div>
                      <div className="font-semibold text-emerald-700 dark:text-emerald-300">
                        In-App Human Calling Active
                      </div>
                      <div className="text-[11px] text-muted-foreground">
                        Browser voice calling is enabled for landlords with a linked user account.
                      </div>
                    </div>
                    <CcPill tone="emerald" pulse>
                      Active
                    </CcPill>
                  </div>
                )}

                <div className="flex items-center justify-between rounded-xl border p-3">
                  <div>
                    <div className="font-semibold text-foreground">
                      Auto-Advance to Next Pending Landlord
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                      Automatically dial the next pending landlord after logging a call outcome
                    </div>
                  </div>
                  <Switch
                    checked={dialer.autoAdvance}
                    onCheckedChange={dialer.setAutoAdvance}
                    disabled={callingPaused}
                  />
                </div>
              </div>
            </CcSectionCard>

            <CcSectionCard
              title="Saved Queue Views"
              subtitle="Quick-load filter & sort presets for Landlord Ops"
              icon={Bookmark}
              tone="violet"
            >
              {(savedQueues.data ?? []).length === 0 ? (
                <CcEmptyState
                  icon={Bookmark}
                  title="No saved queues yet"
                  description="Use the 'Save Queue' button in the Work Queue tab to save your favorite region, district, or verification filters."
                />
              ) : (
                <div className="space-y-2 text-xs">
                  {(savedQueues.data ?? []).map((q) => (
                    <div
                      key={q.id}
                      className="rounded-lg border p-2.5 flex items-center justify-between gap-2"
                    >
                      <div className="min-w-0">
                        <div className="font-semibold truncate">{q.name}</div>
                        <div className="text-[11px] text-muted-foreground">
                          {q.shared ? 'Shared with Landlord Ops' : 'Private queue'} ·{' '}
                          {q.owner_name || 'Staff'}
                          {q.sort_key ? ` · Sort: ${formatHumanLabel(q.sort_key)}` : ''}
                        </div>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs"
                        onClick={() => {
                          const saved = q.filters ?? {};
                          const {
                            __rentPlanStatus,
                            __verification,
                            __lastOutcome,
                            __stateFilter,
                            __search,
                            ...serverFilters
                          } = saved;
                          setFilters(serverFilters);
                          setExtraFilters({
                            rentPlanStatus: __rentPlanStatus ?? 'all',
                            verification: __verification ?? 'all',
                            lastOutcome: __lastOutcome ?? 'all',
                          });
                          if (__stateFilter) setStateFilter(__stateFilter);
                          if (typeof __search === 'string') setSearch(__search);
                          if (q.sort_key) setSortKey(q.sort_key);
                          setTab('queue');
                        }}
                      >
                        Load in Queue
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </CcSectionCard>
          </div>

          {/* Round Controls & Fair Caller Split (gated to operations / hr / super_admin) */}
          {canManageRounds ? (
            <div className="space-y-4">
              <CycleControls hub={hub} />

              <CcSectionCard
                title="Advisory Caller Split"
                subtitle="Available to Operations, HR, and Super Admin — split pending landlords evenly without locking out other callers"
                icon={Users}
                tone="emerald"
              >
                <div className="space-y-3 text-xs">
                  <p className="text-muted-foreground">
                    Select the staff members on shift below to distribute pending landlords in the active round evenly across callers. Assignments are advisory and never block other officers from helping.
                  </p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2 max-h-52 overflow-y-auto p-1">
                    {(staffOptions.data ?? []).map((staff) => {
                      const checked = selectedCallerIds.includes(staff.user_id);
                      return (
                        <label
                          key={staff.user_id}
                          className="flex items-center gap-2 rounded-lg border px-2.5 py-2 cursor-pointer hover:bg-muted/40"
                        >
                          <Checkbox
                            checked={checked}
                            onCheckedChange={(v) => {
                              if (v) {
                                setSelectedCallerIds((prev) => [...prev, staff.user_id]);
                              } else {
                                setSelectedCallerIds((prev) =>
                                  prev.filter((id) => id !== staff.user_id),
                                );
                              }
                            }}
                          />
                          <div className="min-w-0">
                            <div className="font-medium truncate">{staff.full_name}</div>
                          </div>
                        </label>
                      );
                    })}
                  </div>
                  <div className="flex items-center justify-between pt-2 border-t">
                    <span className="text-muted-foreground">
                      {selectedCallerIds.length} caller(s) selected
                    </span>
                    <Button
                      size="sm"
                      disabled={
                        assignCallers.isPending ||
                        !hub.cycle?.id ||
                        selectedCallerIds.length === 0
                      }
                      onClick={handleFairCallerSplit}
                    >
                      {assignCallers.isPending
                        ? 'Assigning Callers…'
                        : 'Split Pending Round Across Selected Callers'}
                    </Button>
                  </div>
                </div>
              </CcSectionCard>
            </div>
          ) : (
            <CcSectionCard
              title="Round Management"
              subtitle="Round creation, top-up, closure, and caller splits are managed by Operations, HR, or Super Admin"
              icon={Users}
              tone="slate"
            >
              <p className="text-xs text-muted-foreground">
                You have full calling, queue filtering, and issue-forwarding access. Contact Operations or HR to open a new landlord calling round or close the current round.
              </p>
            </CcSectionCard>
          )}
        </TabsContent>
      </Tabs>

      <RecordOutcomeDialog
        hub={hub}
        attempt={activeAttempt}
        onClose={() => setActiveAttempt(null)}
      />

      {inspectRow && (
        <LandlordCallDetailsDialog
          row={inspectRow}
          subjectId={inspectRow.subject_id}
          subjectName={inspectRow.name}
          district={inspectRow.district}
          agentName={inspectRow.linked_agent}
          open={!!inspectRow}
          onOpenChange={(v) => !v && setInspectRow(null)}
          onDialNow={(r) => void handleDialRow(r)}
          hub={hub}
        />
      )}

      <LandlordTimelineDrawer
        open={Boolean(timelineTarget)}
        onOpenChange={(v) => !v && setTimelineTarget(null)}
        subjectId={timelineTarget?.subjectId ?? null}
        landlordId={timelineTarget?.landlordId}
        userId={timelineTarget?.userId}
        landlordName={timelineTarget?.name}
        phones={timelineTarget?.phones}
      />
    </div>
  );
}
