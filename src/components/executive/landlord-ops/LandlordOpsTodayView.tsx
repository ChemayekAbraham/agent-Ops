import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useSearchParams } from 'react-router-dom';
import {
  Home,
  User,
  UserCheck,
  Users,

  FileText,
  ChevronRight,
  Wallet,
  Info,
  CheckCircle2,
  Clock,
  ArrowRight,
  Layers,
  GitBranch,
  Banknote,
  Wrench,
  AlertCircle,
  ExternalLink,
  ChevronDown,
  Loader2,
} from 'lucide-react';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  PieChart,
  Pie,
  Cell,
} from 'recharts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useLandlordOpsTotals } from '@/hooks/useLandlordOps';
import { useLandlordOpsBadgeCounts } from '@/hooks/useLandlordOpsBadgeCounts';
import { useLandlordFloatOverview } from '@/hooks/useLandlordFloatOverview';
import {
  useLandlordOpsActivity,
  useLandlordOpsRecentDecisions,
  useLandlordOpsNewToday,
  useLandlordOpsWalletImpact,
  useLandlordOpsNoLandlordCount,
  type LandlordOpsDecision,
} from '@/hooks/useLandlordOpsToday';
import { formatUGX } from '@/lib/rentCalculations';

interface TodayViewProps {
  onNavigate: (path: string) => void;
  onOpenDecision?: (id: string) => void;
}

