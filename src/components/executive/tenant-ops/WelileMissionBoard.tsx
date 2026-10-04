import { useMemo, useState, useEffect, useRef } from 'react';
import { useQueryClient, useQuery } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { supabase } from '@/integrations/supabase/client';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from '@/components/ui/command';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Calendar } from '@/components/ui/calendar';
import { UserDrilldownDrawer } from '@/components/ops/UserDrilldownDrawer';
import { TenantBalanceEditPanel } from '@/components/executive/tenant-ops/TenantBalanceEditPanel';
import { ListingPhotoGallery } from '@/components/executive/tenant-ops/ListingPhotoGallery';
import { LandlordBucketDialog } from '@/components/executive/tenant-ops/LandlordPriorityClassification';
import { AgentNetworkBadge } from '@/components/executive/tenant-ops/AgentNetworkBadge';
import {
  useMissionSummary, useMissionLeaderboard, type CounterWindow,
  type MissionSummary, type MissionAgentRow,
} from '@/hooks/useWelileOpsCounters';
import { applyDayBoundary, windowToISO, type DayBoundary } from '@/hooks/useWelileOpsCounters';
import { useLandlordPriorityBreakdown, type LandlordPriorityBucket } from '@/hooks/useWelileOpsCounters';
import { useMissionReceivables } from '@/hooks/useWelileOpsCounters';
import { useMissionLandlordReceivables, type MissionLandlordReceivable } from '@/hooks/useWelileOpsCounters';
import { useMissionAgentNetwork, type MissionAgentNetwork } from '@/hooks/useWelileOpsCounters';
import { useMissionDriverEntities, type MissionDriverKey, type MissionDriverEntity } from '@/hooks/useWelileOpsCounters';
import { useMissionEmptyHouses, type MissionEmptyHouseRow } from '@/hooks/useWelileOpsCounters';
import { useMissionPlacements, type MissionPlacementRow } from '@/hooks/useWelileOpsCounters';
import { useMissionFunders, type MissionFunderRow } from '@/hooks/useWelileOpsCounters';
import { useLandlordOnboardingTargets, useTargetLandlordForOnboarding, useBulkTargetLandlordsForOnboarding } from '@/hooks/useWelileOpsCounters';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { formatUGX } from '@/lib/agentAdvanceCalculations';
import {
  Target, Home, Users, Handshake, RefreshCw, ChevronRight, Phone,
  Search, Lightbulb, TrendingUp, ArrowRight, Building2, MapPin, ListChecks,
  ShieldCheck, BedDouble, UserPlus, Crosshair, Check, Loader2, Network, Award, Zap,
  ChevronsUpDown, X, Image as ImageIcon, CalendarDays, Info, ChevronLeft, ArrowUpDown,
  ArrowUp, ArrowDown, Minus, Download,
  FileText, History,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { buildRentEstimator } from '@/lib/missionProjection';
import { format } from 'date-fns';
import type { DateRange } from 'react-day-picker';
import { useNavigate } from 'react-router-dom';

const WINDOWS: { id: CounterWindow; label: string }[] = [
  { id: '1d', label: '1 day' },
  { id: '2d', label: '2 days' },
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
  { id: 'all', label: 'All time' },
];

function pct(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 100) : 0;
}
function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: '2-digit' });
}

function windowDateRangeLabel(w: CounterWindow, earliestDate?: string | null): string {
  const fmtFull = (d: Date) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  const fmtShort = (d: Date) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  if (w === 'all') {
    if (earliestDate) {
      return `${fmtFull(new Date(earliestDate))} – Present`;
    }
    return 'All time';
  }
  if (w.startsWith('custom:')) {
    const iso = w.slice('custom:'.length);
    if (iso) return `${fmtShort(new Date(iso))} – ${fmtShort(new Date())}`;
    return 'Custom';
  }
  const m = /^(\d+)d$/.exec(w);
  const days = m ? parseInt(m[1], 10) : 7;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return `${fmtShort(since)} – ${fmtShort(new Date())}`;
}

type PriorityKey = 'list' | 'place' | 'fund';

const PRIORITIES: {
  key: PriorityKey; rank: number; label: string; sub: string; icon: React.ElementType; tone: string; bar: string;
}[] = [
  { key: 'list', rank: 1, label: 'List empty houses', sub: 'Agents register landlords with vacant houses', icon: Home, tone: 'text-[#9234EA] bg-[#9234EA]/10', bar: 'bg-[#9234EA]' },
  { key: 'place', rank: 2, label: 'Place tenants', sub: 'Move tenants into listed empty houses', icon: Users, tone: 'text-emerald-600 bg-emerald-500/10', bar: 'bg-emerald-500' },
  { key: 'fund', rank: 3, label: 'Onboard funders', sub: 'Sign up funders & promissory notes', icon: Handshake, tone: 'text-purple-700 bg-purple-500/10', bar: 'bg-purple-600' },
];

function recommend(s: MissionSummary): { key: PriorityKey; text: string; severity: 'good' | 'watch' | 'act' } {
  const placementRate = pct(s.placements_total, s.placements_total + s.empty_houses_total);
  // Priority order: surface the most blocking gap first.
  if (s.empty_houses_total > 0 && placementRate < 50) {
    return {
      key: 'place',
      severity: s.empty_houses_total > s.placements_total ? 'act' : 'watch',
      text: `${s.empty_houses_total.toLocaleString()} listed houses are still empty (${placementRate}% placed). Push agents to move tenants in — every vacant house is lost rent.`,
    };
  }
  if (s.listings_new === 0) {
    return { key: 'list', severity: 'act', text: 'No new houses listed in this window. Re-activate agents to register landlords with vacant houses before placement can grow.' };
  }
  if (s.empty_houses_total < 10) {
    return { key: 'list', severity: 'watch', text: `Only ${s.empty_houses_total.toLocaleString()} empty houses in inventory. Drive agents to list more landlords so there is supply to place tenants into.` };
  }
  const fundActivation = pct(s.funders_activated, s.funders_total);
  if (s.funders_total > 0 && fundActivation < 60) {
    return { key: 'fund', severity: 'watch', text: `${(s.funders_total - s.funders_activated).toLocaleString()} funders are not yet activated (${fundActivation}% active). Follow up funders to confirm and activate their commitments.` };
  }
  return { key: 'list', severity: 'good', text: 'Supply, placement and funding are all moving. Keep agents listing fresh inventory to sustain the funnel.' };
}