export function LandlordOpsTodayView({ onNavigate, onOpenDecision }: TodayViewProps) {
  const [, setParams] = useSearchParams();
  const { data: totalsData } = useLandlordOpsTotals();
  const totals = totalsData?.totals;
  const {
    pendingHouses,
    pendingLandlords,
    pendingLc1,
    pendingPipeline,
    pendingPayouts,
    isLoading: countsLoading,
    errors: countErrors,
  } = useLandlordOpsBadgeCounts();
  const { data: floatOverview } = useLandlordFloatOverview();
  const floatWithAgents = floatOverview?.with_agents?.summary?.amount ?? null;
  const { data: principalRecovered = null } = useQuery({
    queryKey: ['landlord-ops-principal-recovered'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('landlord_ops_principal_recovered');
      if (error) throw error;
      return Number(data ?? 0);
    },
    staleTime: 60_000,
  });

  // 'Today' | 'Last 7 days' | 'Last 30 days' — drives the activity chart and the
  // decision mix beside it, so the two always describe the same window.
  const [timeFilter, setTimeFilter] = useState<'Today' | 'Last 7 days' | 'Last 30 days'>('Last 7 days');
  const windowDays = timeFilter === 'Today' ? 1 : timeFilter === 'Last 30 days' ? 30 : 7;

  const { data: activity = [], isLoading: activityLoading } = useLandlordOpsActivity(windowDays);
  const { data: recentDecisions = [], isLoading: decisionsLoading } = useLandlordOpsRecentDecisions(6);
  const { data: newToday } = useLandlordOpsNewToday();
  const { data: wallet } = useLandlordOpsWalletImpact();
  const { data: noLandlordCount = 0 } = useLandlordOpsNoLandlordCount();

  const activityData = useMemo(
    () =>
      activity.map((d) => ({
        date: new Date(`${d.date}T00:00:00Z`).toLocaleDateString('en-GB', {
          day: 'numeric',
          month: 'short',
          timeZone: 'UTC',
        }),
        verified: d.verified,
        rejected: d.rejected,
      })),
    [activity],
  );

  const mix = useMemo(() => {
    const verified = activity.reduce((sum, d) => sum + d.verified, 0);
    const rejected = activity.reduce((sum, d) => sum + d.rejected, 0);
    const total = verified + rejected;
    return {
      verified,
      rejected,
      total,
      verifiedPct: total ? Math.round((verified / total) * 100) : 0,
      rejectedPct: total ? Math.round((rejected / total) * 100) : 0,
    };
  }, [activity]);

  const donutData = useMemo(
    () => [
      { name: 'Verified', value: mix.verified, color: '#0FA958' },
      { name: 'Rejected', value: mix.rejected, color: '#8B5CF6' },
    ],
    [mix],
  );

  const verifyQueueTotal = pendingHouses + pendingLandlords + pendingLc1;

  /** Backlog size → urgency chip. Keeps the three queue cards on one scale. */
  const urgency = (n: number) =>
    n >= 500
      ? { label: 'High', cls: 'bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300 hover:bg-rose-100' }
      : n >= 50
        ? { label: 'Medium', cls: 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300 hover:bg-amber-100' }
        : { label: 'Low', cls: 'bg-muted text-muted-foreground hover:bg-muted' };

  /**
   * Never print a number we did not actually get. A queue whose query failed
   * shows "!" rather than 0, because 0 reads as "no work waiting" when the truth
   * is that we could not ask.
   */
  const num = (n: number, failed?: unknown) =>
    countsLoading ? '—' : failed ? '!' : n.toLocaleString();

  /** Hover text explaining a "!", so the reason is visible without a console. */
  const numTitle = (failed?: unknown) =>
    failed
      ? `Could not load this queue — ${
          (failed as { message?: string })?.message ?? 'unknown error'
        }. The number shown is not a count.`
      : undefined;

  const triggerDecision = (id: string) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('decide', id);
      return next;
    });
    onOpenDecision?.(id);
  };

  return (
    <div className="space-y-4 pb-10 sm:space-y-6 sm:pb-12 animate-in fade-in-50 duration-200">
      {/* Header */}
      <div>
        <p className="text-xs text-muted-foreground font-medium">Landlord Ops / Today</p>
        <h1 className="text-xl font-extrabold tracking-tight text-foreground mt-0.5 sm:text-2xl">
          Today's Landlord Operations
        </h1>
        <p className="text-xs text-muted-foreground mt-0.5">
          Work the queues. Every verification decision carries a wallet consequence.
        </p>
        </div>

      {/* Landlord Verification Queue — primary action */}
      <div
        onClick={() => onNavigate('verify/landlords')}
        className="rounded-lg border border-primary/20 bg-primary p-4 text-primary-foreground shadow-sm hover:bg-primary/90 transition-all cursor-pointer group sm:p-5"
      >
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 sm:gap-4">
          <div className="flex items-center gap-3 sm:gap-4">
            <div className="p-2.5 rounded-lg bg-primary-foreground/10 sm:p-3">
              <UserCheck className="h-7 w-7" />
            </div>
            <div>
              <h2 className="text-lg font-extrabold">Landlord Verification Queue</h2>
              <p className="text-sm text-primary-foreground/80">
                Review and verify landlords waiting for approval
              </p>
            </div>
          </div>
          <div className="flex w-full items-center justify-between gap-3 sm:w-auto sm:gap-4">
            <div className="text-left sm:text-right">
              <p className="text-3xl font-black tabular-nums">
                {num(pendingLandlords, countErrors.landlords)}
              </p>
              <p className="text-xs text-primary-foreground/80 font-medium">
                awaiting verification
              </p>
            </div>
            <Button
              onClick={(e) => {
                e.stopPropagation();
                onNavigate('verify/landlords');
              }}
              className="h-12 flex-1 bg-primary-foreground text-primary hover:bg-primary-foreground/90 font-bold text-sm px-5 rounded-lg shadow-sm sm:h-11 sm:flex-none"
            >
              Review now <ArrowRight className="h-4 w-4 ml-1.5" />
            </Button>
          </div>
        </div>
      </div>

      {/* Landlord Float — primary register entry point */}

      <div
        onClick={() => onNavigate('registers/landlord-float')}
        className="p-4 rounded-lg border border-border bg-card hover:border-primary/60 hover:shadow-sm transition-all cursor-pointer group"
      >
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-primary text-primary-foreground">
              <Wallet className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-foreground">Landlord Float</h2>
              <p className="text-xs text-muted-foreground">View float held, needed, and collected by geography</p>
            </div>
          </div>
          <div className="flex flex-col items-stretch gap-2 min-[380px]:flex-row min-[380px]:items-center min-[380px]:justify-between sm:justify-end sm:gap-3">
            {floatWithAgents !== null && (
              <span className="text-sm font-semibold text-foreground tabular-nums">
                {formatUGX(floatWithAgents)} with agents
              </span>
            )}
            <Button
              onClick={(e) => {
                e.stopPropagation();
                onNavigate('registers/landlord-float');
              }}
              className="bg-primary hover:bg-primary/90 text-primary-foreground font-semibold text-xs h-11 rounded-lg sm:h-9"
            >
              Open register <ArrowRight className="h-3.5 w-3.5 ml-1" />
            </Button>
          </div>
        </div>
      </div>

      {/* Landlord Principal Recovered — hard KPI */}
      <div className="p-4 rounded-lg border border-border bg-card">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-primary text-primary-foreground">
              <Banknote className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-foreground">Landlord Principal Recovered</h2>
              <p className="text-xs text-muted-foreground">Net principal from tenant repayments</p>
            </div>
          </div>
          <span
            className="text-xl font-black tabular-nums text-foreground"
            title={principalRecovered != null ? formatUGX(principalRecovered) : undefined}
          >
            {principalRecovered == null ? '—' : `UGX ${(principalRecovered / 1_000_000).toFixed(2)}M`}
          </span>
        </div>
      </div>

      {/* Top Grid: Needs Attention & Wallet Impact */}
      <div className="grid grid-cols-1 xl:grid-cols-4 gap-3 sm:gap-4">
        {/* Needs Attention Column (3 cols on XL) */}
        <div className="xl:col-span-3 space-y-2.5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-rose-500 text-white text-xs font-bold">
                !
              </span>
              <h2 className="text-sm font-bold text-foreground">Needs attention</h2>
            </div>
            <button
              onClick={() => onNavigate('verify/houses')}
              className="text-xs font-semibold text-emerald-600 hover:text-emerald-700 flex items-center gap-1"
            >
              View all queues <ArrowRight className="h-3 w-3" />
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {/* Card 1: Houses */}
            <div
              onClick={() => onNavigate('verify/houses')}
              className="p-3.5 rounded-xl border border-border bg-card hover:border-emerald-400/60 hover:shadow-sm transition-all cursor-pointer group"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="p-1.5 rounded-lg bg-emerald-50 text-emerald-600 dark:bg-emerald-950/40">
                    <Home className="h-4 w-4" />
                  </div>
                  <span className="text-xs font-medium text-muted-foreground">Houses awaiting verification</span>
                </div>
                <ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-foreground group-hover:translate-x-0.5 transition-all" />
              </div>
              <div className="mt-3 flex items-baseline gap-2">
                <span className="text-2xl font-bold tracking-tight text-foreground" title={numTitle(countErrors.houses)}>
                  {num(pendingHouses, countErrors.houses)}
                </span>
                <Badge className={`${urgency(pendingHouses).cls} border-none text-[10px] px-1.5 py-0 font-semibold`}>
                  {urgency(pendingHouses).label}
                </Badge>
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">
                New today: {newToday ? newToday.houses.toLocaleString() : '—'}
              </p>
            </div>

            {/* Card 2: Landlords */}
            <div
              onClick={() => onNavigate('verify/landlords')}
              className="p-3.5 rounded-xl border border-border bg-card hover:border-emerald-400/60 hover:shadow-sm transition-all cursor-pointer group"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="p-1.5 rounded-lg bg-emerald-50 text-emerald-600 dark:bg-emerald-950/40">
                    <User className="h-4 w-4" />
                  </div>
                  <span className="text-xs font-medium text-muted-foreground">Landlords awaiting verification</span>
                </div>
                <ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-foreground group-hover:translate-x-0.5 transition-all" />
              </div>
              <div className="mt-3 flex items-baseline gap-2">
                <span className="text-2xl font-bold tracking-tight text-foreground" title={numTitle(countErrors.landlords)}>
                  {num(pendingLandlords, countErrors.landlords)}
                </span>
                <Badge className={`${urgency(pendingLandlords).cls} border-none text-[10px] px-1.5 py-0 font-semibold`}>
                  {urgency(pendingLandlords).label}
                </Badge>
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">
                New today: {newToday ? newToday.landlords.toLocaleString() : '—'}
              </p>
            </div>

            {/* Card 3: LC1 */}
            <div
              onClick={() => onNavigate('verify/lc1')}
              className="p-3.5 rounded-xl border border-border bg-card hover:border-emerald-400/60 hover:shadow-sm transition-all cursor-pointer group"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="p-1.5 rounded-lg bg-emerald-50 text-emerald-600 dark:bg-emerald-950/40">
                    <Users className="h-4 w-4" />
                  </div>
                  <span className="text-xs font-medium text-muted-foreground">LC1 verification</span>
                </div>
                <ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-foreground group-hover:translate-x-0.5 transition-all" />
              </div>
              <div className="mt-3 flex items-baseline gap-2">
                <span className="text-2xl font-bold tracking-tight text-foreground" title={numTitle(countErrors.lc1)}>{num(pendingLc1, countErrors.lc1)}</span>
                <Badge className={`${urgency(pendingLc1).cls} border-none text-[10px] px-1.5 py-0 font-semibold`}>
                  {urgency(pendingLc1).label}
                </Badge>
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">
                New today: {newToday ? newToday.lc1.toLocaleString() : '—'}
              </p>
            </div>

            {/* Card 4: Rent requests */}
            <div
              onClick={() => onNavigate('pipeline/rent-requests')}
              className="p-3.5 rounded-xl border border-border bg-card hover:border-emerald-400/60 hover:shadow-sm transition-all cursor-pointer group"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="p-1.5 rounded-lg bg-emerald-50 text-emerald-600 dark:bg-emerald-950/40">
                    <FileText className="h-4 w-4" />
                  </div>
                  <span className="text-xs font-medium text-muted-foreground truncate">Rent requests awaiting sign-off</span>
                </div>
                <ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-foreground group-hover:translate-x-0.5 transition-all" />
              </div>
              <div className="mt-3 flex items-baseline gap-2">
                <span className="text-2xl font-bold tracking-tight text-foreground" title={numTitle(countErrors.pipeline)}>{num(pendingPipeline, countErrors.pipeline)}</span>
                <Badge className={`${urgency(pendingPipeline).cls} border-none text-[10px] px-1.5 py-0 font-semibold`}>
                  {urgency(pendingPipeline).label}
                </Badge>
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">
                New today: {newToday ? newToday.rentRequests.toLocaleString() : '—'}
              </p>
            </div>
          </div>
        </div>

        {/* Wallet Impact Today Column (1 col on XL) */}
        <div className="p-4 rounded-xl border border-border bg-card flex flex-col justify-between shadow-sm">
          <div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-xs font-bold text-foreground">
                <div className="p-1 rounded-md bg-emerald-100 dark:bg-emerald-950/50 text-emerald-600">
                  <Wallet className="h-3.5 w-3.5" />
                </div>
                <span>Wallet impact today</span>
              </div>
              <Info className="h-3.5 w-3.5 text-muted-foreground" />
            </div>

            <div className="mt-3 space-y-2 text-xs">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Credited to agents</span>
                <span className="font-semibold text-emerald-600 tabular-nums">
                  {wallet ? `+ ${formatUGX(wallet.credited)}` : '—'}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Awaiting credit</span>
                <span className="font-semibold text-amber-600 tabular-nums">
                  {wallet ? formatUGX(wallet.pendingCredit) : '—'}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Charged (rejections)</span>
                <span className="font-semibold text-rose-600 tabular-nums">
                  {wallet ? `- ${formatUGX(wallet.charged)}` : '—'}
                </span>
              </div>
            </div>
          </div>

          <div className="pt-2.5 mt-2.5 border-t border-border flex items-center justify-between">
            <span className="text-xs font-medium text-foreground">Net to agents</span>
            <span
              className={`text-sm font-extrabold tabular-nums ${
                wallet && wallet.credited + wallet.pendingCredit - wallet.charged < 0
                  ? 'text-rose-700 dark:text-rose-400'
                  : 'text-emerald-700 dark:text-emerald-400'
              }`}
            >
              {wallet
                ? `${wallet.credited + wallet.pendingCredit - wallet.charged < 0 ? '- ' : '+ '}${formatUGX(
                    Math.abs(wallet.credited + wallet.pendingCredit - wallet.charged),
                  )}`
                : '—'}
            </span>
          </div>
        </div>
      </div>

      {/* 4 Workspaces Action Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {/* Card 1: Verify */}
        <div className="p-4 rounded-xl border border-border bg-card flex flex-col justify-between space-y-3">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <div className="p-1.5 rounded-lg bg-emerald-600 text-white">
                <CheckCircle2 className="h-4 w-4" />
              </div>
              <span className="font-bold text-sm text-foreground">Verify</span>
            </div>
            <p className="text-xs text-muted-foreground">Houses, Landlords, LC1</p>
            <p
              className="text-lg font-extrabold text-foreground pt-1"
              title={numTitle(countErrors.houses || countErrors.landlords || countErrors.lc1)}
            >
              {num(verifyQueueTotal, countErrors.houses || countErrors.landlords || countErrors.lc1)} <span className="text-xs font-normal text-muted-foreground">items in queue</span>
            </p>
          </div>
          <Button
            onClick={() => onNavigate('verify/houses')}
            className="w-full bg-[#0FA958] hover:bg-[#0c8c48] text-white font-semibold text-xs h-9 rounded-lg"
          >
            Open verification <ArrowRight className="h-3.5 w-3.5 ml-1" />
          </Button>
        </div>

        {/* Card 2: Pipeline */}
        <div className="p-4 rounded-xl border border-border bg-card flex flex-col justify-between space-y-3">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <div className="p-1.5 rounded-lg bg-[#7C3AED] text-white">
                <GitBranch className="h-4 w-4" />
              </div>
              <span className="font-bold text-sm text-foreground">Pipeline</span>
            </div>
            <p className="text-xs text-muted-foreground">Rent requests, Advances</p>
            <p className="text-lg font-extrabold text-foreground pt-1" title={numTitle(countErrors.pipeline)}>
              {num(pendingPipeline, countErrors.pipeline)} <span className="text-xs font-normal text-muted-foreground">awaiting sign-off</span>
            </p>
          </div>
          <Button
            onClick={() => onNavigate('pipeline/rent-requests')}
            className="w-full bg-[#7C3AED] hover:bg-[#6D28D9] text-white font-semibold text-xs h-9 rounded-lg"
          >
            Open pipeline <ArrowRight className="h-3.5 w-3.5 ml-1" />
          </Button>
        </div>

        {/* Card 3: Payouts */}
        <div className="p-4 rounded-xl border border-border bg-card flex flex-col justify-between space-y-3">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <div className="p-1.5 rounded-lg bg-[#059669] text-white">
                <Banknote className="h-4 w-4" />
              </div>
              <span className="font-bold text-sm text-foreground">Payouts</span>
            </div>
            <p className="text-xs text-muted-foreground">Payout review, Paid, Float</p>
            <p className="text-lg font-extrabold text-foreground pt-1" title={numTitle(countErrors.payouts)}>
              {num(pendingPayouts, countErrors.payouts)} <span className="text-xs font-normal text-muted-foreground">awaiting review</span>
            </p>
          </div>
          <Button
            onClick={() => onNavigate('payouts/review')}
            className="w-full bg-[#059669] hover:bg-[#047857] text-white font-semibold text-xs h-9 rounded-lg"
          >
            Open payouts <ArrowRight className="h-3.5 w-3.5 ml-1" />
          </Button>
        </div>

        {/* Card 4: Fix-ups */}
        <div className="p-4 rounded-xl border border-border bg-card flex flex-col justify-between space-y-3">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <div className="p-1.5 rounded-lg bg-[#8B5CF6] text-white">
                <Wrench className="h-4 w-4" />
              </div>
              <span className="font-bold text-sm text-foreground">Fix-ups</span>
            </div>
            <p className="text-xs text-muted-foreground">Chain health, Duplicates, etc.</p>
            <p className="text-lg font-extrabold text-foreground pt-1">
              {noLandlordCount.toLocaleString()}{' '}
              <span className="text-xs font-normal text-muted-foreground">houses with no landlord</span>
            </p>
          </div>
          <Button
            onClick={() => onNavigate('fixups/chain-health')}
            className="w-full bg-[#8B5CF6] hover:bg-[#7C3AED] text-white font-semibold text-xs h-9 rounded-lg"
          >
            Open fix-ups <ArrowRight className="h-3.5 w-3.5 ml-1" />
          </Button>
        </div>
      </div>

      {/* Analytics Row (3 Columns) */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Chart 1: Verification activity */}
        <div className="p-4 rounded-xl border border-border bg-card space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-xs font-bold text-foreground">
              <div className="h-2 w-2 rounded-full bg-emerald-500" />
              <span>Verification activity</span>
            </div>
            <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
              <span className="flex items-center gap-1">
                <span className="h-2 w-2 rounded-full bg-[#0FA958]" /> Verified
              </span>
              <span className="flex items-center gap-1">
                <span className="h-2 w-2 rounded-full bg-[#8B5CF6]" /> Rejected
              </span>
            </div>
          </div>
          <div className="h-48 pt-2">
            {activityLoading ? (
              <div className="h-full animate-pulse rounded-lg bg-muted" />
            ) : mix.total === 0 ? (
              <div className="flex h-full items-center justify-center text-center text-xs text-muted-foreground">
                No verification decisions in this window
              </div>
            ) : (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={activityData} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
                <YAxis tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" allowDecimals={false} />
                <Tooltip
                  contentStyle={{
                    background: 'hsl(var(--popover))',
                    border: '1px solid hsl(var(--border))',
                    borderRadius: 8,
                    fontSize: 11,
                  }}
                />
                <Bar dataKey="verified" fill="#0FA958" radius={[3, 3, 0, 0]} />
                <Bar dataKey="rejected" fill="#8B5CF6" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
            )}
          </div>
        </div>

        {/* Chart 2: Decision mix */}
        <div className="p-4 rounded-xl border border-border bg-card space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-xs font-bold text-foreground">
              <Clock className="h-3.5 w-3.5 text-muted-foreground" />
              <span>Decision mix · {timeFilter.toLowerCase()}</span>
            </div>
            <select
              value={timeFilter}
              onChange={(e) => setTimeFilter(e.target.value as typeof timeFilter)}
              className="text-[11px] bg-muted/40 border border-border rounded-md px-2 py-0.5 text-muted-foreground"
            >
              <option>Last 7 days</option>
              <option>Today</option>
              <option>Last 30 days</option>
            </select>
          </div>

          <div className="flex items-center justify-between h-48 px-2">
            <div className="relative w-36 h-36">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={donutData}
                    cx="50%"
                    cy="50%"
                    innerRadius={46}
                    outerRadius={62}
                    paddingAngle={3}
                    dataKey="value"
                  >
                    {donutData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.color} />
                    ))}
                  </Pie>
                </PieChart>
              </ResponsiveContainer>
              <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                <span className="text-xl font-black text-foreground tabular-nums">
                  {mix.total.toLocaleString()}
                </span>
                <span className="text-[10px] text-muted-foreground">decisions</span>
              </div>
            </div>

            <div className="space-y-3 flex-1 pl-4 text-xs">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full bg-[#0FA958]" />
                  <span className="font-medium text-foreground">Verified</span>
                </div>
                <div className="space-x-2">
                  <span className="font-bold tabular-nums">{mix.verified.toLocaleString()}</span>
                  <span className="text-muted-foreground font-semibold">{mix.verifiedPct}%</span>
                </div>
              </div>

              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full bg-[#8B5CF6]" />
                  <span className="font-medium text-foreground">Rejected</span>
                </div>
                <div className="space-x-2">
                  <span className="font-bold tabular-nums">{mix.rejected.toLocaleString()}</span>
                  <span className="text-muted-foreground font-semibold">{mix.rejectedPct}%</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Card 3: Operating Chain */}
        <div className="p-4 rounded-xl border border-border bg-card flex flex-col justify-between space-y-3">
          <div className="flex items-center gap-2 text-xs font-bold text-foreground">
            <Layers className="h-3.5 w-3.5 text-muted-foreground" />
            <span>Operating chain</span>
          </div>

          <div className="flex items-center justify-between gap-2 py-2">
            {/* Step 1: Verify */}
            <div className="flex-1 text-center p-2 rounded-lg bg-muted/30 border border-border">
              <div className="inline-flex p-1 rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-950 mb-1">
                <CheckCircle2 className="h-3.5 w-3.5" />
              </div>
              <p className="font-bold text-xs text-foreground">Verify</p>
              <p className="text-[10px] text-muted-foreground">Produces verified entities</p>
            </div>

            <span className="text-muted-foreground font-bold">→</span>

            {/* Step 2: Pipeline */}
            <div className="flex-1 text-center p-2 rounded-lg bg-muted/30 border border-border">
              <div className="inline-flex p-1 rounded-full bg-purple-100 text-purple-700 dark:bg-purple-950 mb-1">
                <FileText className="h-3.5 w-3.5" />
              </div>
              <p className="font-bold text-xs text-foreground">Pipeline</p>
              <p className="text-[10px] text-muted-foreground">Gates company money</p>
            </div>

            <span className="text-muted-foreground font-bold">→</span>

            {/* Step 3: Payout */}
            <div className="flex-1 text-center p-2 rounded-lg bg-muted/30 border border-border">
              <div className="inline-flex p-1 rounded-full bg-teal-100 text-teal-700 dark:bg-teal-950 mb-1">
                <Wallet className="h-3.5 w-3.5" />
              </div>
              <p className="font-bold text-xs text-foreground">Payout</p>
              <p className="text-[10px] text-muted-foreground">Settles obligations</p>
            </div>
          </div>

          <div className="space-y-1.5 pt-2 border-t border-border">
            <p className="text-xs font-semibold text-foreground">Integrity repairs the chain</p>
            <p className="text-[10px] text-muted-foreground leading-relaxed">
              Chain health · LC1 duplicates · Location reconciliation · No landlord listed · Tenant matching
            </p>
          </div>
        </div>
      </div>

      {/* Bottom Table: Recent decisions */}
      <div className="rounded-xl border border-border bg-card overflow-hidden shadow-sm">
        <div className="flex items-center justify-between p-4 border-b border-border">
          <div className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-emerald-600" />
            <h3 className="font-bold text-sm text-foreground">Recent decisions</h3>
          </div>
          <button
            onClick={() => onNavigate('verify/houses')}
            className="text-xs font-semibold text-emerald-600 hover:text-emerald-700 flex items-center gap-1"
          >
            View all activity <ArrowRight className="h-3 w-3" />
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-muted/40 text-muted-foreground text-[11px] font-semibold border-b border-border">
              <tr>
                <th className="py-2.5 px-4">Evidence</th>
                <th className="py-2.5 px-4">Identity (Listing / Landlord / LC1)</th>
                <th className="py-2.5 px-4">Decision</th>
                <th className="py-2.5 px-4">Wallet</th>
                <th className="py-2.5 px-4">Operator</th>
                <th className="py-2.5 px-4">Time</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {decisionsLoading ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                    Loading recent decisions…
                  </td>
                </tr>
              ) : recentDecisions.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                    No verification decisions recorded in the last 30 days
                  </td>
                </tr>
              ) : (
                recentDecisions.map((row: LandlordOpsDecision) => (
                <tr
                  key={row.id}
                  onClick={() => triggerDecision(row.listingId)}
                  className="hover:bg-muted/40 cursor-pointer transition-colors group"
                >
                  <td className="py-2.5 px-4 whitespace-nowrap">
                    <div className="flex items-center gap-2">
                      {row.imageUrl ? (
                        <img
                          src={row.imageUrl}
                          alt=""
                          className="h-7 w-9 rounded object-cover border border-border"
                        />
                      ) : (
                        <div className="flex h-7 w-9 items-center justify-center rounded border border-border bg-muted text-[9px] text-muted-foreground">
                          none
                        </div>
                      )}
                      <span className="text-muted-foreground text-[11px]">
                        {row.photoCount} {row.photoCount === 1 ? 'photo' : 'photos'}
                      </span>
                    </div>
                  </td>

                  <td className="py-2.5 px-4 whitespace-nowrap">
                    <div>
                      <p className="font-semibold text-foreground group-hover:text-emerald-600 transition-colors">
                        {row.listingTitle || 'Untitled listing'}
                        {row.district ? ` — ${row.district}` : ''}
                      </p>
                      <p className="text-[10px] text-muted-foreground font-mono">
                        #{row.listingId.slice(0, 8).toUpperCase()}
                      </p>
                    </div>
                  </td>

                  <td className="py-2.5 px-4 whitespace-nowrap">
                    <Badge
                      variant="outline"
                      className={`text-[10px] px-2 py-0 font-semibold ${
                        row.kind === 'verified'
                          ? 'text-emerald-600 bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200'
                          : 'text-rose-600 bg-rose-50 dark:bg-rose-950/30 border-rose-200'
                      }`}
                      title={row.rejectionReason || undefined}
                    >
                      {row.kind === 'verified' ? '✓ Verified' : '✕ Rejected'}
                    </Badge>
                  </td>

                  {/* Verified credits the bonus; rejected debits the standard charge. */}
                  <td className="py-2.5 px-4 whitespace-nowrap">
                    {row.kind === 'rejected' ? (
                      <span className="text-rose-600 font-semibold">- {formatUGX(row.amount)}</span>
                    ) : row.creditLanded ? (
                      <span className="text-emerald-600 font-semibold">+ {formatUGX(row.amount)}</span>
                    ) : (
                      <span className="text-amber-600 font-semibold">
                        {formatUGX(row.amount)} pending
                      </span>
                    )}
                  </td>

                  <td className="py-2.5 px-4 whitespace-nowrap text-foreground font-medium">
                    {row.operatorName || '—'}
                  </td>

                  <td className="py-2.5 px-4 whitespace-nowrap text-muted-foreground text-[11px]">
                    {new Date(row.decidedAt).toLocaleString('en-GB', {
                      day: 'numeric',
                      month: 'short',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </td>
                </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