export function WelileMissionBoard() {
  const navigate = useNavigate();
  const [win, setWin] = useState<CounterWindow>('7d');
  const [dayBoundary, setDayBoundary] = useState<DayBoundary>('kampala');
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const [showAgents, setShowAgents] = useState(true);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<PriorityKey>('list');
  const [drawer, setDrawer] = useState<{ agentId?: string | null; landlordId?: string | null; tenantId?: string | null; tab: 'agent' | 'landlord' | 'tenant' } | null>(null);
  const [emptyOpen, setEmptyOpen] = useState(false);
  const [placedOpen, setPlacedOpen] = useState(false);
  const [fundersOpen, setFundersOpen] = useState(false);
  const [roiPayableOpen, setRoiPayableOpen] = useState(false);
  // Priority 3 · ROI payable card period selector (day / week / month / custom range)
  // Persisted in localStorage so operators see the same filter after refresh.
  const ROI_PERIOD_KEY = 'welile.mission.roiCardPeriod';
  const ROI_RANGE_KEY = 'welile.mission.roiCustomRange';
  const [roiCardPeriod, setRoiCardPeriod] = useState<'day' | 'week' | 'month' | 'custom'>(() => {
    if (typeof window === 'undefined') return 'week';
    const v = window.localStorage.getItem(ROI_PERIOD_KEY);
    return v === 'day' || v === 'week' || v === 'month' || v === 'custom' ? v : 'week';
  });
  const [roiCustomRange, setRoiCustomRange] = useState<{ from?: Date; to?: Date }>(() => {
    if (typeof window === 'undefined') return {};
    try {
      const raw = window.localStorage.getItem(ROI_RANGE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw) as { from?: string; to?: string };
      return {
        from: parsed.from ? new Date(parsed.from) : undefined,
        to: parsed.to ? new Date(parsed.to) : undefined,
      };
    } catch {
      return {};
    }
  });
  const [roiRangeOpen, setRoiRangeOpen] = useState(false);
  useEffect(() => {
    try { window.localStorage.setItem(ROI_PERIOD_KEY, roiCardPeriod); } catch { /* ignore */ }
  }, [roiCardPeriod]);
  useEffect(() => {
    try {
      window.localStorage.setItem(ROI_RANGE_KEY, JSON.stringify({
        from: roiCustomRange.from?.toISOString(),
        to: roiCustomRange.to?.toISOString(),
      }));
    } catch { /* ignore */ }
  }, [roiCustomRange]);
  const [landlordRecvOpen, setLandlordRecvOpen] = useState(false);
  const [driverOpen, setDriverOpen] = useState<{ key: MissionDriverKey; label: string } | null>(null);
  const [landlordBucket, setLandlordBucket] = useState<LandlordPriorityBucket | null>(null);
  const [explainOpen, setExplainOpen] = useState(false);
  const [emptyScope, setEmptyScope] = useState<'window' | 'all'>('window');
  const [comparePrev, setComparePrev] = useState<boolean>(false);

  const intervalMs = autoRefresh ? 15_000 : false;
  const queryClient = useQueryClient();

  // Day-window boundaries snap to the chosen timezone (Kampala UTC+3 vs UTC).
  // Only day presets ("1d", "7d", …) are affected; "all" and custom ranges pass through.
  const effectiveWin = useMemo(() => applyDayBoundary(win, dayBoundary), [win, dayBoundary]);
  const isDayPreset = /^\d+d$/.test(win);

  // Live-refresh Priority 1 (and the funnel) whenever a new empty house / landlord
  // is listed or a rent request is posted, so the 33% projection reflects immediately.
  useEffect(() => {
    const refresh = () => {
      queryClient.invalidateQueries({ queryKey: ['welile-mission-receivables'] });
      queryClient.invalidateQueries({ queryKey: ['welile-mission-summary'] });
      queryClient.invalidateQueries({ queryKey: ['welile-mission-empty-houses'] });
      queryClient.invalidateQueries({ queryKey: ['welile-receivables-audit'] });
    };
    const channel = supabase
      .channel('mission-priority1-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'house_listings' }, refresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'landlords' }, refresh)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'rent_requests' }, refresh)
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [queryClient]);

  const { data: summary, isLoading, isFetching, refetch } = useMissionSummary(effectiveWin, intervalMs);
  const { data: agentData, isLoading: agentsLoading } = useMissionLeaderboard(effectiveWin, showAgents, intervalMs);
  const agents: MissionAgentRow[] = agentData ?? [];
  const { data: network, isLoading: networkLoading } = useMissionAgentNetwork(effectiveWin, intervalMs);
  const { data: receivables } = useMissionReceivables(effectiveWin, intervalMs);

  // Previous-window comparison for the "listed empty houses" priority card.
  // The mission-receivables RPC counts empties created since p_since, so the
  // count for the equal-duration previous window = receivables(prevSince) − receivables(currSince).
  const prevSinceISO = useMemo(() => {
    const currISO = windowToISO(effectiveWin);
    if (!currISO) return null; // "all" window has no previous period
    const cur = new Date(currISO).getTime();
    const dur = Date.now() - cur;
    if (!isFinite(dur) || dur <= 0) return null;
    return new Date(cur - dur).toISOString();
  }, [effectiveWin]);

  const { data: prevReceivables } = useQuery({
    enabled: comparePrev && emptyScope === 'window' && !!prevSinceISO,
    queryKey: ['welile-mission-receivables-prev', prevSinceISO],
    staleTime: 60_000,
    refetchInterval: intervalMs || false,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('welile_mission_receivables' as any, { p_since: prevSinceISO });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      return row as { empty_houses_count: number; unlisted_landlord_count: number } | null;
    },
  });

  const currWindowEmpty = (receivables?.empty_houses_count ?? 0) + (receivables?.unlisted_landlord_count ?? 0);
  const prevWindowEmpty = prevReceivables
    ? Math.max(0, ((prevReceivables.empty_houses_count ?? 0) + (prevReceivables.unlisted_landlord_count ?? 0)) - currWindowEmpty)
    : null;
  const emptyDelta = prevWindowEmpty != null ? currWindowEmpty - prevWindowEmpty : null;
  const emptyDeltaPct = prevWindowEmpty && prevWindowEmpty > 0 ? Math.round(((currWindowEmpty - prevWindowEmpty) / prevWindowEmpty) * 100) : null;
  const { data: landlordBreakdown } = useLandlordPriorityBreakdown(effectiveWin, intervalMs);

  // ROI payable OUT to funders in the next cycle (~next 31 days).
  // Drives the "ROI payable next cycle" figure on Priority 3 (Onboard funders).
  const { data: roiPayableRows } = useQuery({
    queryKey: ['mission-roi-payable-next', intervalMs],
    refetchInterval: intervalMs,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('investor_portfolios')
        .select('id, investment_amount, roi_percentage, next_roi_date')
        .eq('status', 'active')
        .not('next_roi_date', 'is', null);
      if (error) throw error;
      return (data ?? [])
        .filter((p: any) => !!p.next_roi_date)
        .map((p: any) => ({
          id: p.id as string,
          next_roi_date: p.next_roi_date as string,
          roi_amount: (Number(p.investment_amount) || 0) * (Number(p.roi_percentage) || 0) / 100,
        }));
    },
  });

  // Latest schedule per portfolio (whose scheduled_date matches the current next_roi_date is "active").
  const { data: roiScheduleMap } = useQuery({
    queryKey: ['mission-roi-schedule-map'],
    refetchInterval: intervalMs,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('roi_payout_schedules')
        .select('portfolio_id, scheduled_date, scheduled_by, reason, created_at')
        .order('created_at', { ascending: false });
      if (error) throw error;
      const map = new Map<string, { scheduled_date: string; scheduled_by: string; reason: string | null; created_at: string }>();
      (data ?? []).forEach((r: any) => {
        if (!map.has(r.portfolio_id)) map.set(r.portfolio_id, r);
      });
      return map;
    },
  });

  // Compute totals for the selected preset window (day / week / month / custom range).
  const roiPayable = useMemo(() => {
    const rows = roiPayableRows ?? [];
    const start = new Date(); start.setHours(0, 0, 0, 0);
    let end: Date;
    if (roiCardPeriod === 'custom') {
      if (!roiCustomRange.from) return { total: 0, count: 0, scheduled: 0, earliest: null as string | null, start, end: start, valid: false };
      const from = new Date(roiCustomRange.from); from.setHours(0, 0, 0, 0);
      const to = new Date(roiCustomRange.to ?? roiCustomRange.from); to.setHours(23, 59, 59, 999);
      let total = 0, count = 0, scheduled = 0; let earliest: Date | null = null;
      rows.forEach((r) => {
        const d = new Date(r.next_roi_date);
        if (d >= from && d <= to) {
          total += r.roi_amount; count += 1;
          const sch = roiScheduleMap?.get(r.id);
          if (sch && sch.scheduled_date === r.next_roi_date) scheduled += 1;
          if (!earliest || d < earliest) earliest = d;
        }
      });
      return { total, count, scheduled, earliest: earliest ? (earliest as Date).toISOString() : null, start: from, end: to, valid: true };
    }
    const days = roiCardPeriod === 'day' ? 1 : roiCardPeriod === 'week' ? 7 : 30;
    end = new Date(start); end.setDate(end.getDate() + days); end.setHours(23, 59, 59, 999);
    let total = 0, count = 0, scheduled = 0; let earliest: Date | null = null;
    rows.forEach((r) => {
      const d = new Date(r.next_roi_date);
      if (d >= start && d <= end) {
        total += r.roi_amount; count += 1;
        const sch = roiScheduleMap?.get(r.id);
        if (sch && sch.scheduled_date === r.next_roi_date) scheduled += 1;
        if (!earliest || d < earliest) earliest = d;
      }
    });
    return { total, count, scheduled, earliest: earliest ? (earliest as Date).toISOString() : null, start, end, valid: true };
  }, [roiPayableRows, roiCardPeriod, roiCustomRange, roiScheduleMap]);

  const searchLower = search.trim().toLowerCase();
  const filteredAgents = useMemo(() => {
    let r = [...agents];
    if (searchLower) {
      r = r.filter((a) =>
        (a.agent_name?.toLowerCase().includes(searchLower) ?? false) ||
        (a.agent_phone?.toLowerCase().includes(searchLower) ?? false));
    }
    r.sort((a, b) => {
      if (sort === 'list') return b.listings_count - a.listings_count;
      if (sort === 'place') return b.placements_count - a.placements_count;
      return b.promissory_count - a.promissory_count;
    });
    return r;
  }, [agents, searchLower, sort]);

  const rec = summary ? recommend(summary) : null;
  const placementRate = summary ? pct(summary.placements_total, summary.placements_total + summary.empty_houses_total) : 0;
  const fundActivation = summary ? pct(summary.funders_activated, summary.funders_total) : 0;

  const metricFor = (s: MissionSummary, key: PriorityKey) => {
    if (key === 'list') {
      const windowEmpty = (receivables?.empty_houses_count ?? 0) + (receivables?.unlisted_landlord_count ?? 0);
      const allEmpty = s.empty_houses_total;
      const big = emptyScope === 'all' ? allEmpty : windowEmpty;
      const extra = emptyScope === 'all'
        ? `${windowEmpty.toLocaleString()} added in window`
        : `${allEmpty.toLocaleString()} empty in total`;
      return { big, label: emptyScope === 'all' ? 'empty houses (all-time)' : 'listed empty houses', extra };
    }
    if (key === 'place') return { big: s.placements_new, label: 'tenants placed', extra: `${placementRate}% of listed houses occupied` };
    return { big: s.funders_new, label: 'new funders', extra: `${formatUGX(s.funders_amount)} committed · ${fundActivation}% active (≥ UGX 10,000)` };
  };

  const recSeverityCls = rec?.severity === 'act'
    ? 'border-red-500/40 bg-red-500/5'
    : rec?.severity === 'watch'
      ? 'border-amber-500/40 bg-amber-500/5'
      : 'border-emerald-500/40 bg-emerald-500/5';

  return (
    <Card className="p-3 sm:p-4 border-border">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="min-w-0">
          <h3 className="text-sm font-extrabold leading-tight flex items-center gap-1.5">
            <Target className="h-4 w-4 text-primary" /> Mission Priorities
          </h3>
          <p className="text-[11px] text-muted-foreground">
            List empty houses → place tenants → onboard funders. Progress &amp; live recommendations.
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="flex items-center gap-1.5 rounded-lg border border-border px-2 py-0.5 bg-card">
            <span className={cn('text-[10px] font-semibold', autoRefresh ? 'text-emerald-600' : 'text-muted-foreground')}>
              {autoRefresh ? 'Live' : 'Auto'}
            </span>
            <Switch checked={autoRefresh} onCheckedChange={setAutoRefresh} className="scale-75" />
          </div>
          {/* Day-boundary timezone toggle (affects day presets like "1 day" / "7 days") */}
          <div
            className={cn('flex rounded-lg border border-border overflow-hidden', !isDayPreset && 'opacity-50')}
            title={isDayPreset
              ? 'Switch which timezone the day starts in'
              : 'Day-boundary timezone applies to day presets (1–30 days)'}
          >
            {(['kampala', 'utc'] as DayBoundary[]).map((b) => (
              <button
                key={b}
                type="button"
                disabled={!isDayPreset}
                onClick={() => setDayBoundary(b)}
                className={cn('px-2 py-1 text-[10px] font-semibold transition disabled:cursor-not-allowed',
                  dayBoundary === b ? 'bg-primary text-primary-foreground' : 'bg-card hover:bg-muted/40')}
              >
                {b === 'kampala' ? 'EAT' : 'UTC'}
              </button>
            ))}
          </div>
          <div className="flex rounded-lg border border-border overflow-hidden">
            {WINDOWS.map((w) => (
              <button
                key={w.id}
                onClick={() => setWin(w.id)}
                className={cn('px-2.5 py-1 text-[11px] font-semibold transition',
                  win === w.id ? 'bg-primary text-primary-foreground' : 'bg-card hover:bg-muted/40')}
              >
                {w.label}
              </button>
            ))}
            <Popover open={customOpen} onOpenChange={setCustomOpen}>
              <PopoverTrigger asChild>
                <button
                  className={cn('flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold transition border-l border-border',
                    win.startsWith('custom:') ? 'bg-primary text-primary-foreground' : 'bg-card hover:bg-muted/40')}
                >
                  <CalendarDays className="h-3 w-3" />
                  {win.startsWith('custom:')
                    ? windowDateRangeLabel(win)
                    : 'Custom'}
                </button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="end">
                <div className="px-3 pt-3 text-[11px] text-muted-foreground">
                  Pick a start date — range runs from that day up to today.
                </div>
                <Calendar
                  mode="single"
                  selected={win.startsWith('custom:') ? new Date(win.slice('custom:'.length)) : undefined}
                  onSelect={(d) => {
                    if (!d) return;
                    const start = new Date(d);
                    start.setHours(0, 0, 0, 0);
                    setWin(`custom:${start.toISOString()}` as CounterWindow);
                    setCustomOpen(false);
                  }}
                  disabled={(d) => d > new Date()}
                  initialFocus
                  className={cn('p-3 pointer-events-auto')}
                />
              </PopoverContent>
            </Popover>
          </div>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => refetch()}>
            <RefreshCw className={cn('h-4 w-4', (isFetching || isLoading) && 'animate-spin')} />
          </Button>
        </div>
      </div>

      {/* Priority cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mt-3">
        {PRIORITIES.map((p) => {
          const Icon = p.icon;
          const m = summary ? metricFor(summary, p.key) : null;
          const isFocus = rec?.key === p.key;
          return (
            <div
              key={p.key}
              className={cn(
                'rounded-xl border p-3 relative',
                p.key === 'list'
                  ? 'bg-amber-500/10 border-amber-500/40'
                  : p.key === 'fund'
                    ? 'bg-purple-500/10 border-purple-500/40'
                    : 'bg-card',
                isFocus
                  ? p.key === 'list'
                    ? 'ring-1 ring-amber-500/50'
                    : p.key === 'fund'
                      ? 'ring-1 ring-purple-500/50'
                      : 'border-primary ring-1 ring-primary/40'
                  : p.key === 'list'
                    ? ''
                    : p.key === 'fund'
                      ? ''
                      : 'border-border',
              )}
            >
              <div className="flex items-center gap-2">
                <div className={cn('p-1.5 rounded-lg shrink-0', p.tone)}><Icon className="h-4 w-4" /></div>
                <div className="min-w-0 flex-1">
                  <p className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground leading-none">Priority {p.rank}</p>
                  <p className="text-sm font-bold leading-tight truncate">{p.label}</p>
                </div>
                {isFocus && <Badge className="text-[9px] shrink-0">Focus now</Badge>}
              </div>
              {isLoading || !m ? (
                <Skeleton className="h-9 w-full mt-2" />
              ) : (
                <div className="mt-2">
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-2xl font-bold leading-none">{m.big.toLocaleString()}</span>
                    {p.key === 'list' && comparePrev && emptyScope === 'window' && emptyDelta != null && (
                      <span
                        className={cn(
                          'inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] font-semibold tabular-nums',
                          emptyDelta > 0
                            ? 'bg-red-500/15 text-red-700'
                            : emptyDelta < 0
                              ? 'bg-emerald-500/15 text-emerald-700'
                              : 'bg-muted text-muted-foreground',
                        )}
                        title={`Previous window: ${(prevWindowEmpty ?? 0).toLocaleString()} empty added`}
                      >
                        {emptyDelta > 0 ? <ArrowUp className="h-3 w-3" /> : emptyDelta < 0 ? <ArrowDown className="h-3 w-3" /> : <Minus className="h-3 w-3" />}
                        {emptyDelta > 0 ? '+' : ''}{emptyDelta.toLocaleString()}
                        {emptyDeltaPct != null && (
                          <span className="opacity-70">({emptyDeltaPct > 0 ? '+' : ''}{emptyDeltaPct}%)</span>
                        )}
                      </span>
                    )}
                    {p.key === 'list' ? (
                      <TooltipProvider delayDuration={100}>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="text-[11px] text-muted-foreground inline-flex items-center gap-0.5 cursor-help">
                              {m.label}
                              <Info className="h-3 w-3 text-muted-foreground/70" />
                            </span>
                          </TooltipTrigger>
                          <TooltipContent side="top" className="max-w-[280px] space-y-1.5">
                            <p className="text-[11px] font-semibold">How “listed empty houses” is calculated</p>
                            <p className="text-[11px] text-muted-foreground">
                              The number for the selected date window is the sum of two components:
                            </p>
                            <ul className="text-[11px] text-muted-foreground list-disc pl-3 space-y-0.5">
                              <li>Empty house listings created within the window.</li>
                              <li>Unlisted landlords with vacant houses registered within the same window.</li>
                            </ul>
                            <p className="text-[11px] text-muted-foreground">
                              Toggle <span className="font-semibold text-foreground">All-time</span> to see every currently empty listing instead.
                            </p>
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    ) : (
                      <span className="text-[11px] text-muted-foreground">{m.label}</span>
                    )}
                  </div>
                  {p.key === 'list' && (
                    <button
                      type="button"
                      onClick={() => setEmptyOpen(true)}
                      className="mt-0.5 inline-flex items-center gap-0.5 rounded text-[10px] text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground transition"
                      title="View the exact houses & unlisted landlords matching this date range"
                    >
                      <CalendarDays className="h-3 w-3 -translate-y-px" />
                      {windowDateRangeLabel(effectiveWin, receivables?.earliest_date)}
                      <ChevronRight className="h-3 w-3" />
                    </button>
                  )}
                  {p.key === 'list' && (
                    <div className="mt-1.5 flex items-center gap-1 rounded-lg border border-amber-500/40 bg-amber-500/5 p-0.5 w-fit">
                      <button
                        type="button"
                        onClick={() => setEmptyScope('window')}
                        className={cn(
                          'px-2 py-0.5 rounded text-[10px] font-semibold transition',
                          emptyScope === 'window' ? 'bg-amber-500 text-white' : 'text-amber-700 hover:bg-amber-500/10',
                        )}
                      >
                        In window
                      </button>
                      <button
                        type="button"
                        onClick={() => setEmptyScope('all')}
                        className={cn(
                          'px-2 py-0.5 rounded text-[10px] font-semibold transition',
                          emptyScope === 'all' ? 'bg-amber-500 text-white' : 'text-amber-700 hover:bg-amber-500/10',
                        )}
                      >
                        All-time
                      </button>
                      {emptyScope === 'window' && prevSinceISO && (
                        <button
                          type="button"
                          onClick={() => setComparePrev((v) => !v)}
                          className={cn(
                            'ml-1 px-2 py-0.5 rounded text-[10px] font-semibold transition inline-flex items-center gap-1',
                            comparePrev ? 'bg-amber-500 text-white' : 'text-amber-700 hover:bg-amber-500/10',
                          )}
                          title="Compare with the previous equal-length window"
                        >
                          <ArrowUpDown className="h-3 w-3" />
                          Compare
                        </button>
                      )}
                    </div>
                  )}
                  {p.key === 'list' && comparePrev && emptyScope === 'window' && emptyDelta != null && (
                    <p className="text-[10px] text-muted-foreground mt-1">
                      Previous window: <span className="font-semibold text-foreground tabular-nums">{(prevWindowEmpty ?? 0).toLocaleString()}</span> empty added ·{' '}
                      {emptyDelta === 0
                        ? 'no change'
                        : emptyDelta > 0
                          ? `${emptyDelta.toLocaleString()} more this window`
                          : `${Math.abs(emptyDelta).toLocaleString()} fewer this window`}
                    </p>
                  )}
                  {p.key === 'list' && m.extra && (
                    <p className="text-[11px] text-muted-foreground mt-1">{m.extra}</p>
                  )}
                  {m.extra && p.key !== 'list' && <p className="text-[11px] text-muted-foreground mt-1">{m.extra}</p>}
                  {p.key === 'place' && receivables && (
                    <div className="mt-2 rounded-lg bg-emerald-500/10 px-2 py-1.5">
                      <p className="text-[9px] font-bold uppercase tracking-wide text-emerald-700 leading-none">Receivables A/C</p>
                      <p className="text-sm font-bold text-emerald-700 tabular-nums leading-tight mt-0.5">{formatUGX(receivables.placed_receivable_total + receivables.empty_receivable_total + receivables.unlisted_receivable_total)}</p>
                      <p className="text-[10px] text-muted-foreground leading-none">total receivable</p>
                      <div className="mt-1.5 space-y-1 border-t border-emerald-500/20 pt-1.5">
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="text-[10px] text-muted-foreground">Recorded · {receivables.placed_receivable_count.toLocaleString()} placed</span>
                          <span className="text-[11px] font-semibold text-emerald-700 tabular-nums">{formatUGX(receivables.placed_receivable_total)}</span>
                        </div>
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="text-[10px] text-muted-foreground">Projected · {(receivables.empty_houses_count + receivables.unlisted_landlord_count).toLocaleString()} empty</span>
                          <span className="text-[11px] font-semibold text-amber-700 tabular-nums">{formatUGX(receivables.empty_receivable_total + receivables.unlisted_receivable_total)}</span>
                        </div>
                      </div>
                      {receivables.placed_receivable_count > 0 && (
                        <button
                          type="button"
                          onClick={() => setLandlordRecvOpen(true)}
                          className="mt-1.5 flex w-full items-center justify-between gap-1 border-t border-emerald-500/20 pt-1.5 text-[10px] font-semibold text-emerald-700 hover:text-emerald-800"
                        >
                          <span>View per-landlord receivables</span>
                          <ChevronRight className="h-3 w-3" />
                        </button>
                      )}
                    </div>
                  )}
                  {p.key === 'list' && receivables && (
                    <div className="mt-2 w-full rounded-lg bg-amber-500/20 px-2 py-1.5">
                      <p className="text-[9px] font-bold uppercase tracking-wide text-amber-700 leading-none">Projected receivables</p>
                      <p className="text-xl font-extrabold text-amber-700 tabular-nums leading-tight mt-0.5">~{formatUGX(receivables.estimated_full_total)}</p>
                    </div>
                  )}
                  {p.key === 'list' && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 w-full mt-2 text-[11px] gap-1 border-amber-500/40 text-amber-700 hover:text-amber-800"
                      onClick={() => setExplainOpen(true)}
                    >
                      <Info className="h-3.5 w-3.5" /> Explanations page
                    </Button>
                  )}
                  {p.key === 'place' && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 w-full mt-2 text-[11px] gap-1"
                      onClick={() => setPlacedOpen(true)}
                    >
                      <Users className="h-3.5 w-3.5" /> View placed tenants
                    </Button>
                  )}
                  {p.key === 'place' && landlordBreakdown && (
                    <button
                      type="button"
                      onClick={() => setLandlordBucket('priority2')}
                      className="mt-2 w-full rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-2 py-1.5 text-left hover:ring-1 hover:ring-emerald-500/40 transition"
                    >
                      <p className="text-[9px] font-bold uppercase tracking-wide text-emerald-700 leading-none">Landlords by agents · Priority 2</p>
                      <p className="text-sm font-bold text-emerald-700 tabular-nums leading-tight mt-0.5">{landlordBreakdown.priority2_placed.toLocaleString()}</p>
                      <p className="text-[10px] text-muted-foreground leading-none">
                        {landlordBreakdown.total_landlords > 0 ? Math.round((landlordBreakdown.priority2_placed / landlordBreakdown.total_landlords) * 100) : 0}% of {landlordBreakdown.total_landlords.toLocaleString()} registered →
                      </p>
                    </button>
                  )}
                  {p.key === 'fund' && (
                    <button
                      type="button"
                      onClick={() => setRoiPayableOpen(true)}
                      className="mt-2 w-full rounded-lg bg-purple-700/15 px-2 py-1.5 text-left hover:ring-1 hover:ring-purple-600/40 transition"
                    >
                      <div className="flex items-center justify-between gap-1">
                        <TooltipProvider delayDuration={100}>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <p className="text-[9px] font-bold uppercase tracking-wide text-purple-800 leading-none cursor-help underline decoration-dotted underline-offset-2">
                                ROI payable · {roiCardPeriod === 'day' ? 'next day' : roiCardPeriod === 'week' ? 'next week' : roiCardPeriod === 'month' ? 'next month' : 'custom range'}
                              </p>
                            </TooltipTrigger>
                            <TooltipContent side="top" className="max-w-[260px] space-y-1.5">
                              <p className="text-xs font-semibold">ROI Payable — Selected Window</p>
                              <p className="text-[11px] text-muted-foreground leading-snug">
                                The total <strong className="text-foreground">Returns</strong> (monthly flat-rate payout) due to active Supporters whose next ROI date falls within the selected window.
                              </p>
                              <p className="text-[11px] text-muted-foreground leading-snug">
                                <strong className="text-foreground">How it is calculated:</strong> For every active portfolio, we multiply the <em>investment_amount</em> by the <em>roi_percentage</em> to get the monthly Return owed. We then sum only those with a <em>next_roi_date</em> in the upcoming 31-day window.
                              </p>
                              <div className="rounded-md bg-purple-500/10 border border-purple-500/20 px-2 py-1">
                                <p className="text-[10px] font-mono text-purple-700">Formula: investment × roi% = monthly Return</p>
                              </div>
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                        <ChevronRight className="h-3 w-3 text-purple-800 shrink-0" />
                      </div>
                      <TooltipProvider delayDuration={100}>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <p className="text-sm font-bold text-purple-800 tabular-nums leading-tight mt-0.5 cursor-help underline decoration-dotted underline-offset-2">
                              {formatUGX(roiPayable?.total ?? 0)}
                            </p>
                          </TooltipTrigger>
                          <TooltipContent side="bottom" className="max-w-[260px] space-y-1.5">
                            <p className="text-xs font-semibold">Aggregated across all active portfolios</p>
                            <p className="text-[11px] text-muted-foreground leading-snug">
                              This total sums the monthly Returns owed by <strong className="text-foreground">every active portfolio</strong> whose next ROI date falls within the selected window.
                            </p>
                            <p className="text-[11px] text-muted-foreground leading-snug">
                              <strong className="text-foreground">Date range:</strong> {roiPayable.start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} → {roiPayable.end.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                            </p>
                            <div className="rounded-md bg-purple-500/10 border border-purple-500/20 px-2 py-1">
                              <p className="text-[10px] font-mono text-purple-700">
                                {roiPayable?.count ?? 0} portfolio{(roiPayable?.count ?? 0) !== 1 ? 's' : ''} in window
                              </p>
                            </div>
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                      <p className="text-[10px] text-muted-foreground leading-none mt-0.5">
                        {(roiPayable?.count ?? 0).toLocaleString()} portfolio{(roiPayable?.count ?? 0) !== 1 ? 's' : ''} due
                        {roiPayable?.earliest ? ` · from ${fmtDate(roiPayable.earliest)}` : ''} · tap for line items
                      </p>
                      {(roiPayable?.count ?? 0) > 0 && (
                        <div className="mt-1 flex flex-wrap items-center gap-1" onClick={(e) => e.stopPropagation()}>
                          <Badge className="text-[9px] h-4 px-1.5 bg-emerald-500/15 text-emerald-700 border border-emerald-500/30">
                            Scheduled: {roiPayable?.scheduled ?? 0}
                          </Badge>
                          <Badge className="text-[9px] h-4 px-1.5 bg-amber-500/15 text-amber-700 border border-amber-500/30">
                            Pending: {Math.max(0, (roiPayable?.count ?? 0) - (roiPayable?.scheduled ?? 0))}
                          </Badge>
                        </div>
                      )}
                    </button>
                  )}
                  {p.key === 'fund' && (
                    <div className="mt-1.5 flex items-center gap-1 flex-wrap" onClick={(e) => e.stopPropagation()}>
                      {([
                        { k: 'day', label: 'Day' },
                        { k: 'week', label: 'Week' },
                        { k: 'month', label: 'Month' },
                      ] as const).map((opt) => (
                        <button
                          key={opt.k}
                          type="button"
                          onClick={() => setRoiCardPeriod(opt.k)}
                          className={cn(
                            'px-2 py-0.5 rounded-md text-[9.5px] font-semibold border transition',
                            roiCardPeriod === opt.k
                              ? 'bg-purple-700 text-white border-purple-700'
                              : 'bg-card border-purple-600/30 text-purple-800 hover:bg-purple-500/10',
                          )}
                        >
                          {opt.label}
                        </button>
                      ))}
                      <Popover open={roiRangeOpen} onOpenChange={setRoiRangeOpen}>
                        <PopoverTrigger asChild>
                          <button
                            type="button"
                            onClick={() => setRoiCardPeriod('custom')}
                            className={cn(
                              'px-2 py-0.5 rounded-md text-[9.5px] font-semibold border transition inline-flex items-center gap-1',
                              roiCardPeriod === 'custom'
                                ? 'bg-purple-700 text-white border-purple-700'
                                : 'bg-card border-purple-600/30 text-purple-800 hover:bg-purple-500/10',
                            )}
                          >
                            <CalendarDays className="h-3 w-3" />
                            {roiCardPeriod === 'custom' && roiCustomRange.from
                              ? `${roiCustomRange.from.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}${roiCustomRange.to ? ` – ${roiCustomRange.to.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}` : ''}`
                              : 'Custom'}
                          </button>
                        </PopoverTrigger>
                        <PopoverContent className="w-auto p-0" align="start">
                          <Calendar
                            mode="range"
                            selected={roiCustomRange.from ? { from: roiCustomRange.from, to: roiCustomRange.to } : undefined}
                            onSelect={(range: any) => {
                              setRoiCardPeriod('custom');
                              setRoiCustomRange({ from: range?.from, to: range?.to });
                            }}
                            initialFocus
                            className={cn('p-3 pointer-events-auto')}
                          />
                          <div className="flex items-center justify-between gap-2 p-2 border-t border-border">
                            <button
                              type="button"
                              onClick={() => setRoiCustomRange({})}
                              className="text-[10px] text-muted-foreground hover:text-foreground"
                            >
                              Clear
                            </button>
                            <button
                              type="button"
                              onClick={() => setRoiRangeOpen(false)}
                              className="text-[10px] font-semibold text-purple-700 hover:text-purple-900"
                            >
                              Done
                            </button>
                          </div>
                        </PopoverContent>
                      </Popover>
                    </div>
                  )}
                  {p.key === 'fund' && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 w-full mt-2 text-[11px] gap-1"
                      onClick={() => setFundersOpen(true)}
                    >
                      <Handshake className="h-3.5 w-3.5" /> View onboarded funders
                    </Button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Agent network — the driving force across all 3 priorities */}
      <AgentNetworkCard
        network={network}
        loading={networkLoading}
        onOpenAgent={(id) => setDrawer({ agentId: id, tab: 'agent' })}
        onOpenDriver={(key, label) => setDriverOpen({ key, label })}
      />

      {/* Supply → placement funnel */}
      {summary && !isLoading && (
        <div className="rounded-xl border border-border bg-card p-3 mt-2">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1">
              <TrendingUp className="h-3.5 w-3.5" /> Supply &amp; placement funnel
            </span>
            <Badge variant="outline" className="text-[10px]">{placementRate}% occupied</Badge>
          </div>
          <div className="flex items-center gap-2 text-center">
            <div className="flex-1 rounded-lg bg-[#9234EA]/10 py-2">
              <p className="text-lg font-bold leading-none text-[#9234EA]">{(summary.empty_houses_total + summary.placements_total).toLocaleString()}</p>
              <p className="text-[10px] text-muted-foreground mt-0.5">Houses listed</p>
            </div>
            <ArrowRight className="h-4 w-4 text-muted-foreground shrink-0" />
            <button
              type="button"
              onClick={() => setEmptyOpen(true)}
              className="flex-1 rounded-lg bg-amber-500/10 py-2 hover:bg-amber-500/20 transition cursor-pointer"
              title="View the exact empty houses"
            >
              <p className="text-lg font-bold leading-none text-amber-600">{summary.empty_houses_total.toLocaleString()}</p>
              <p className="text-[10px] text-muted-foreground mt-0.5">Still empty →</p>
            </button>
            <ArrowRight className="h-4 w-4 text-muted-foreground shrink-0" />
            <button
              type="button"
              onClick={() => setPlacedOpen(true)}
              className="flex-1 rounded-lg bg-emerald-500/10 py-2 hover:bg-emerald-500/20 transition cursor-pointer"
              title="View the placed tenants / occupied houses"
            >
              <p className="text-lg font-bold leading-none text-emerald-600">{summary.placements_total.toLocaleString()}</p>
              <p className="text-[10px] text-muted-foreground mt-0.5">Tenants placed →</p>
            </button>
          </div>
        </div>
      )}

      {/* Recommendation */}
      {rec && (
        <div className={cn('rounded-xl border p-3 mt-2 flex items-start gap-2', recSeverityCls)}>
          <Lightbulb className="h-4 w-4 text-primary shrink-0 mt-0.5" />
          <div className="min-w-0">
            <p className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Recommended next move</p>
            <p className="text-xs font-medium leading-snug mt-0.5">{rec.text}</p>
          </div>
        </div>
      )}

      {/* Landlords-by-agents drill-down (folded into Priority 1 / Priority 2 cards above) */}
      <LandlordBucketDialog
        bucket={landlordBucket}
        win={effectiveWin}
        refetchIntervalMs={intervalMs}
        onClose={() => setLandlordBucket(null)}
        onOpenLandlord={(id) => { setLandlordBucket(null); setDrawer({ landlordId: id, tab: 'landlord' }); }}
        onOpenAgent={(id) => { setLandlordBucket(null); setDrawer({ agentId: id, tab: 'agent' }); }}
      />

      {/* Agent leaderboard */}
      <div className="mt-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Agent leaderboard</span>
          <Button variant="ghost" size="sm" className="h-7 px-2 text-[11px]" onClick={() => setShowAgents((v) => !v)}>
            {showAgents ? 'Hide' : 'Show'}
          </Button>
        </div>

        {showAgents && (
          <>
            <div className="flex items-center gap-2 mb-2">
              <div className="relative flex-1 min-w-0">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search agents…"
                  className="pl-7 h-8 text-xs"
                />
              </div>
              <div className="flex rounded-lg border border-border overflow-hidden shrink-0">
                {PRIORITIES.map((p) => (
                  <button
                    key={p.key}
                    onClick={() => setSort(p.key)}
                    className={cn('px-2 py-1 text-[10px] font-semibold transition whitespace-nowrap',
                      sort === p.key ? 'bg-primary text-primary-foreground' : 'bg-card hover:bg-muted/40')}
                  >
                    {p.key === 'list' ? 'Listed' : p.key === 'place' ? 'Placed' : 'Funders'}
                  </button>
                ))}
              </div>
            </div>

            <ScrollArea className="max-h-[360px] pr-1">
              {agentsLoading ? (
                <div className="space-y-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-16 w-full" />)}</div>
              ) : filteredAgents.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-6">
                  {agents.length === 0 ? 'No agent activity in this window.' : 'No agents match your search.'}
                </p>
              ) : (
                <ul className="space-y-1.5">
                  {filteredAgents.map((a) => (
                    <li
                      key={a.agent_id}
                      onClick={() => setDrawer({ agentId: a.agent_id, tab: 'agent' })}
                      className="rounded-lg border border-border bg-card p-3 hover:bg-muted/40 cursor-pointer"
                    >
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-sm truncate flex-1">{a.agent_name || 'Unknown agent'}</span>
                        <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                      </div>
                      {a.agent_phone && (
                        <p className="text-[11px] text-muted-foreground flex items-center gap-1 mt-0.5">
                          <Phone className="h-3 w-3" /> {a.agent_phone}
                        </p>
                      )}
                      <div className="flex flex-wrap gap-1.5 mt-2">
                        <span className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium border border-border text-[#9234EA] bg-[#9234EA]/10">
                          <Home className="h-3 w-3" /> Listed: {a.listings_count.toLocaleString()}
                          {a.empty_listings > 0 && <span className="text-muted-foreground font-normal">({a.empty_listings} empty)</span>}
                        </span>
                        <span className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium border border-border text-emerald-600 bg-emerald-500/10">
                          <Users className="h-3 w-3" /> Placed: {a.placements_count.toLocaleString()}
                        </span>
                        <span className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium border border-border text-amber-600 bg-amber-500/10">
                          <Handshake className="h-3 w-3" /> Funders: {a.promissory_count.toLocaleString()}
                        </span>
                      </div>
                      <p className="text-[10px] text-muted-foreground mt-1.5">
                        {a.promissory_amount > 0 && <>Committed {formatUGX(a.promissory_amount)} · </>}
                        Last activity {fmtDate(a.last_activity)}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </ScrollArea>
          </>
        )}
      </div>

      <UserDrilldownDrawer
        open={!!drawer}
        onOpenChange={(v) => { if (!v) setDrawer(null); }}
        tenantId={drawer?.tenantId ?? null}
        agentId={drawer?.agentId ?? null}
        landlordId={drawer?.landlordId ?? null}
        defaultTab={drawer?.tab ?? 'agent'}
      />

      <EmptyHousesDialog
        open={emptyOpen}
        win={effectiveWin}
        refetchIntervalMs={intervalMs}
        onClose={() => setEmptyOpen(false)}
        onOpenLandlord={(id) => { setEmptyOpen(false); setDrawer({ landlordId: id, tab: 'landlord' }); }}
        onOpenAgent={(id) => { setEmptyOpen(false); setDrawer({ agentId: id, tab: 'agent' }); }}
      />

      <PlacedTenantsDialog
        open={placedOpen}
        win={effectiveWin}
        refetchIntervalMs={intervalMs}
        onClose={() => setPlacedOpen(false)}
        onOpenLandlord={(id) => { setPlacedOpen(false); setDrawer({ landlordId: id, tab: 'landlord' }); }}
        onOpenAgent={(id) => { setPlacedOpen(false); setDrawer({ agentId: id, tab: 'agent' }); }}
      />

      <FundersDialog
        open={fundersOpen}
        win={effectiveWin}
        refetchIntervalMs={intervalMs}
        onClose={() => setFundersOpen(false)}
        onOpenAgent={(id) => { setFundersOpen(false); setDrawer({ agentId: id, tab: 'agent' }); }}
      />

      <ROIPayableDialog
        open={roiPayableOpen}
        refetchIntervalMs={intervalMs}
        onClose={() => setRoiPayableOpen(false)}
        cardPeriod={roiCardPeriod}
        cardCustomRange={roiCustomRange}
      />

      <LandlordReceivablesDialog
        open={landlordRecvOpen}
        onClose={() => setLandlordRecvOpen(false)}
        onOpenLandlord={(id) => { setLandlordRecvOpen(false); setDrawer({ landlordId: id, tab: 'landlord' }); }}
      />

      <AgentNetworkDriverDialog
        driver={driverOpen?.key ?? null}
        label={driverOpen?.label ?? ''}
        win={effectiveWin}
        refetchIntervalMs={intervalMs}
        open={!!driverOpen}
        onClose={() => setDriverOpen(null)}
        onOpenAgent={(id) => { setDriverOpen(null); setDrawer({ agentId: id, tab: 'agent' }); }}
        onOpenTenant={(id) => { setDriverOpen(null); setDrawer({ tenantId: id, tab: 'tenant' }); }}
        onOpenLandlord={(id) => { setDriverOpen(null); setDrawer({ landlordId: id, tab: 'landlord' }); }}
      />

      <Dialog open={explainOpen} onOpenChange={setExplainOpen}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Info className="h-4 w-4 text-amber-600" />
              Projected receivables — step-by-step
            </DialogTitle>
          </DialogHeader>
          {receivables && (
            <div className="space-y-4 text-sm">
              {/* Hero total */}
              <div className="rounded-lg bg-amber-500/10 border border-amber-500/20 px-4 py-3 text-center">
                <p className="text-[10px] font-bold uppercase tracking-wide text-amber-700">Total projected receivables</p>
                <p className="text-3xl font-extrabold text-amber-700 tabular-nums leading-tight mt-1">~{formatUGX(receivables.estimated_full_total)}</p>
                <p className="text-[11px] text-muted-foreground mt-1">
                  {(receivables.empty_houses_count + receivables.unlisted_landlord_count).toLocaleString()} empty houses · annual projection
                </p>
              </div>

              {/* Step-by-step calculation */}
              <div className="space-y-3">
                <p className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">How we calculate it</p>

                {/* Step 1 */}
                <div className="rounded-lg border border-border bg-card p-3 space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground shrink-0">1</span>
                    <p className="text-xs font-semibold">Start with monthly rent per house</p>
                  </div>
                  <div className="pl-7 space-y-1.5">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-[11px] text-muted-foreground">Known rents (recorded)</span>
                      <span className="text-xs font-semibold tabular-nums">{receivables.known_rent_count.toLocaleString()} houses</span>
                    </div>
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-[11px] text-muted-foreground">Missing rents (estimated)</span>
                      <span className="text-xs font-semibold tabular-nums">{receivables.missing_rent_count.toLocaleString()} houses</span>
                    </div>
                    <div className="flex items-baseline justify-between gap-2 border-t border-border pt-1.5 mt-1">
                      <span className="text-[11px] text-muted-foreground">Average known monthly rent</span>
                      <span className="text-xs font-bold tabular-nums text-foreground">{formatUGX(receivables.avg_known_monthly)}/mo</span>
                    </div>
                  </div>
                </div>

                {/* Step 2 */}
                <div className="rounded-lg border border-border bg-card p-3 space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground shrink-0">2</span>
                    <p className="text-xs font-semibold">Apply the 1.33 Welile fee multiplier</p>
                  </div>
                  <div className="pl-7 space-y-1.5">
                    <p className="text-[11px] text-muted-foreground leading-snug">
                      Tenants pay <strong className="text-foreground">rent + 33% Welile facilitation fee</strong>. The 1.33 multiplier represents the total cash-in per house.
                    </p>
                    <div className="rounded-md bg-amber-500/10 border border-amber-500/20 px-3 py-2 space-y-1">
                      <p className="text-[11px] font-medium text-amber-700">Formula</p>
                      <p className="text-sm font-bold text-amber-700 font-mono">Monthly Rent × 1.33 = Total Cash-In</p>
                      <p className="text-[11px] text-muted-foreground">
                        Example: {formatUGX(receivables.avg_known_monthly)} × 1.33 = {formatUGX(Math.round(receivables.avg_known_monthly * 1.33))}
                      </p>
                    </div>
                    <p className="text-[10px] text-muted-foreground leading-snug">
                      Landlord keeps 100% of rent. Welile earns the 33% as platform revenue.
                    </p>
                  </div>
                </div>

                {/* Step 3 */}
                <div className="rounded-lg border border-border bg-card p-3 space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground shrink-0">3</span>
                    <p className="text-xs font-semibold">Multiply by 12 months for annual projection</p>
                  </div>
                  <div className="pl-7 space-y-1.5">
                    <div className="rounded-md bg-emerald-500/10 border border-emerald-500/20 px-3 py-2">
                      <p className="text-[11px] font-medium text-emerald-700">Annual formula</p>
                      <p className="text-sm font-bold text-emerald-700 font-mono">(Rent × 1.33) × 12 = Annual Projection</p>
                      <p className="text-[11px] text-muted-foreground mt-0.5">
                        Example: {formatUGX(Math.round(receivables.avg_known_monthly * 1.33))} × 12 = {formatUGX(Math.round(receivables.avg_known_monthly * 1.33 * 12))}
                      </p>
                    </div>
                  </div>
                </div>

                {/* Step 4 */}
                <div className="rounded-lg border border-border bg-card p-3 space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground shrink-0">4</span>
                    <p className="text-xs font-semibold">Sum recorded + estimated missing amounts</p>
                  </div>
                  <div className="pl-7 space-y-1.5">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-[11px] text-muted-foreground">Recorded (known rents)</span>
                      <span className="text-xs font-semibold tabular-nums">{formatUGX(receivables.empty_receivable_total + receivables.unlisted_receivable_total)}</span>
                    </div>
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-[11px] text-muted-foreground">Estimated (missing rents)</span>
                      <span className="text-xs font-semibold tabular-nums">{formatUGX(Math.max(0, receivables.estimated_full_total - (receivables.empty_receivable_total + receivables.unlisted_receivable_total)))}</span>
                    </div>
                    <div className="flex items-baseline justify-between gap-2 border-t border-border pt-1.5 mt-1">
                      <span className="text-[11px] font-semibold text-foreground">Total projected receivables</span>
                      <span className="text-sm font-bold tabular-nums text-amber-700">{formatUGX(receivables.estimated_full_total)}</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Summary callout */}
              <div className="rounded-md bg-amber-500/10 border border-amber-500/20 px-3 py-2 space-y-1">
                <p className="text-xs font-bold text-amber-700 leading-snug">What does this mean?</p>
                <p className="text-[12px] text-muted-foreground leading-snug">
                  This is the <strong className="text-foreground">annual cash we expect to collect</strong> if every empty house gets a tenant paying full rent plus the Welile fee. It combines what we already know (recorded rents) with what we estimate for houses missing rent data.
                </p>
              </div>

              {/* Action buttons */}
              <div className="space-y-2 pt-1">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 w-full text-[12px] gap-1"
                  onClick={() => { setExplainOpen(false); setEmptyOpen(true); }}
                >
                  <ListChecks className="h-3.5 w-3.5" /> View empty houses to fill
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 w-full text-[12px] gap-1 text-amber-700 hover:text-amber-800"
                  onClick={() => { setExplainOpen(false); navigate('/receivables-audit'); }}
                >
                  <ShieldCheck className="h-3.5 w-3.5" /> View validation / audit report
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
}

type EmptySort = 'rent_desc' | 'recent' | 'oldest' | 'area';

// ===== Agent network card: the driving force across all 3 priorities =====

function AgentNetworkCard({
  network, loading, onOpenAgent, onOpenDriver,
}: {
  network: MissionAgentNetwork | null | undefined;
  loading: boolean;
  onOpenAgent: (id: string) => void;
  onOpenDriver: (key: MissionDriverKey, label: string) => void;
}) {
  if (loading || !network) {
    return <Skeleton className="h-28 w-full mt-2" />;
  }
  const stats: { key: MissionDriverKey; icon: React.ElementType; label: string; value: number; agents: number; tone: string }[] = [
    { key: 'list', icon: Home, label: 'Houses listed', value: network.houses_listed, agents: network.listing_agents, tone: 'text-[#9234EA]' },
    { key: 'place', icon: Users, label: 'Tenants placed', value: network.tenants_placed, agents: network.placement_agents, tone: 'text-emerald-600' },
    { key: 'fund', icon: Handshake, label: 'Funders onboarded', value: network.funders_total, agents: network.funder_agents, tone: 'text-amber-600' },
  ];
  return (
    <div className="rounded-xl border border-primary/30 bg-primary/[0.03] p-3 mt-2">
      <div className="flex items-center justify-between gap-2 mb-2">
        <AgentNetworkBadge />
        <div className="flex items-center gap-1 rounded-md bg-primary/10 px-2 py-0.5">
          <Zap className="h-3 w-3 text-primary" />
          <span className="text-[11px] font-bold text-primary">{network.total_agents.toLocaleString()}</span>
          <span className="text-[10px] text-muted-foreground">active agents</span>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2">
        {stats.map((s) => {
          const Icon = s.icon;
          return (
            <button
              key={s.label}
              type="button"
              onClick={() => onOpenDriver(s.key, s.label)}
              className="rounded-lg border border-border bg-card p-2 text-center hover:bg-muted/40 hover:ring-1 hover:ring-primary/40 transition"
              title={`View the agents, tenants & landlords behind ${s.label}`}
            >
              <Icon className={cn('h-3.5 w-3.5 mx-auto', s.tone)} />
              <p className="text-lg font-bold leading-none mt-1">{s.value.toLocaleString()}</p>
              <p className="text-[10px] text-muted-foreground leading-tight mt-0.5">{s.label}</p>
              <p className="text-[9px] text-primary/80 font-medium mt-0.5">{s.agents.toLocaleString()} agents →</p>
            </button>
          );
        })}
      </div>
      {network.top_agent_id && (
        <button
          onClick={() => onOpenAgent(network.top_agent_id!)}
          className="mt-2 w-full flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-2.5 py-1.5 hover:bg-amber-500/10 transition"
        >
          <Award className="h-3.5 w-3.5 text-amber-600 shrink-0" />
          <span className="text-[11px] font-medium truncate flex-1 text-left">
            Top driver: <span className="font-bold">{network.top_agent_name || 'Agent'}</span>
          </span>
          <Badge variant="outline" className="text-[10px] shrink-0">{network.top_agent_score.toLocaleString()} contributions</Badge>
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        </button>
      )}
    </div>
  );
}

// ===== Agent network driver drill-down dialog =====

const ENTITY_META: Record<MissionDriverEntity['entity_type'], { label: string; plural: string; icon: React.ElementType; tone: string; tab: 'agent' | 'tenant' | 'landlord' | null }> = {
  agent: { label: 'Agent', plural: 'Agents', icon: Users, tone: 'text-blue-600 bg-blue-500/10', tab: 'agent' },
  tenant: { label: 'Tenant', plural: 'Tenants', icon: UserPlus, tone: 'text-emerald-600 bg-emerald-500/10', tab: 'tenant' },
  landlord: { label: 'Landlord', plural: 'Landlords', icon: Home, tone: 'text-[#9234EA] bg-[#9234EA]/10', tab: 'landlord' },
  funder: { label: 'Funder', plural: 'Funders', icon: Handshake, tone: 'text-amber-600 bg-amber-500/10', tab: null },
};

const DRIVER_ORDER: MissionDriverEntity['entity_type'][] = ['agent', 'tenant', 'landlord', 'funder'];

function SearchableEntityFilter({
  value, onChange, options, placeholder, label,
}: {
  value: string;
  onChange: (val: string) => void;
  options: { id: string; name: string }[];
  placeholder?: string;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const selectedName = value === 'all' ? `All ${label?.toLowerCase() || 'items'}` : options.find((o) => o.id === value)?.name;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" className="h-8 text-xs w-full justify-between px-2.5 border-border bg-card font-normal" type="button">
          <span className="truncate">{selectedName || placeholder || 'Select…'}</span>
          <ChevronsUpDown className="ml-2 h-3.5 w-3.5 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="p-0 w-[var(--radix-popover-trigger-width)]" align="start">
        <Command>
          <CommandInput placeholder={`Search ${label?.toLowerCase() || 'items'}…`} />
          <CommandList>
            <CommandEmpty>No results.</CommandEmpty>
            <CommandItem value="__all__" onSelect={() => { onChange('all'); setOpen(false); }}>
              <Check className={cn('mr-2 h-3.5 w-3.5', value === 'all' ? 'opacity-100' : 'opacity-0')} />
              All {label?.toLowerCase() || 'items'}
            </CommandItem>
            <CommandGroup>
              {options.map((o) => (
                <CommandItem key={o.id} value={`${o.id}:${o.name}`} onSelect={() => { onChange(o.id); setOpen(false); }}>
                  <Check className={cn('mr-2 h-3.5 w-3.5', value === o.id ? 'opacity-100' : 'opacity-0')} />
                  {o.name}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function AgentNetworkDriverDialog({
  driver, label, win, refetchIntervalMs, open, onClose, onOpenAgent, onOpenTenant, onOpenLandlord,
}: {
  driver: MissionDriverKey | null;
  label: string;
  win: CounterWindow;
  refetchIntervalMs?: number | false;
  open: boolean;
  onClose: () => void;
  onOpenAgent: (id: string) => void;
  onOpenTenant: (id: string) => void;
  onOpenLandlord: (id: string) => void;
}) {
  const [search, setSearch] = useState('');
  const [type, setType] = useState<'all' | MissionDriverEntity['entity_type']>('all');
  const [sourceAgent, setSourceAgent] = useState<string>('all');
  const [sourceTenant, setSourceTenant] = useState<string>('all');
  const [sourceLandlord, setSourceLandlord] = useState<string>('all');
  const [sourceFunder, setSourceFunder] = useState<string>('all');
  const { data, isLoading } = useMissionDriverEntities(driver, win, open, refetchIntervalMs);
  const rows: MissionDriverEntity[] = data ?? [];

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    rows.forEach((r) => { c[r.entity_type] = (c[r.entity_type] ?? 0) + 1; });
    return c;
  }, [rows]);

  const presentTypes = useMemo(() => DRIVER_ORDER.filter((t) => (counts[t] ?? 0) > 0), [counts]);

  const agents = useMemo(() => rows.filter((r) => r.entity_type === 'agent'), [rows]);
  const tenants = useMemo(() => rows.filter((r) => r.entity_type === 'tenant'), [rows]);
  const landlords = useMemo(() => rows.filter((r) => r.entity_type === 'landlord'), [rows]);
  const funders = useMemo(() => rows.filter((r) => r.entity_type === 'funder'), [rows]);

  const searchLower = search.trim().toLowerCase();
  const filtered = useMemo(() => {
    let r = [...rows];
    if (type !== 'all') r = r.filter((x) => x.entity_type === type);
    if (searchLower) {
      r = r.filter((x) =>
        (x.name?.toLowerCase().includes(searchLower) ?? false) ||
        (x.phone?.toLowerCase().includes(searchLower) ?? false));
    }
    if (sourceAgent !== 'all') {
      r = r.filter((x) =>
        (x.entity_type === 'agent' && x.entity_id === sourceAgent) ||
        x.agent_id === sourceAgent
      );
    }
    if (sourceTenant !== 'all') {
      r = r.filter((x) => x.entity_type === 'tenant' && x.entity_id === sourceTenant);
    }
    if (sourceLandlord !== 'all') {
      r = r.filter((x) => x.entity_type === 'landlord' && x.entity_id === sourceLandlord);
    }
    if (sourceFunder !== 'all') {
      r = r.filter((x) => x.entity_type === 'funder' && x.entity_id === sourceFunder);
    }
    return r;
  }, [rows, type, searchLower, sourceAgent, sourceTenant, sourceLandlord, sourceFunder]);

  const hasActiveFilters = search.trim().length > 0 || type !== 'all' || sourceAgent !== 'all' || sourceTenant !== 'all' || sourceLandlord !== 'all' || sourceFunder !== 'all';

  const openEntity = (e: MissionDriverEntity) => {
    if (!e.entity_id) return;
    const tab = ENTITY_META[e.entity_type].tab;
    if (tab === 'agent') onOpenAgent(e.entity_id);
    else if (tab === 'tenant') onOpenTenant(e.entity_id);
    else if (tab === 'landlord') onOpenLandlord(e.entity_id);
  };

  const resetFilters = () => {
    setSearch('');
    setType('all');
    setSourceAgent('all');
    setSourceTenant('all');
    setSourceLandlord('all');
    setSourceFunder('all');
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) { onClose(); resetFilters(); } }}>
      <DialogContent className="max-w-2xl p-0 gap-0">
        <DialogHeader className="p-4 pb-2">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <DialogTitle className="text-base flex items-center gap-2">
                <Network className="h-4 w-4 text-primary" /> {label || 'Driver'} — agent network
              </DialogTitle>
              <p className="text-[11px] text-muted-foreground">
                The agents, tenants and landlords driving this priority. Tap any name to open their profile.
              </p>
            </div>
            {hasActiveFilters && (
              <Button variant="ghost" size="sm" className="h-8 text-[11px] px-2 shrink-0 mt-0.5" onClick={resetFilters}>
                Clear all
              </Button>
            )}
          </div>
        </DialogHeader>

        <div className="px-4 pb-2 flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 min-w-0">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name or phone…"
              className="pl-7 h-8 text-xs"
            />
          </div>
          <div className="flex rounded-lg border border-border overflow-hidden shrink-0">
            <button
              onClick={() => setType('all')}
              className={cn('px-2 py-1 text-[10px] font-semibold transition whitespace-nowrap',
                type === 'all' ? 'bg-primary text-primary-foreground' : 'bg-card hover:bg-muted/40')}
            >
              All {rows.length}
            </button>
            {presentTypes.map((t) => (
              <button
                key={t}
                onClick={() => setType(t)}
                className={cn('px-2 py-1 text-[10px] font-semibold transition whitespace-nowrap',
                  type === t ? 'bg-primary text-primary-foreground' : 'bg-card hover:bg-muted/40')}
              >
                {ENTITY_META[t].plural} {counts[t]}
              </button>
            ))}
          </div>
        </div>

        {/* Source filters */}
        <div className="px-4 pb-2 flex items-center gap-2 flex-wrap">
          {agents.length > 0 && (
            <div className="flex-1 min-w-[140px]">
              <SearchableEntityFilter
                value={sourceAgent}
                onChange={setSourceAgent}
                options={agents.map((a) => ({ id: a.entity_id || 'unknown', name: a.name || 'Agent' }))}
                label="agents"
                placeholder="Source agent"
              />
            </div>
          )}
          {tenants.length > 0 && (
            <div className="flex-1 min-w-[140px]">
              <SearchableEntityFilter
                value={sourceTenant}
                onChange={setSourceTenant}
                options={tenants.map((t) => ({ id: t.entity_id || 'unknown', name: t.name || 'Tenant' }))}
                label="tenants"
                placeholder="Source tenant"
              />
            </div>
          )}
          {landlords.length > 0 && (
            <div className="flex-1 min-w-[140px]">
              <SearchableEntityFilter
                value={sourceLandlord}
                onChange={setSourceLandlord}
                options={landlords.map((l) => ({ id: l.entity_id || 'unknown', name: l.name || 'Landlord' }))}
                label="landlords"
                placeholder="Source landlord"
              />
            </div>
          )}
          {funders.length > 0 && (
            <div className="flex-1 min-w-[140px]">
              <SearchableEntityFilter
                value={sourceFunder}
                onChange={setSourceFunder}
                options={funders.map((f) => ({ id: f.entity_id || 'unknown', name: f.name || 'Funder' }))}
                label="funders"
                placeholder="Source funder"
              />
            </div>
          )}
          {hasActiveFilters && (
            <Button variant="ghost" size="sm" className="h-8 text-[11px] px-2" onClick={resetFilters}>
              Clear filters
            </Button>
          )}
        </div>

        {/* Active filter chips */}
        {(sourceAgent !== 'all' || sourceTenant !== 'all' || sourceLandlord !== 'all' || sourceFunder !== 'all') && (
          <div className="px-4 pb-2 flex items-center gap-1.5 flex-wrap">
            {sourceAgent !== 'all' && (
              <Badge variant="secondary" className="text-[10px] gap-1 pl-2 pr-1 py-0.5 h-6">
                Agent: {agents.find((a) => a.entity_id === sourceAgent)?.name || sourceAgent}
                <button
                  type="button"
                  onClick={() => setSourceAgent('all')}
                  className="ml-0.5 rounded-sm hover:bg-muted-foreground/20 p-0.5"
                  aria-label="Clear agent filter"
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            )}
            {sourceTenant !== 'all' && (
              <Badge variant="secondary" className="text-[10px] gap-1 pl-2 pr-1 py-0.5 h-6">
                Tenant: {tenants.find((t) => t.entity_id === sourceTenant)?.name || sourceTenant}
                <button
                  type="button"
                  onClick={() => setSourceTenant('all')}
                  className="ml-0.5 rounded-sm hover:bg-muted-foreground/20 p-0.5"
                  aria-label="Clear tenant filter"
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            )}
            {sourceLandlord !== 'all' && (
              <Badge variant="secondary" className="text-[10px] gap-1 pl-2 pr-1 py-0.5 h-6">
                Landlord: {landlords.find((l) => l.entity_id === sourceLandlord)?.name || sourceLandlord}
                <button
                  type="button"
                  onClick={() => setSourceLandlord('all')}
                  className="ml-0.5 rounded-sm hover:bg-muted-foreground/20 p-0.5"
                  aria-label="Clear landlord filter"
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            )}
            {sourceFunder !== 'all' && (
              <Badge variant="secondary" className="text-[10px] gap-1 pl-2 pr-1 py-0.5 h-6">
                Funder: {funders.find((f) => f.entity_id === sourceFunder)?.name || sourceFunder}
                <button
                  type="button"
                  onClick={() => setSourceFunder('all')}
                  className="ml-0.5 rounded-sm hover:bg-muted-foreground/20 p-0.5"
                  aria-label="Clear funder filter"
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            )}
          </div>
        )}

        {!isLoading && rows.length > 0 && (
          <div className="px-4 pb-2">
            <Badge variant="outline" className="text-[10px]">{filtered.length} of {rows.length} shown</Badge>
          </div>
        )}

        <ScrollArea className="max-h-[60vh] px-4 pb-4">
          {isLoading ? (
            <div className="space-y-2">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-14 w-full" />)}</div>
          ) : filtered.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">
              {rows.length === 0 ? 'No activity for this driver in this window.' : 'Nothing matches your filters.'}
            </p>
          ) : (
            <ul className="space-y-1.5">
              {filtered.map((e, i) => {
                const meta = ENTITY_META[e.entity_type];
                const Icon = meta.icon;
                const clickable = !!e.entity_id && !!meta.tab;
                return (
                  <li
                    key={`${e.entity_type}:${e.entity_id ?? i}`}
                    onClick={() => clickable && openEntity(e)}
                    className={cn('rounded-lg border border-border bg-card p-3 flex items-center gap-2',
                      clickable ? 'hover:bg-muted/40 cursor-pointer' : 'opacity-90')}
                  >
                    <div className={cn('p-1.5 rounded-lg shrink-0', meta.tone)}><Icon className="h-3.5 w-3.5" /></div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="font-semibold text-sm truncate">{e.name || `${meta.label}`}</span>
                        <Badge variant="outline" className="text-[9px] shrink-0">{meta.label}</Badge>
                      </div>
                      <div className="flex flex-wrap gap-x-3 text-[10px] text-muted-foreground mt-0.5">
                        {e.phone && <span className="flex items-center gap-1"><Phone className="h-3 w-3" /> {e.phone}</span>}
                        {e.detail && <span>{e.detail}</span>}
                      </div>
                    </div>
                    {clickable && <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />}
                  </li>
                );
              })}
            </ul>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}

// ===== ROI drilldown item detail dialog =====
// Shows the exact inputs used to compute the payout amount for a portfolio,
// plus the full audit trail of reschedules recorded against that portfolio.
function ROIDetailDialog({
  line, onClose, onSchedule,
}: {
  line: ROIPayableLine | null;
  onClose: () => void;
  onSchedule: (line: ROIPayableLine) => void;
}) {
  const open = !!line;
  const portfolioId = line?.id ?? null;

  // Full portfolio record — gives us the canonical inputs & cycle metadata.
  const { data: portfolio, isLoading: pLoading } = useQuery({
    queryKey: ['roi-detail-portfolio', portfolioId],
    enabled: open && !!portfolioId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('investor_portfolios')
        .select('id, portfolio_code, account_name, investment_amount, roi_percentage, next_roi_date, maturity_date, duration_months, total_roi_earned, payout_day, status, created_at')
        .eq('id', portfolioId!)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  // Full audit trail — every reschedule recorded for this portfolio.
  const { data: trail, isLoading: tLoading } = useQuery({
    queryKey: ['roi-detail-trail', portfolioId],
    enabled: open && !!portfolioId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('roi_payout_schedules')
        .select('id, previous_date, scheduled_date, scheduled_by, reason, created_at')
        .eq('portfolio_id', portfolioId!)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });

  // Resolve scheduler names in a single batched query.
  const schedulerIds = useMemo(
    () => Array.from(new Set((trail ?? []).map((r) => r.scheduled_by).filter(Boolean))) as string[],
    [trail],
  );
  const { data: schedulerMap } = useQuery({
    queryKey: ['roi-detail-schedulers', schedulerIds.sort().join(',')],
    enabled: open && schedulerIds.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, full_name, email')
        .in('id', schedulerIds);
      if (error) throw error;
      const m = new Map<string, { full_name: string | null; email: string | null }>();
      (data ?? []).forEach((p: any) => m.set(p.id, { full_name: p.full_name, email: p.email }));
      return m;
    },
  });

  const p: any = portfolio ?? null;
  const investment = Number(p?.investment_amount ?? line?.investment_amount ?? 0);
  const roiPct = Number(p?.roi_percentage ?? line?.roi_percentage ?? 0);
  const payout = investment * roiPct / 100;
  const fmtDate = (d: string | null | undefined) => d ? new Date(d).toLocaleDateString() : '—';
  const fmtDT = (d: string | null | undefined) => d ? new Date(d).toLocaleString() : '—';

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-2xl p-0 gap-0">
        <DialogHeader className="px-4 pt-4 pb-2 border-b border-border">
          <DialogTitle className="text-sm flex items-center gap-2">
            <FileText className="h-4 w-4 text-primary" />
            ROI payout detail
          </DialogTitle>
          <p className="text-[11px] text-muted-foreground">
            {p?.account_name || line?.account_name || 'Funder'} · Portfolio {p?.portfolio_code || line?.portfolio_code}
          </p>
        </DialogHeader>

        <ScrollArea className="max-h-[70vh]">
          <div className="p-4 space-y-4">
            {/* Calculation inputs */}
            <section className="rounded-lg border border-border bg-card">
              <div className="px-3 py-2 border-b border-border flex items-center gap-2">
                <TrendingUp className="h-3.5 w-3.5 text-primary" />
                <h4 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Calculation inputs</h4>
              </div>
              {pLoading ? (
                <div className="p-3"><Skeleton className="h-16 w-full" /></div>
              ) : (
                <div className="p-3 space-y-2">
                  <div className="grid grid-cols-2 gap-2 text-[11px]">
                    <div className="rounded border border-border/70 p-2">
                      <div className="text-muted-foreground">Investment amount</div>
                      <div className="font-semibold tabular-nums">{formatUGX(investment)}</div>
                    </div>
                    <div className="rounded border border-border/70 p-2">
                      <div className="text-muted-foreground">ROI rate (monthly)</div>
                      <div className="font-semibold tabular-nums">{roiPct}%</div>
                    </div>
                    <div className="rounded border border-border/70 p-2">
                      <div className="text-muted-foreground">Current payout date</div>
                      <div className="font-semibold">{fmtDate(p?.next_roi_date ?? line?.next_roi_date)}</div>
                    </div>
                    <div className="rounded border border-border/70 p-2">
                      <div className="text-muted-foreground">Maturity date</div>
                      <div className="font-semibold">{fmtDate(p?.maturity_date)}</div>
                    </div>
                    <div className="rounded border border-border/70 p-2">
                      <div className="text-muted-foreground">Status</div>
                      <div className="font-semibold capitalize">{p?.status ?? '—'}</div>
                    </div>
                    <div className="rounded border border-border/70 p-2">
                      <div className="text-muted-foreground">Created</div>
                      <div className="font-semibold">{fmtDate(p?.created_at)}</div>
                    </div>
                    <div className="rounded border border-border/70 p-2">
                      <div className="text-muted-foreground">Duration</div>
                      <div className="font-semibold">{p?.duration_months ?? '—'} months</div>
                    </div>
                    <div className="rounded border border-border/70 p-2">
                      <div className="text-muted-foreground">Total ROI paid</div>
                      <div className="font-semibold tabular-nums">{formatUGX(Number(p?.total_roi_earned || 0))}</div>
                    </div>
                  </div>
                  <div className="mt-2 rounded-md bg-amber-500/10 border border-amber-500/30 px-3 py-2 flex items-center justify-between gap-2">
                    <div className="text-[11px] text-amber-900 dark:text-amber-200">
                      <span className="font-mono">{formatUGX(investment)} × {roiPct}%</span>
                      <span className="mx-1 opacity-70">=</span>
                    </div>
                    <div className="text-base font-bold tabular-nums text-amber-800 dark:text-amber-200">
                      {formatUGX(payout)}
                    </div>
                  </div>
                </div>
              )}
            </section>

            {/* Audit trail */}
            <section className="rounded-lg border border-border bg-card">
              <div className="px-3 py-2 border-b border-border flex items-center gap-2">
                <History className="h-3.5 w-3.5 text-primary" />
                <h4 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Audit trail
                </h4>
                <span className="ml-auto text-[10px] text-muted-foreground">
                  {(trail ?? []).length} entr{(trail ?? []).length === 1 ? 'y' : 'ies'}
                </span>
              </div>
              {tLoading ? (
                <div className="p-3 space-y-1.5">
                  {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
                </div>
              ) : (trail?.length ?? 0) === 0 ? (
                <p className="p-4 text-[11px] text-muted-foreground text-center">
                  No reschedules recorded — this record has never been modified.
                </p>
              ) : (
                <ol className="p-2 space-y-1.5">
                  {trail!.map((r: any) => {
                    const who = schedulerMap?.get(r.scheduled_by);
                    return (
                      <li key={r.id} className="rounded border border-border/70 p-2 text-[11px]">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-semibold flex items-center gap-1">
                            <CalendarDays className="h-3 w-3 text-primary" />
                            {fmtDate(r.previous_date)} <ArrowRight className="h-3 w-3" /> {fmtDate(r.scheduled_date)}
                          </span>
                          <span className="text-[10px] text-muted-foreground">{fmtDT(r.created_at)}</span>
                        </div>
                        <div className="mt-1 text-[10px] text-muted-foreground">
                          By <span className="font-medium text-foreground">{who?.full_name || who?.email || r.scheduled_by.slice(0, 8)}</span>
                        </div>
                        {r.reason && (
                          <div className="mt-1 text-[11px] italic text-muted-foreground">"{r.reason}"</div>
                        )}
                      </li>
                    );
                  })}
                </ol>
              )}
            </section>
          </div>
        </ScrollArea>

        <div className="px-4 py-3 border-t border-border flex items-center justify-end gap-2">
          <Button variant="outline" size="sm" className="h-8 text-[11px]" onClick={onClose}>Close</Button>
          {line && (
            <Button size="sm" className="h-8 text-[11px] gap-1" onClick={() => onSchedule(line)}>
              <CalendarDays className="h-3.5 w-3.5" /> Reschedule
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ===== ROI payable export helpers (CSV + PDF) =====

function exportRoiPayableCsv(rows: ROIPayableLine[], windowDays: number, total: number) {
  const header = ['Funder', 'Portfolio', 'Investment (UGX)', 'ROI %', 'Payout date', 'Amount (UGX)'];
  const esc = (v: unknown) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [header.join(',')];
  rows.forEach((r) => {
    lines.push([
      esc(r.account_name || 'Funder'),
      esc(r.portfolio_code || ''),
      esc(Math.round(r.investment_amount)),
      esc(r.roi_percentage),
      esc(new Date(r.next_roi_date).toISOString().slice(0, 10)),
      esc(Math.round(r.roi_amount)),
    ].join(','));
  });
  lines.push(['', '', '', '', 'TOTAL', esc(Math.round(total))].join(','));
  const blob = new Blob(['\uFEFF' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `roi-payable-${windowDays}d-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
  toast.success(`Exported ${rows.length} row${rows.length === 1 ? '' : 's'} to CSV`);
}

async function exportRoiPayablePdf(rows: ROIPayableLine[], windowDays: number, total: number) {
  try {
    const { default: jsPDF } = await import('jspdf');
    const autoTable = (await import('jspdf-autotable')).default;
    const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    const generatedAt = new Date();
    pdf.setFontSize(14);
    pdf.text('ROI payable — next cycle', 14, 14);
    pdf.setFontSize(9);
    pdf.setTextColor(120);
    pdf.text(`Window: next ${windowDays} day${windowDays === 1 ? '' : 's'} · ${rows.length} portfolio${rows.length === 1 ? '' : 's'} · Total UGX ${Math.round(total).toLocaleString()}`, 14, 20);
    pdf.text(`Generated ${generatedAt.toLocaleString()}`, 14, 25);
    autoTable(pdf, {
      startY: 30,
      head: [['Funder', 'Portfolio', 'Investment', 'ROI %', 'Payout date', 'Amount']],
      body: rows.map((r) => [
        r.account_name || 'Funder',
        r.portfolio_code || '',
        `UGX ${Math.round(r.investment_amount).toLocaleString()}`,
        `${r.roi_percentage}%`,
        new Date(r.next_roi_date).toLocaleDateString(),
        `UGX ${Math.round(r.roi_amount).toLocaleString()}`,
      ]),
      foot: [[
        { content: 'TOTAL', colSpan: 5, styles: { halign: 'right', fontStyle: 'bold' } },
        { content: `UGX ${Math.round(total).toLocaleString()}`, styles: { fontStyle: 'bold' } },
      ]],
      styles: { fontSize: 8, cellPadding: 2 },
      headStyles: { fillColor: [88, 28, 135], textColor: 255 },
      footStyles: { fillColor: [245, 235, 255], textColor: 20 },
      columnStyles: {
        2: { halign: 'right' },
        3: { halign: 'right' },
        5: { halign: 'right' },
      },
    });
    pdf.save(`roi-payable-${windowDays}d-${new Date().toISOString().slice(0, 10)}.pdf`);
    toast.success(`Exported ${rows.length} row${rows.length === 1 ? '' : 's'} to PDF`);
  } catch (e) {
    console.error('[roi-payable] PDF export failed', e);
    toast.error('PDF export failed');
  }
}

function statusTone(status: string | null): string {
  switch ((status || '').toLowerCase()) {
    case 'available': return 'text-emerald-600 bg-emerald-500/10';
    case 'pending': return 'text-amber-600 bg-amber-500/10';
    case 'reserved': return 'text-blue-600 bg-blue-500/10';
    default: return 'text-muted-foreground bg-muted';
  }
}

function EmptyHousesDialog({
  open, win, refetchIntervalMs, onClose, onOpenLandlord, onOpenAgent,
}: {
  open: boolean;
  win: CounterWindow;
  refetchIntervalMs?: number | false;
  onClose: () => void;
  onOpenLandlord: (id: string) => void;
  onOpenAgent: (id: string) => void;
}) {
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<EmptySort>('rent_desc');
  const [targetFilter, setTargetFilter] = useState<'all' | 'targeted' | 'untargeted'>('all');
  const [monthFilter, setMonthFilter] = useState<string>('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const { data, isLoading } = useMissionEmptyHouses(win, open, refetchIntervalMs);
  const houses: MissionEmptyHouseRow[] = data ?? [];

  // Global (window-independent) average known rent — keeps projections alive
  // for short windows (2/7/30 days) where no in-window house has a recorded rent.
  const { data: rcvForEstimate } = useMissionReceivables(win, refetchIntervalMs);
  const globalAvgMonthly = Math.round(Number(rcvForEstimate?.avg_known_monthly) || 0);

  // Estimate rent for houses that have no recorded rent amount.
  // We learn from the houses that DO have a known rent in this window:
  //   • avg per room  → scales the estimate by number_of_rooms when known
  //   • avg overall   → fallback when room count is missing
  const rentEstimate = useMemo(
    () => buildRentEstimator(houses, globalAvgMonthly),
    [houses, globalAvgMonthly],
  );

  const { data: targets } = useLandlordOnboardingTargets(open);
  const targetLandlord = useTargetLandlordForOnboarding();
  const bulkTarget = useBulkTargetLandlordsForOnboarding();
  const [targeting, setTargeting] = useState<string | null>(null);
  const [bulkTargeting, setBulkTargeting] = useState(false);
  const [photosOpen, setPhotosOpen] = useState<Set<string>>(new Set());
  const togglePhotos = (listingId: string) =>
    setPhotosOpen((prev) => {
      const next = new Set(prev);
      next.has(listingId) ? next.delete(listingId) : next.add(listingId);
      return next;
    });

  const handleTargetAndOpen = async (landlordId: string, listingId: string) => {
    setTargeting(landlordId);
    try {
      if (!targets?.[landlordId]) {
        await targetLandlord(landlordId, listingId);
        toast.success('Landlord marked as targeted for onboarding');
      }
      onOpenLandlord(landlordId);
    } catch (e: any) {
      toast.error(e?.message || 'Could not mark landlord as targeted');
    } finally {
      setTargeting(null);
    }
  };

  const searchLower = search.trim().toLowerCase();
  const monthOptions = useMemo(() => {
    const map = new Map<string, { key: string; label: string; count: number }>();
    houses.forEach((h) => {
      if (!h.created_at) return;
      const d = new Date(h.created_at);
      if (Number.isNaN(d.getTime())) return;
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const label = d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
      const existing = map.get(key);
      if (existing) existing.count += 1;
      else map.set(key, { key, label, count: 1 });
    });
    return [...map.values()].sort((a, b) => b.key.localeCompare(a.key));
  }, [houses]);
  const filtered = useMemo(() => {
    let r = [...houses];
    if (searchLower) {
      r = r.filter((h) =>
        (h.title?.toLowerCase().includes(searchLower) ?? false) ||
        (h.area?.toLowerCase().includes(searchLower) ?? false) ||
        (h.region?.toLowerCase().includes(searchLower) ?? false) ||
        (h.district?.toLowerCase().includes(searchLower) ?? false) ||
        (h.landlord_name?.toLowerCase().includes(searchLower) ?? false) ||
        (h.landlord_phone?.toLowerCase().includes(searchLower) ?? false) ||
        (h.agent_name?.toLowerCase().includes(searchLower) ?? false));
    }
    if (monthFilter !== 'all') {
      r = r.filter((h) => {
        if (!h.created_at) return false;
        const d = new Date(h.created_at);
        if (Number.isNaN(d.getTime())) return false;
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        return key === monthFilter;
      });
    }
    if (targetFilter === 'targeted') {
      r = r.filter((h) => !!h.landlord_id && !!targets?.[h.landlord_id]);
    } else if (targetFilter === 'untargeted') {
      r = r.filter((h) => !h.landlord_id || !targets?.[h.landlord_id]);
    }
    r.sort((a, b) => {
      switch (sort) {
        case 'rent_desc': return ((b.monthly_rent || rentEstimate.estimateFor(b)) || 0) - ((a.monthly_rent || rentEstimate.estimateFor(a)) || 0);
        case 'recent': return new Date(b.last_activity || 0).getTime() - new Date(a.last_activity || 0).getTime();
        case 'oldest': return new Date(a.last_activity || 0).getTime() - new Date(b.last_activity || 0).getTime();
        case 'area': return (a.area || '~').localeCompare(b.area || '~');
        default: return 0;
      }
    });
    return r;
  }, [houses, searchLower, sort, targetFilter, monthFilter, targets, rentEstimate]);

  const selectable = useMemo(() => {
    const ids = new Set<string>();
    filtered.forEach((h) => {
      if (h.landlord_id && !targets?.[h.landlord_id]) ids.add(h.landlord_id);
    });
    return ids;
  }, [filtered, targets]);

  const allSelected = selectable.size > 0 && [...selectable].every((id) => selected.has(id));

  const toggleSelectAll = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allSelected) {
        selectable.forEach((id) => next.delete(id));
      } else {
        selectable.forEach((id) => next.add(id));
      }
      return next;
    });
  };

  const toggleOne = (landlordId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(landlordId)) next.delete(landlordId);
      else next.add(landlordId);
      return next;
    });
  };

  const handleBulkTarget = async () => {
    if (selected.size === 0) return;
    setBulkTargeting(true);
    try {
      const items = filtered
        .filter((h) => h.landlord_id && selected.has(h.landlord_id))
        .map((h) => ({ landlordId: h.landlord_id!, listingId: h.listing_id }));
      // deduplicate by landlordId
      const seen = new Set<string>();
      const deduped = items.filter((i) => {
        if (seen.has(i.landlordId)) return false;
        seen.add(i.landlordId);
        return true;
      });
      await bulkTarget(deduped);
      toast.success(`${deduped.length} landlord${deduped.length === 1 ? '' : 's'} marked as targeted`);
      setSelected(new Set());
    } catch (e: any) {
      toast.error(e?.message || 'Bulk targeting failed');
    } finally {
      setBulkTargeting(false);
    }
  };

  const unregistered = houses.filter((h) => !h.landlord_id).length;
  const targetedCount = houses.filter((h) => h.landlord_id && targets?.[h.landlord_id]).length;

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) { onClose(); setSelected(new Set()); setMonthFilter('all'); } }}>
      <DialogContent className="max-w-2xl p-0 gap-0">
        <DialogHeader className="p-4 pb-2">
          <DialogTitle className="text-base flex items-center gap-2">
            <Building2 className="h-4 w-4 text-primary" /> Empty houses to fill
          </DialogTitle>
          <p className="text-[11px] text-muted-foreground">
            Vacant listings ranked by impact — target the landlords behind the highest-rent, longest-empty units.
          </p>
        </DialogHeader>

        <div className="px-4 pb-2 flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 min-w-0">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search area, landlord, agent…"
              className="pl-7 h-8 text-xs"
            />
          </div>
          <div className="flex rounded-lg border border-border overflow-hidden shrink-0">
            {([
              { key: 'rent_desc', label: 'Rent' },
              { key: 'recent', label: 'Recent' },
              { key: 'oldest', label: 'Oldest' },
              { key: 'area', label: 'Area' },
            ] as { key: EmptySort; label: string }[]).map((s) => (
              <button
                key={s.key}
                onClick={() => setSort(s.key)}
                className={cn('px-2 py-1 text-[10px] font-semibold transition whitespace-nowrap',
                  sort === s.key ? 'bg-primary text-primary-foreground' : 'bg-card hover:bg-muted/40')}
              >
                {s.label}
              </button>
            ))}
          </div>
          <div className="flex rounded-lg border border-border overflow-hidden shrink-0">
            {([
              { key: 'all', label: 'All' },
              { key: 'targeted', label: 'Targeted' },
              { key: 'untargeted', label: 'Not targeted' },
            ] as { key: 'all' | 'targeted' | 'untargeted'; label: string }[]).map((f) => (
              <button
                key={f.key}
                onClick={() => setTargetFilter(f.key)}
                className={cn('px-2 py-1 text-[10px] font-semibold transition whitespace-nowrap',
                  targetFilter === f.key ? 'bg-primary text-primary-foreground' : 'bg-card hover:bg-muted/40')}
              >
                {f.label}
              </button>
            ))}
          </div>
          <Select value={monthFilter} onValueChange={setMonthFilter}>
            <SelectTrigger className="h-8 w-[150px] text-[11px] shrink-0">
              <CalendarDays className="h-3.5 w-3.5 mr-1 text-muted-foreground" />
              <SelectValue placeholder="Month listed" />
            </SelectTrigger>
            <SelectContent className="pointer-events-auto">
              <SelectItem value="all" className="text-xs">All months</SelectItem>
              {monthOptions.map((m) => (
                <SelectItem key={m.key} value={m.key} className="text-xs">
                  {m.label} ({m.count})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {!isLoading && houses.length > 0 && (
          <div className="px-4 pb-2 flex flex-wrap items-center gap-1.5 text-[10px]">
            <Badge variant="outline" className="text-[10px]">{filtered.length} of {houses.length} shown</Badge>
            {unregistered > 0 && (
              <Badge className="text-[10px] text-amber-600 bg-amber-500/10">{unregistered} need landlord onboarding</Badge>
            )}
            {targetedCount > 0 && (
              <Badge className="text-[10px] text-emerald-600 bg-emerald-500/10">{targetedCount} targeted for onboarding</Badge>
            )}
            {selectable.size > 0 && (
              <label className="flex items-center gap-1.5 ml-auto cursor-pointer select-none">
                <Checkbox
                  checked={allSelected}
                  onCheckedChange={toggleSelectAll}
                  aria-label="Select all targetable landlords"
                />
                <span className="text-[10px] font-medium text-muted-foreground">Select all {selectable.size}</span>
              </label>
            )}
          </div>
        )}

        <ScrollArea className="max-h-[60vh] px-4 pb-4">
          {isLoading ? (
            <div className="space-y-2">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-20 w-full" />)}</div>
          ) : filtered.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">
              {houses.length === 0 ? 'No empty houses in this window.' : 'No houses match your search.'}
            </p>
          ) : (
            <ul className="space-y-1.5">
              {filtered.map((h) => {
                const canSelect = !!h.landlord_id && !targets?.[h.landlord_id];
                const isSelected = !!h.landlord_id && selected.has(h.landlord_id);
                return (
                  <li key={h.listing_id} className={cn('rounded-lg border bg-card p-3', isSelected ? 'border-primary ring-1 ring-primary/30' : 'border-border')}>
                    <div className="flex items-center gap-2">
                      {canSelect && (
                        <Checkbox
                          checked={isSelected}
                          onCheckedChange={() => toggleOne(h.landlord_id!)}
                          aria-label={`Select ${h.landlord_name || 'landlord'}`}
                          className="shrink-0"
                        />
                      )}
                      <span className="font-semibold text-sm truncate flex-1">{h.title || 'Untitled house'}</span>
                      {h.verified && <ShieldCheck className="h-3.5 w-3.5 text-emerald-600 shrink-0" />}
                      <Badge className={cn('text-[10px] shrink-0', statusTone(h.status))}>{h.status || 'unknown'}</Badge>
                    </div>
                    <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1.5 text-[10px] text-muted-foreground">
                      <span className="flex items-center gap-1"><MapPin className="h-3 w-3" /> {h.area || 'Unspecified area'}</span>
                      {h.monthly_rent ? (
                        <span className="text-foreground font-semibold">{formatUGX(h.monthly_rent)}/mo</span>
                      ) : null}
                      {h.number_of_rooms ? <span className="flex items-center gap-1"><BedDouble className="h-3 w-3" /> {h.number_of_rooms} rm</span> : null}
                      <span>Last activity {fmtDate(h.last_activity)}</span>
                    </div>
                    {h.monthly_rent ? (
                      <p className="mt-1 text-[10px] text-muted-foreground">
                        Annual rent {formatUGX(h.monthly_rent * 12)}/yr <span className="text-muted-foreground/70">(monthly × 12)</span>
                      </p>
                    ) : rentEstimate.estimateFor(h) > 0 ? (
                      <div className="mt-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2 py-1.5">
                        <div className="flex items-center gap-1 text-amber-700">
                          <TrendingUp className="h-3 w-3" />
                          <span className="text-[9px] font-bold uppercase tracking-wide leading-none">Rent not recorded — projected</span>
                        </div>
                        <div className="mt-1 grid grid-cols-2 gap-2">
                          <div>
                            <p className="text-sm font-bold text-amber-700 tabular-nums leading-tight">~{formatUGX(rentEstimate.estimateFor(h))}/mo</p>
                            <p className="text-[9px] text-muted-foreground leading-tight">Estimated monthly</p>
                          </div>
                          <div>
                            <TooltipProvider>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <p className="text-sm font-bold text-amber-600 tabular-nums leading-tight cursor-help">~{formatUGX(rentEstimate.estimateFor(h) * 12)}/yr</p>
                                </TooltipTrigger>
                                <TooltipContent side="top" className="max-w-[260px] space-y-1.5">
                                  <p className="text-xs font-bold">How monthly rent becomes annual projected receivables</p>
                                  <p className="text-[11px] text-muted-foreground leading-snug">
                                    <strong>Step 1:</strong> Estimated monthly rent = ~{formatUGX(rentEstimate.estimateFor(h))}/mo
                                  </p>
                                  <p className="text-[11px] text-muted-foreground leading-snug">
                                    <strong>Step 2:</strong> Apply 1.33 multiplier = {formatUGX(rentEstimate.estimateFor(h) * 1.33)}/mo total cash-in (includes 33% Welile fee)
                                  </p>
                                  <p className="text-[11px] text-muted-foreground leading-snug">
                                    <strong>Step 3:</strong> Annual projection = {formatUGX(rentEstimate.estimateFor(h) * 1.33)}/mo × 12 months = <strong>{formatUGX(rentEstimate.estimateFor(h) * 1.33 * 12)}</strong>
                                  </p>
                                  <p className="text-[11px] text-muted-foreground leading-snug">
                                    The landlord keeps 100% of rent. Welile earns the 33% facilitation fee.
                                  </p>
                                </TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                            <p className="text-[9px] text-muted-foreground leading-tight">Projected annual (× 12)</p>
                          </div>
                        </div>
                        <p className="mt-1 text-[9px] text-muted-foreground leading-tight">
                          {h.number_of_rooms
                            ? `Based on ${h.number_of_rooms} room${h.number_of_rooms === 1 ? '' : 's'} × avg ~${formatUGX(rentEstimate.avgPerRoom)}/room. `
                            : `Based on avg ~${formatUGX(rentEstimate.avgOverall)}/mo of comparable listings. `}
                          Estimate only — confirm actual rent during onboarding.
                        </p>
                      </div>
                    ) : null}
                    <div className="flex flex-wrap items-center gap-1.5 mt-2">
                      {h.landlord_id ? (
                        <button
                          onClick={() => onOpenLandlord(h.landlord_id!)}
                          className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium border border-border text-[#9234EA] bg-[#9234EA]/10 hover:ring-1 hover:ring-primary"
                        >
                          <Home className="h-3 w-3" /> {h.landlord_name || 'Landlord'}
                          {h.landlord_phone && <span className="text-muted-foreground font-normal">· {h.landlord_phone}</span>}
                        </button>
                      ) : (
                        <span className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium border border-amber-500/40 text-amber-600 bg-amber-500/10">
                          <UserPlus className="h-3 w-3" /> Landlord not onboarded
                        </span>
                      )}
                      {h.agent_id && (
                        <button
                          onClick={() => onOpenAgent(h.agent_id!)}
                          className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium border border-border text-blue-600 bg-blue-500/10 hover:ring-1 hover:ring-primary"
                        >
                          <Users className="h-3 w-3" /> {h.agent_name || 'Agent'}
                        </button>
                      )}
                    </div>
                    {h.landlord_id && (() => {
                      const isTargeted = !!targets?.[h.landlord_id!];
                      const isBusy = targeting === h.landlord_id;
                      return (
                        <Button
                          variant={isTargeted ? 'secondary' : 'outline'}
                          size="sm"
                          disabled={isBusy}
                          onClick={() => handleTargetAndOpen(h.landlord_id!, h.listing_id)}
                          className="h-7 w-full mt-2 text-[11px] gap-1"
                        >
                          {isBusy ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : isTargeted ? (
                            <Check className="h-3.5 w-3.5 text-emerald-600" />
                          ) : (
                            <Crosshair className="h-3.5 w-3.5" />
                          )}
                          {isTargeted ? 'Targeted — open profile' : 'Target landlord & open profile'}
                        </Button>
                      );
                    })()}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => togglePhotos(h.listing_id)}
                      className="h-7 w-full mt-1.5 text-[11px] gap-1 justify-center text-muted-foreground hover:text-foreground"
                    >
                      <ImageIcon className="h-3.5 w-3.5" />
                      {photosOpen.has(h.listing_id) ? 'Hide photos' : 'Manage photos'}
                    </Button>
                    {photosOpen.has(h.listing_id) && (
                      <ListingPhotoGallery listingId={h.listing_id} enabled />
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </ScrollArea>

        {/* Bulk action bar */}
        {selected.size > 0 && (
          <div className="border-t border-border bg-muted/40 px-4 py-3 flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-muted-foreground">
              {selected.size} landlord{selected.size === 1 ? '' : 's'} selected
            </span>
            <Button
              size="sm"
              disabled={bulkTargeting}
              onClick={handleBulkTarget}
              className="h-8 text-[11px] gap-1"
            >
              {bulkTargeting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Crosshair className="h-3.5 w-3.5" />}
              Mark {selected.size} as targeted
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ===== Placed tenants (occupied houses) dialog =====

type PlacedSort = 'recent' | 'rent_desc' | 'name';

function PlacedTenantsDialog({
  open, win, refetchIntervalMs, onClose, onOpenLandlord, onOpenAgent,
}: {
  open: boolean;
  win: CounterWindow;
  refetchIntervalMs?: number | false;
  onClose: () => void;
  onOpenLandlord: (id: string) => void;
  onOpenAgent: (id: string) => void;
}) {
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<PlacedSort>('recent');
  const [mode, setMode] = useState<'browse' | 'edit'>('browse');
  const { data, isLoading } = useMissionPlacements(win, open, refetchIntervalMs);
  const rows: MissionPlacementRow[] = data ?? [];

  const searchLower = search.trim().toLowerCase();
  const filtered = useMemo(() => {
    let r = [...rows];
    if (searchLower) {
      r = r.filter((p) =>
        (p.landlord_name?.toLowerCase().includes(searchLower) ?? false) ||
        (p.landlord_phone?.toLowerCase().includes(searchLower) ?? false) ||
        (p.tenant_name?.toLowerCase().includes(searchLower) ?? false) ||
        (p.tenant_phone?.toLowerCase().includes(searchLower) ?? false) ||
        (p.property_address?.toLowerCase().includes(searchLower) ?? false) ||
        (p.agent_name?.toLowerCase().includes(searchLower) ?? false));
    }
    r.sort((a, b) => {
      switch (sort) {
        case 'rent_desc': return (b.monthly_rent || 0) - (a.monthly_rent || 0);
        case 'name': return (a.landlord_name || '~').localeCompare(b.landlord_name || '~');
        case 'recent':
        default: return new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime();
      }
    });
    return r;
  }, [rows, searchLower, sort]);

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-2xl p-0 gap-0">
        <DialogHeader className="p-4 pb-2">
          <DialogTitle className="text-base flex items-center gap-2">
            <Users className="h-4 w-4 text-emerald-600" /> Placed tenants — occupied houses
          </DialogTitle>
          <p className="text-[11px] text-muted-foreground">
            Each landlord linked to a tenant is an occupied house. Tap a landlord, tenant or agent to open their profile.
          </p>
        </DialogHeader>

        <div className="px-4 pb-2">
          <div className="flex rounded-lg border border-border overflow-hidden">
            {([
              { key: 'browse', label: 'Occupied houses' },
              { key: 'edit', label: 'Search & edit balances' },
            ] as { key: 'browse' | 'edit'; label: string }[]).map((m) => (
              <button
                key={m.key}
                onClick={() => setMode(m.key)}
                className={cn('flex-1 px-2 py-1.5 text-[11px] font-semibold transition',
                  mode === m.key ? 'bg-primary text-primary-foreground' : 'bg-card hover:bg-muted/40')}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>

        {mode === 'edit' ? (
          <div className="px-4 pb-4">
            <TenantBalanceEditPanel onOpenAgent={onOpenAgent} />
          </div>
        ) : (
        <>
        <div className="px-4 pb-2 flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 min-w-0">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search landlord, tenant, agent…"
              className="pl-7 h-8 text-xs"
            />
          </div>
          <div className="flex rounded-lg border border-border overflow-hidden shrink-0">
            {([
              { key: 'recent', label: 'Recent' },
              { key: 'rent_desc', label: 'Rent' },
              { key: 'name', label: 'Name' },
            ] as { key: PlacedSort; label: string }[]).map((s) => (
              <button
                key={s.key}
                onClick={() => setSort(s.key)}
                className={cn('px-2 py-1 text-[10px] font-semibold transition whitespace-nowrap',
                  sort === s.key ? 'bg-primary text-primary-foreground' : 'bg-card hover:bg-muted/40')}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>

        {!isLoading && rows.length > 0 && (
          <div className="px-4 pb-2">
            <Badge variant="outline" className="text-[10px]">{filtered.length} of {rows.length} occupied houses</Badge>
          </div>
        )}

        <ScrollArea className="max-h-[60vh] px-4 pb-4">
          {isLoading ? (
            <div className="space-y-2">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-20 w-full" />)}</div>
          ) : filtered.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">
              {rows.length === 0 ? 'No placed tenants in this window.' : 'No placements match your search.'}
            </p>
          ) : (
            <ul className="space-y-1.5">
              {filtered.map((p) => (
                <li key={p.landlord_id} className="rounded-lg border border-border bg-card p-3">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-sm truncate flex-1">{p.property_address || p.landlord_name || 'Occupied house'}</span>
                    {p.verified && <ShieldCheck className="h-3.5 w-3.5 text-emerald-600 shrink-0" />}
                    {p.monthly_rent ? <Badge className="text-[10px] shrink-0 text-foreground bg-muted">{formatUGX(p.monthly_rent)}/mo</Badge> : null}
                  </div>
                  <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1 text-[10px] text-muted-foreground">
                    <span>Placed {fmtDate(p.created_at)}</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5 mt-2">
                    <button
                      onClick={() => onOpenLandlord(p.landlord_id)}
                      className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium border border-border text-[#9234EA] bg-[#9234EA]/10 hover:ring-1 hover:ring-primary"
                    >
                      <Home className="h-3 w-3" /> {p.landlord_name || 'Landlord'}
                      {p.landlord_phone && <span className="text-muted-foreground font-normal">· {p.landlord_phone}</span>}
                    </button>
                    <span className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium border border-border text-emerald-600 bg-emerald-500/10">
                      <Users className="h-3 w-3" /> {p.tenant_name || 'Tenant'}
                      {p.tenant_phone && <span className="text-muted-foreground font-normal">· {p.tenant_phone}</span>}
                    </span>
                    {p.agent_id && (
                      <button
                        onClick={() => onOpenAgent(p.agent_id!)}
                        className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium border border-border text-blue-600 bg-blue-500/10 hover:ring-1 hover:ring-primary"
                      >
                        <UserPlus className="h-3 w-3" /> {p.agent_name || 'Agent'}
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </ScrollArea>
        </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ===== Funders dialog (Partner Ops portfolios + promissory notes) =====

type FunderSort = 'recent' | 'amount_desc' | 'name';

function FundersDialog({
  open, win, refetchIntervalMs, onClose, onOpenAgent,
}: {
  open: boolean;
  win: CounterWindow;
  refetchIntervalMs?: number | false;
  onClose: () => void;
  onOpenAgent: (id: string) => void;
}) {
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<FunderSort>('recent');
  const [sourceFilter, setSourceFilter] = useState<'all' | 'portfolio' | 'promissory'>('all');
  const { data, isLoading } = useMissionFunders(win, open, refetchIntervalMs);
  const rows: MissionFunderRow[] = data ?? [];

  const searchLower = search.trim().toLowerCase();
  const filtered = useMemo(() => {
    let r = [...rows];
    if (sourceFilter !== 'all') r = r.filter((f) => f.source === sourceFilter);
    if (searchLower) {
      r = r.filter((f) =>
        (f.name?.toLowerCase().includes(searchLower) ?? false) ||
        (f.phone?.toLowerCase().includes(searchLower) ?? false) ||
        (f.reference?.toLowerCase().includes(searchLower) ?? false) ||
        (f.agent_name?.toLowerCase().includes(searchLower) ?? false));
    }
    r.sort((a, b) => {
      switch (sort) {
        case 'amount_desc': return (b.amount || 0) - (a.amount || 0);
        case 'name': return (a.name || '~').localeCompare(b.name || '~');
        case 'recent':
        default: return new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime();
      }
    });
    return r;
  }, [rows, searchLower, sort, sourceFilter]);

  const activatedCount = rows.filter((f) => f.activated).length;

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-2xl p-0 gap-0">
        <DialogHeader className="p-4 pb-2">
          <DialogTitle className="text-base flex items-center gap-2">
            <Handshake className="h-4 w-4 text-amber-600" /> Onboarded funders
          </DialogTitle>
          <p className="text-[11px] text-muted-foreground">
            Funders from Partner Ops portfolios and promissory notes, with their committed amount and activation status.
          </p>
        </DialogHeader>

        <div className="px-4 pb-2 flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 min-w-0">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search funder, agent, reference…"
              className="pl-7 h-8 text-xs"
            />
          </div>
          <div className="flex rounded-lg border border-border overflow-hidden shrink-0">
            {([
              { key: 'recent', label: 'Recent' },
              { key: 'amount_desc', label: 'Amount' },
              { key: 'name', label: 'Name' },
            ] as { key: FunderSort; label: string }[]).map((s) => (
              <button
                key={s.key}
                onClick={() => setSort(s.key)}
                className={cn('px-2 py-1 text-[10px] font-semibold transition whitespace-nowrap',
                  sort === s.key ? 'bg-primary text-primary-foreground' : 'bg-card hover:bg-muted/40')}
              >
                {s.label}
              </button>
            ))}
          </div>
          <div className="flex rounded-lg border border-border overflow-hidden shrink-0">
            {([
              { key: 'all', label: 'All' },
              { key: 'portfolio', label: 'Portfolios' },
              { key: 'promissory', label: 'Notes' },
            ] as { key: 'all' | 'portfolio' | 'promissory'; label: string }[]).map((f) => (
              <button
                key={f.key}
                onClick={() => setSourceFilter(f.key)}
                className={cn('px-2 py-1 text-[10px] font-semibold transition whitespace-nowrap',
                  sourceFilter === f.key ? 'bg-primary text-primary-foreground' : 'bg-card hover:bg-muted/40')}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        {!isLoading && rows.length > 0 && (
          <div className="px-4 pb-2 flex flex-wrap items-center gap-1.5">
            <Badge variant="outline" className="text-[10px]">{filtered.length} of {rows.length} funders</Badge>
            {activatedCount > 0 && (
              <Badge className="text-[10px] text-emerald-600 bg-emerald-500/10">{activatedCount} activated</Badge>
            )}
          </div>
        )}

        <ScrollArea className="max-h-[60vh] px-4 pb-4">
          {isLoading ? (
            <div className="space-y-2">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-20 w-full" />)}</div>
          ) : filtered.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">
              {rows.length === 0 ? 'No funders in this window.' : 'No funders match your search.'}
            </p>
          ) : (
            <ul className="space-y-1.5">
              {filtered.map((f) => (
                <li key={f.funder_key} className="rounded-lg border border-border bg-card p-3">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-sm truncate flex-1">{f.name || 'Funder'}</span>
                    <Badge className={cn('text-[10px] shrink-0',
                      f.source === 'portfolio' ? 'text-blue-600 bg-blue-500/10' : 'text-amber-600 bg-amber-500/10')}>
                      {f.source === 'portfolio' ? 'Portfolio' : 'Note'}
                    </Badge>
                    {f.activated
                      ? <Badge className="text-[10px] shrink-0 text-emerald-600 bg-emerald-500/10">Active</Badge>
                      : <Badge className="text-[10px] shrink-0 text-muted-foreground bg-muted">Pending</Badge>}
                  </div>
                  <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1 text-[10px] text-muted-foreground">
                    {f.amount ? <span className="text-foreground font-semibold">{formatUGX(f.amount)} committed</span> : null}
                    {f.phone && <span className="flex items-center gap-1"><Phone className="h-3 w-3" /> {f.phone}</span>}
                    {f.reference && <span>Ref {f.reference}</span>}
                    <span>Onboarded {fmtDate(f.created_at)}</span>
                  </div>
                  {f.agent_id && (
                    <div className="flex flex-wrap items-center gap-1.5 mt-2">
                      <button
                        onClick={() => onOpenAgent(f.agent_id!)}
                        className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium border border-border text-blue-600 bg-blue-500/10 hover:ring-1 hover:ring-primary"
                      >
                        <UserPlus className="h-3 w-3" /> {f.agent_name || 'Agent'}
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}

// ===== ROI payable (next cycle) drill-down dialog =====

type ROIPeriodKey = '1d' | '7d' | 'custom' | '1m' | '1y';

interface ROIPayableLine {
  id: string;
  portfolio_code: string;
  account_name: string | null;
  investment_amount: number;
  roi_percentage: number;
  next_roi_date: string;
  roi_amount: number;
}

// Virtualised list body for the ROI payable drilldown so that thousands of
// portfolio lines can be browsed at 60fps with no pagination round-trips.
// Only the rows currently in the viewport (+overscan) are mounted in the DOM.
function VirtualisedROIList({
  rows, scheduleMap, onSchedule, onOpenDetail,
}: {
  rows: ROIPayableLine[];
  scheduleMap: Map<string, { scheduled_date: string; scheduled_by: string; reason: string | null; created_at: string }> | undefined;
  onSchedule: (r: ROIPayableLine) => void;
  onOpenDetail: (r: ROIPayableLine) => void;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const fmtDate = (d: string | null | undefined) => d ? new Date(d).toLocaleDateString() : '—';

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 96,
    overscan: 8,
  });

  return (
    <div
      ref={parentRef}
      className="px-4 pb-4 overflow-auto"
      style={{ maxHeight: '55vh', contain: 'strict' }}
    >
      <div style={{ height: virtualizer.getTotalSize(), width: '100%', position: 'relative' }}>
        {virtualizer.getVirtualItems().map((v) => {
          const r = rows[v.index];
          const sch = scheduleMap?.get(r.id);
          const isScheduled = !!sch && sch.scheduled_date === r.next_roi_date;
          return (
            <div
              key={r.id}
              ref={virtualizer.measureElement}
              data-index={v.index}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${v.start}px)`,
                paddingBottom: 6,
              }}
            >
              <div className="rounded-lg border border-border bg-card p-3">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-sm truncate flex-1">{r.account_name || 'Funder'}</span>
                  <span className="text-sm font-bold text-amber-700 tabular-nums shrink-0">{formatUGX(r.roi_amount)}</span>
                </div>
                <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1 text-[10px] text-muted-foreground">
                  <span>Portfolio {r.portfolio_code}</span>
                  <span>{r.roi_percentage}% of {formatUGX(r.investment_amount)}</span>
                  <span className="flex items-center gap-1"><CalendarDays className="h-3 w-3" /> Payout {fmtDate(r.next_roi_date)}</span>
                </div>
                <div className="mt-2 flex items-center justify-between gap-2">
                  {isScheduled ? (
                    <Badge className="text-[9.5px] h-5 px-1.5 bg-emerald-500/15 text-emerald-700 border border-emerald-500/30">
                      <Check className="h-2.5 w-2.5 mr-1" /> Scheduled for {fmtDate(sch!.scheduled_date)}
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="text-[9.5px] h-5 px-1.5 text-muted-foreground">Pending</Badge>
                  )}
                  <div className="flex items-center gap-1">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 px-2 text-[10px] gap-1"
                      onClick={() => onSchedule(r)}
                    >
                      <CalendarDays className="h-3 w-3" /> {isScheduled ? 'Reschedule' : 'Schedule'}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2 text-[10px] gap-1"
                      onClick={() => onOpenDetail(r)}
                    >
                      <FileText className="h-3 w-3" /> Details
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ROIPayableDialog({
  open, refetchIntervalMs, onClose, cardPeriod, cardCustomRange,
}: {
  open: boolean;
  refetchIntervalMs?: number | false;
  onClose: () => void;
  cardPeriod?: 'day' | 'week' | 'month' | 'custom';
  cardCustomRange?: { from?: Date; to?: Date };
}) {
  const queryClient = useQueryClient();
  const [period, setPeriod] = useState<ROIPeriodKey>('7d');
  const [customDays, setCustomDays] = useState<number>(14);
  const [sortField, setSortField] = useState<'roi_amount' | 'next_roi_date' | 'account_name' | 'roi_percentage' | 'portfolio_code'>('next_roi_date');
  const [sortAsc, setSortAsc] = useState<boolean>(true);
  const [page, setPage] = useState<number>(1);
  const [pageSize, setPageSize] = useState<number>(20);
  const [searchQuery, setSearchQuery] = useState('');
  const [funderFilter, setFunderFilter] = useState('');
  const [portfolioFilter, setPortfolioFilter] = useState('');
  const [payoutFrom, setPayoutFrom] = useState('');
  const [payoutTo, setPayoutTo] = useState('');
  const [amountMin, setAmountMin] = useState('');
  const [amountMax, setAmountMax] = useState('');
  const [scheduleTarget, setScheduleTarget] = useState<ROIPayableLine | null>(null);
  const [detailTarget, setDetailTarget] = useState<ROIPayableLine | null>(null);

  // Sync dialog window to the card's selected period on open, so the drilldown
  // lists exactly the same items the card summarised.
  useEffect(() => {
    if (!open || !cardPeriod) return;
    if (cardPeriod === 'day') { setPeriod('1d'); }
    else if (cardPeriod === 'week') { setPeriod('7d'); }
    else if (cardPeriod === 'month') { setPeriod('1m'); }
    else if (cardPeriod === 'custom') {
      const from = cardCustomRange?.from;
      const to = cardCustomRange?.to ?? from;
      if (from && to) {
        const today = new Date(); today.setHours(0, 0, 0, 0);
        const end = new Date(to); end.setHours(23, 59, 59, 999);
        const days = Math.max(1, Math.ceil((end.getTime() - today.getTime()) / (24 * 3600 * 1000)));
        setPeriod('custom');
        setCustomDays(days);
      }
    }
    setPage(1);
  }, [open, cardPeriod, cardCustomRange?.from, cardCustomRange?.to]);

  const { data, isLoading } = useQuery({
    queryKey: ['roi-payable-lines'],
    enabled: open,
    refetchInterval: open ? refetchIntervalMs : false,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('investor_portfolios')
        .select('id, portfolio_code, account_name, investment_amount, roi_percentage, next_roi_date')
        .eq('status', 'active')
        .not('next_roi_date', 'is', null)
        .order('next_roi_date', { ascending: true });
      if (error) throw error;
      return (data ?? []).map((p: any): ROIPayableLine => ({
        id: p.id,
        portfolio_code: p.portfolio_code,
        account_name: p.account_name,
        investment_amount: Number(p.investment_amount) || 0,
        roi_percentage: Number(p.roi_percentage) || 0,
        next_roi_date: p.next_roi_date,
        roi_amount: (Number(p.investment_amount) || 0) * (Number(p.roi_percentage) || 0) / 100,
      }));
    },
  });

  // Latest schedule per portfolio for the pill + persistent status.
  const { data: scheduleMap } = useQuery({
    queryKey: ['roi-payable-schedule-map'],
    enabled: open,
    refetchInterval: open ? refetchIntervalMs : false,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('roi_payout_schedules')
        .select('portfolio_id, scheduled_date, scheduled_by, reason, created_at')
        .order('created_at', { ascending: false });
      if (error) throw error;
      const map = new Map<string, { scheduled_date: string; scheduled_by: string; reason: string | null; created_at: string }>();
      (data ?? []).forEach((r: any) => {
        if (!map.has(r.portfolio_id)) map.set(r.portfolio_id, r);
      });
      return map;
    },
  });

  const periods: { key: ROIPeriodKey; label: string; days?: number }[] = [
    { key: '1d', label: 'Next 1 day', days: 1 },
    { key: '7d', label: 'Next 7 days', days: 7 },
    { key: 'custom', label: 'Custom days' },
    { key: '1m', label: 'Next month', days: 30 },
    { key: '1y', label: 'Next 1 year', days: 365 },
  ];

  const windowDays = period === 'custom'
    ? Math.max(1, Math.min(3650, Math.round(customDays || 0)))
    : (periods.find((p) => p.key === period)?.days ?? 7);

  const filtered = useMemo(() => {
    const rows = data ?? [];
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const end = new Date(start); end.setDate(end.getDate() + windowDays);
    return rows.filter((r) => {
      const d = new Date(r.next_roi_date);
      return d >= start && d <= end;
    });
  }, [data, windowDays]);

  const sorted = useMemo(() => {
    const rows = [...filtered];
    rows.sort((a, b) => {
      let cmp = 0;
      if (sortField === 'roi_amount') cmp = a.roi_amount - b.roi_amount;
      else if (sortField === 'roi_percentage') cmp = a.roi_percentage - b.roi_percentage;
      else if (sortField === 'next_roi_date') cmp = new Date(a.next_roi_date).getTime() - new Date(b.next_roi_date).getTime();
      else if (sortField === 'account_name') cmp = (a.account_name || '').localeCompare(b.account_name || '');
      else if (sortField === 'portfolio_code') cmp = (a.portfolio_code || '').localeCompare(b.portfolio_code || '');
      return sortAsc ? cmp : -cmp;
    });
    return rows;
  }, [filtered, sortField, sortAsc]);

  const searched = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const funder = funderFilter.trim().toLowerCase();
    const portfolio = portfolioFilter.trim().toLowerCase();
    const from = payoutFrom ? new Date(payoutFrom + 'T00:00:00') : null;
    const to = payoutTo ? new Date(payoutTo + 'T23:59:59') : null;
    const min = amountMin.trim() === '' ? null : Number(amountMin);
    const max = amountMax.trim() === '' ? null : Number(amountMax);
    return sorted.filter((r) => {
      if (q && !(
        (r.account_name?.toLowerCase().includes(q) ?? false) ||
        (r.portfolio_code?.toLowerCase().includes(q) ?? false)
      )) return false;
      if (funder && !(r.account_name?.toLowerCase().includes(funder) ?? false)) return false;
      if (portfolio && !(r.portfolio_code?.toLowerCase().includes(portfolio) ?? false)) return false;
      if (from || to) {
        const d = new Date(r.next_roi_date);
        if (from && d < from) return false;
        if (to && d > to) return false;
      }
      if (min !== null && !Number.isNaN(min) && r.roi_amount < min) return false;
      if (max !== null && !Number.isNaN(max) && r.roi_amount > max) return false;
      return true;
    });
  }, [sorted, searchQuery, funderFilter, portfolioFilter, payoutFrom, payoutTo, amountMin, amountMax]);

  const hasActiveFilters = !!(funderFilter || portfolioFilter || payoutFrom || payoutTo || amountMin || amountMax);
  const clearFilters = () => {
    setFunderFilter(''); setPortfolioFilter('');
    setPayoutFrom(''); setPayoutTo('');
    setAmountMin(''); setAmountMax('');
    setPage(1);
  };

  const total = filtered.reduce((s, r) => s + r.roi_amount, 0);
  const totalPages = Math.max(1, Math.ceil(searched.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const paginated = searched.slice((safePage - 1) * pageSize, safePage * pageSize);

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-2xl p-0 gap-0">
        <DialogHeader className="p-4 pb-2">
          <DialogTitle className="text-base flex items-center gap-2">
            <Handshake className="h-4 w-4 text-amber-600" /> ROI payable — next cycle
          </DialogTitle>
          <p className="text-[11px] text-muted-foreground">
            Returns due to funders by payout date. Pick a window to see each portfolio line, its amount and earliest payout date.
          </p>
        </DialogHeader>

        <div className="px-4 pb-2 flex items-center gap-2 flex-wrap">
          <div className="flex rounded-lg border border-border overflow-hidden flex-wrap">
            {periods.map((p) => (
              <button
                key={p.key}
                onClick={() => { setPeriod(p.key); setPage(1); }}
                className={cn('px-2.5 py-1 text-[10px] font-semibold transition whitespace-nowrap',
                  period === p.key ? 'bg-primary text-primary-foreground' : 'bg-card hover:bg-muted/40')}
              >
                {p.label}
              </button>
            ))}
          </div>
          {period === 'custom' && (
            <div className="flex items-center gap-1.5">
              <Input
                type="number"
                min={1}
                max={3650}
                value={customDays}
                onChange={(e) => setCustomDays(Number(e.target.value))}
                className="h-8 w-20 text-xs"
              />
              <span className="text-[11px] text-muted-foreground">days</span>
            </div>
          )}
        </div>

        <div className="px-4 pb-2 flex flex-wrap items-center gap-1.5">
          <Badge variant="outline" className="text-[10px]">{filtered.length} portfolio{filtered.length !== 1 ? 's' : ''} due · next {windowDays} day{windowDays !== 1 ? 's' : ''}</Badge>
          <Badge className="text-[10px] text-amber-700 bg-amber-500/10">{formatUGX(total)} payable</Badge>
          <div className="ml-auto flex items-center gap-1.5">
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2 text-[11px]"
              disabled={searched.length === 0}
              onClick={() => exportRoiPayableCsv(searched, windowDays, total)}
            >
              <Download className="h-3 w-3 mr-1" /> CSV
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2 text-[11px]"
              disabled={searched.length === 0}
              onClick={() => exportRoiPayablePdf(searched, windowDays, total)}
            >
              <Download className="h-3 w-3 mr-1" /> PDF
            </Button>
          </div>
        </div>

        {/* Search + Sort + page-size bar */}
        <div className="px-4 pb-2 flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 min-w-0 max-w-[220px]">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            <Input
              value={searchQuery}
              onChange={(e) => { setSearchQuery(e.target.value); setPage(1); }}
              placeholder="Search funder or portfolio…"
              className="pl-7 h-7 text-xs"
            />
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-muted-foreground font-medium">Sort by</span>
            <Select
              value={sortField}
              onValueChange={(v) => { setSortField(v as typeof sortField); setPage(1); }}
            >
              <SelectTrigger className="h-7 text-[11px] w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="next_roi_date" className="text-[11px]">Payout date</SelectItem>
                <SelectItem value="roi_amount" className="text-[11px]">ROI amount</SelectItem>
                <SelectItem value="account_name" className="text-[11px]">Funder name</SelectItem>
                <SelectItem value="portfolio_code" className="text-[11px]">Portfolio code</SelectItem>
                <SelectItem value="roi_percentage" className="text-[11px]">ROI %</SelectItem>
              </SelectContent>
            </Select>
            <button
              type="button"
              onClick={() => setSortAsc((v) => !v)}
              className="h-7 w-7 rounded-md border border-border flex items-center justify-center hover:bg-muted/40 transition"
              title={sortAsc ? 'Ascending' : 'Descending'}
            >
              {sortAsc ? (
                <ArrowUpDown className="h-3.5 w-3.5 text-muted-foreground" />
              ) : (
                <ArrowUpDown className="h-3.5 w-3.5 text-primary rotate-180" />
              )}
            </button>
          </div>
          <div className="flex items-center gap-1.5 ml-auto text-[10px] text-muted-foreground font-medium">
            <Zap className="h-3 w-3 text-primary" />
            Virtualised · {searched.length.toLocaleString()} rows
          </div>
        </div>

        {/* Quick filters: funder, portfolio, payout date range, amount range */}
        <div className="px-4 pb-2">
          <div className="rounded-lg border border-border bg-muted/20 p-2 space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Quick filters</span>
              {hasActiveFilters && (
                <button
                  type="button"
                  onClick={clearFilters}
                  className="text-[10px] text-primary hover:underline font-medium"
                >
                  Clear all
                </button>
              )}
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-1.5">
              <Input
                value={funderFilter}
                onChange={(e) => { setFunderFilter(e.target.value); setPage(1); }}
                placeholder="Funder name"
                className="h-7 text-[11px]"
              />
              <Input
                value={portfolioFilter}
                onChange={(e) => { setPortfolioFilter(e.target.value); setPage(1); }}
                placeholder="Portfolio code"
                className="h-7 text-[11px]"
              />
              <div className="flex items-center gap-1 col-span-2 md:col-span-1">
                <Input
                  type="date"
                  value={payoutFrom}
                  onChange={(e) => { setPayoutFrom(e.target.value); setPage(1); }}
                  className="h-7 text-[11px] px-1.5"
                  title="Payout from"
                />
                <span className="text-[10px] text-muted-foreground">→</span>
                <Input
                  type="date"
                  value={payoutTo}
                  onChange={(e) => { setPayoutTo(e.target.value); setPage(1); }}
                  className="h-7 text-[11px] px-1.5"
                  title="Payout to"
                />
              </div>
              <div className="flex items-center gap-1 col-span-2 md:col-span-1">
                <Input
                  type="number"
                  inputMode="numeric"
                  value={amountMin}
                  onChange={(e) => { setAmountMin(e.target.value); setPage(1); }}
                  placeholder="Min UGX"
                  className="h-7 text-[11px] px-1.5"
                />
                <span className="text-[10px] text-muted-foreground">→</span>
                <Input
                  type="number"
                  inputMode="numeric"
                  value={amountMax}
                  onChange={(e) => { setAmountMax(e.target.value); setPage(1); }}
                  placeholder="Max UGX"
                  className="h-7 text-[11px] px-1.5"
                />
              </div>
            </div>
          </div>
        </div>

        {isLoading ? (
          <div className="px-4 pb-4 space-y-2">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-16 w-full" />)}</div>
        ) : searched.length === 0 ? (
          <p className="px-4 pb-6 text-sm text-muted-foreground text-center py-6">
            No ROI payable in the next {windowDays} day{windowDays !== 1 ? 's' : ''}.
          </p>
        ) : (
          <VirtualisedROIList
            rows={searched}
            scheduleMap={scheduleMap}
            onSchedule={setScheduleTarget}
            onOpenDetail={setDetailTarget}
          />
        )}

        {searched.length > 0 && (
          <div className="px-4 pb-3 pt-1 border-t border-border text-[10px] text-muted-foreground flex items-center justify-between">
            <span>{searched.length.toLocaleString()} rows · scroll to browse</span>
            <span className="tabular-nums">Total: {formatUGX(total)}</span>
          </div>
        )}
      </DialogContent>
      <ScheduleRoiConfirmDialog
        line={scheduleTarget}
        onClose={() => setScheduleTarget(null)}
        onScheduled={() => {
          setScheduleTarget(null);
          queryClient.invalidateQueries({ queryKey: ['roi-payable-lines'] });
          queryClient.invalidateQueries({ queryKey: ['roi-payable-schedule-map'] });
          queryClient.invalidateQueries({ queryKey: ['mission-roi-payable-next'] });
          queryClient.invalidateQueries({ queryKey: ['mission-roi-schedule-map'] });
        }}
      />
      <ROIDetailDialog
        line={detailTarget}
        onClose={() => setDetailTarget(null)}
        onSchedule={(l) => { setDetailTarget(null); setScheduleTarget(l); }}
      />
    </Dialog>
  );
}

function ScheduleRoiConfirmDialog({
  line, onClose, onScheduled,
}: {
  line: ROIPayableLine | null;
  onClose: () => void;
  onScheduled: () => void;
}) {
  const [date, setDate] = useState<Date | undefined>(undefined);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (line) {
      setDate(line.next_roi_date ? new Date(line.next_roi_date) : undefined);
      setReason('');
    }
  }, [line?.id]);

  const submit = async () => {
    if (!line || !date) return;
    const iso = format(date, 'yyyy-MM-dd');
    setBusy(true);
    try {
      const { data, error } = await supabase.rpc('schedule_roi_payout', {
        p_portfolio_id: line.id,
        p_new_date: iso,
        p_reason: reason.trim() || null,
      });
      if (error) throw error;
      const res = data as any;
      if (res && res.ok === false) throw new Error(res.error || 'Failed to schedule');
      toast.success(`Scheduled payout for ${line.account_name || 'funder'} on ${format(date, 'MMM d, yyyy')}`);
      onScheduled();
    } catch (e: any) {
      toast.error(e?.message || 'Failed to schedule ROI payout');
    } finally {
      setBusy(false);
    }
  };

  const today = new Date(); today.setHours(0, 0, 0, 0);

  return (
    <Dialog open={!!line} onOpenChange={(v) => { if (!v && !busy) onClose(); }}>
      <DialogContent className="max-w-md p-0 gap-0">
        <DialogHeader className="p-4 pb-2">
          <DialogTitle className="text-base flex items-center gap-2">
            <CalendarDays className="h-4 w-4 text-emerald-600" /> Schedule ROI payout
          </DialogTitle>
          <p className="text-[11px] text-muted-foreground">
            Move the next ROI payout date for this portfolio. The change is recorded with your name and reason for audit.
          </p>
        </DialogHeader>
        {line && (
          <div className="px-4 pb-2 space-y-3">
            <div className="rounded-lg border border-border bg-muted/30 p-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold truncate">{line.account_name || 'Funder'}</span>
                <span className="text-xs font-bold text-amber-700 tabular-nums">{formatUGX(line.roi_amount)}</span>
              </div>
              <div className="mt-1 text-[10px] text-muted-foreground flex flex-wrap gap-x-3">
                <span>Portfolio {line.portfolio_code}</span>
                <span>Current payout: {fmtDate(line.next_roi_date)}</span>
              </div>
            </div>

            <div>
              <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">New payout date</label>
              <div className="mt-1.5 rounded-lg border border-border">
                <Calendar
                  mode="single"
                  selected={date}
                  onSelect={setDate}
                  disabled={(d) => d < today}
                  initialFocus
                  className={cn('p-3 pointer-events-auto')}
                />
              </div>
            </div>

            <div>
              <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Reason (optional)</label>
              <Input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. funder requested delay; treasury pacing"
                className="mt-1.5 h-8 text-xs"
                maxLength={200}
              />
            </div>
          </div>
        )}
        <div className="p-4 pt-2 flex items-center justify-end gap-2 border-t border-border">
          <Button variant="outline" size="sm" className="h-8 text-xs" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            size="sm"
            className="h-8 text-xs gap-1"
            onClick={submit}
            disabled={busy || !date}
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
            Confirm schedule
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ===== Per-landlord recorded receivables dialog =====

function LandlordReceivablesDialog({
  open, onClose, onOpenLandlord,
}: {
  open: boolean;
  onClose: () => void;
  onOpenLandlord: (id: string) => void;
}) {
  const [search, setSearch] = useState('');
  const [range, setRange] = useState<DateRange | undefined>(undefined);
  const fromISO = range?.from ? range.from.toISOString() : null;
  // exclusive upper bound: include the whole selected end day
  const toISO = range?.to
    ? new Date(range.to.getFullYear(), range.to.getMonth(), range.to.getDate() + 1).toISOString()
    : (range?.from
        ? new Date(range.from.getFullYear(), range.from.getMonth(), range.from.getDate() + 1).toISOString()
        : null);
  const { data, isLoading } = useMissionLandlordReceivables(open, fromISO, toISO);
  const rows: MissionLandlordReceivable[] = data ?? [];

  const searchLower = search.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!searchLower) return rows;
    return rows.filter((r) =>
      (r.landlord_name?.toLowerCase().includes(searchLower) ?? false) ||
      (r.landlord_phone?.toLowerCase().includes(searchLower) ?? false) ||
      (r.property_address?.toLowerCase().includes(searchLower) ?? false));
  }, [rows, searchLower]);

  const grandTotal = useMemo(() => rows.reduce((s, r) => s + Number(r.receivable_total || 0), 0), [rows]);
  const totalPlacements = useMemo(() => rows.reduce((s, r) => s + Number(r.placement_count || 0), 0), [rows]);

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-2xl p-0 gap-0">
        <DialogHeader className="p-4 pb-2">
          <DialogTitle className="text-base flex items-center gap-2">
            <Building2 className="h-4 w-4 text-emerald-600" /> Recorded receivables by landlord
          </DialogTitle>
          <p className="text-[11px] text-muted-foreground">
            Recorded A/C receivables per landlord from placed tenants. Tap a landlord to open their profile.
          </p>
        </DialogHeader>

        <div className="px-4 pb-2 flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 min-w-0">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search landlord, phone, address…"
              className="pl-7 h-8 text-xs"
            />
          </div>
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className={cn('h-8 gap-1.5 text-[11px] shrink-0', !range?.from && 'text-muted-foreground')}
              >
                <CalendarDays className="h-3.5 w-3.5" />
                {range?.from
                  ? (range.to
                      ? `${format(range.from, 'd MMM')} – ${format(range.to, 'd MMM')}`
                      : format(range.from, 'd MMM yyyy'))
                  : 'Date range'}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="end">
              <Calendar
                mode="range"
                selected={range}
                onSelect={setRange}
                numberOfMonths={2}
                initialFocus
                className={cn('p-3 pointer-events-auto')}
              />
              {range?.from && (
                <div className="border-t p-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 w-full text-[11px] gap-1"
                    onClick={() => setRange(undefined)}
                  >
                    <X className="h-3.5 w-3.5" /> Clear date range
                  </Button>
                </div>
              )}
            </PopoverContent>
          </Popover>
          <div className="rounded-lg bg-emerald-500/10 px-2 py-1 text-right shrink-0">
            <p className="text-[9px] font-bold uppercase tracking-wide text-emerald-700 leading-none">Total</p>
            <p className="text-xs font-bold text-emerald-700 tabular-nums leading-tight">{formatUGX(grandTotal)}</p>
            <p className="text-[9px] text-muted-foreground leading-none">{rows.length.toLocaleString()} landlords · {totalPlacements.toLocaleString()} placements</p>
          </div>
        </div>

        <ScrollArea className="max-h-[60vh] px-4 pb-4">
          {isLoading ? (
            <div className="space-y-2 py-2">
              {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : filtered.length === 0 ? (
            <p className="text-center text-xs text-muted-foreground py-8">No recorded receivables found.</p>
          ) : (
            <ul className="space-y-1.5 py-1">
              {filtered.map((r) => (
                <li key={r.landlord_id}>
                  <button
                    type="button"
                    onClick={() => onOpenLandlord(r.landlord_id)}
                    className="flex w-full items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-left transition hover:bg-muted/40"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold truncate">{r.landlord_name || 'Unnamed landlord'}</p>
                      <p className="text-[11px] text-muted-foreground truncate flex items-center gap-1">
                        {r.landlord_phone && <><Phone className="h-3 w-3" /> {r.landlord_phone}</>}
                        {r.property_address && <span className="truncate">· {r.property_address}</span>}
                      </p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-sm font-bold text-emerald-700 tabular-nums leading-tight">{formatUGX(Number(r.receivable_total || 0))}</p>
                      <p className="text-[10px] text-muted-foreground leading-none">{Number(r.placement_count || 0).toLocaleString()} placement{Number(r.placement_count) === 1 ? '' : 's'}</p>
                    </div>
                    <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
