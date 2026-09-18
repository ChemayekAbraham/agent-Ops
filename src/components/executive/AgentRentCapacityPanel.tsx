import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';
import { Search, Gauge, TrendingUp, AlertTriangle, ShieldCheck, Printer, Loader2, ChevronDown, ChevronUp, Minus, Plus, CheckCircle2, XCircle, Sparkles } from 'lucide-react';
import { Input } from '@/components/ui/input';
import {
  ACTIVE_RENT_STATUSES,
  AGENT_RENT_CAP_UGX,
  classifyAgent,
  classifyDailyRating,
  DAILY_ELIGIBILITY_THRESHOLD,
  type AgentCapacity,
} from '@/hooks/useAgentCapacityMap';
import { toast } from 'sonner';
import {
  fetchAgentCapacityTenants,
  generateAgentCapacityPdf,
  downloadCapacityPdf,
} from '@/lib/generateAgentCapacityPdf';
import { DailyRatingThresholdPopover } from '@/components/shared/DailyRatingThresholdPopover';
import { AgentEligibilityHistoryStrip } from './AgentEligibilityHistoryStrip';
import { FleetPerformanceStats } from './FleetPerformanceStats';
import { useQualifyingAgentIds } from '@/hooks/useQualifyingAgentIds';
import { LastUpdatedChip } from './LastUpdatedChip';

type AgentRow = {
  agent_id: string;
  name: string;
  phone: string | null;
  used: number;
  active_count: number;
  active_tenant_count: number;
  paying_tenants_last_week: number;
  unfunded_tenant_count: number;
  response_rate: number;          // 0..1 — last 7 days DRR
  responding_tenant_days: number;
  expected_tenant_days: number;
  paid_last_week: number;
  paid_today: number;
  paid_yesterday: number;
  expected_daily: number;
  tier: AgentCapacity['tier'];
  per_tenant_max: number;
  daily_rating: AgentCapacity['daily_rating'];
  daily_status: AgentCapacity['daily_status'];
};

export function AgentRentCapacityPanel({
  defaultLimit = 25,
  compact = false,
  mode = 'full',
}: {
  defaultLimit?: number;
  compact?: boolean;
  /**
   * 'full'    — stats header + searchable agent list (default)
   * 'summary' — stats header only (used on the dashboard overview)
   */
  mode?: 'full' | 'summary';
}) {
  const [search, setSearch] = useState('');
  const LOAD_STEP = 15;
  const [visibleCount, setVisibleCount] = useState(LOAD_STEP);
  const SECTION_COLLAPSE_KEY = 'agent-rent-capacity-collapsed';
  const [isSectionCollapsed, setIsSectionCollapsed] = useState(() => {
    try {
      return window.localStorage.getItem(SECTION_COLLAPSE_KEY) === 'true';
    } catch {
      return false;
    }
  });
  const showList = mode !== 'summary';
  const { agentIds: qualifyingIds, isReady: qualifyingReady } = useQualifyingAgentIds();
  // Default every row to collapsed on load so the operator sees a clean
  // ALLOWED / BLOCKED status card and can tap to drill in.
  // Global collapsed state is the source of truth for rows the user hasn't
  // explicitly toggled. This keeps the "Collapse All / Expand All" button in
  // sync with the actual rendered state, including rows loaded via "Load more".
  const [globalCollapsed, setGlobalCollapsed] = useState<boolean>(true);
  const [rowOverrides, setRowOverrides] = useState<Record<string, boolean>>({});
  const queryClient = useQueryClient();

  const isRowCollapsed = (agentId: string) => rowOverrides[agentId] ?? globalCollapsed;

  // Force a fresh fetch every time the panel mounts (e.g. user switches to
  // the Agent Rent Capacity tab). Without this, a cached fleet snapshot
  // from a previous mount could briefly render stale yesterday-based
  // ratings before the background refetch lands.
  useEffect(() => {
    queryClient.invalidateQueries({ queryKey: ['agent-rent-capacity-fleet'] });
    queryClient.invalidateQueries({ queryKey: ['agent-capacity-map'] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-refresh the fleet rating table whenever ANY rent_request changes
  // (amount_repaid bump on a repayment trigger, status flip, or a fresh
  // funded request). This catches every write path — agent collect dialog,
  // submit-offline-collection edge fn, auto-charge cron — without needing
  // per-mutation invalidation hooks.
  useEffect(() => {
    const channel = supabase
      .channel('agent-rent-capacity-fleet-watch')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'rent_requests' },
        () => {
          queryClient.invalidateQueries({ queryKey: ['agent-rent-capacity-fleet'] });
          queryClient.invalidateQueries({ queryKey: ['agent-capacity-map'] });
        },
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [queryClient]);

  const toggleRow = (agentId: string) =>
    setRowOverrides((prev) => {
      const current = isRowCollapsed(agentId);
      return { ...prev, [agentId]: !current };
    });

  const toggleSectionCollapsed = () => {
    setIsSectionCollapsed((v) => {
      const next = !v;
      try {
        window.localStorage.setItem(SECTION_COLLAPSE_KEY, String(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  const { data, isLoading, dataUpdatedAt, isFetching, refetch } = useQuery({
    queryKey: ['agent-rent-capacity-fleet'],
    // Always pull a fresh slice when the panel mounts or regains focus so
    // ratings reflect collections that happened seconds ago.
    staleTime: 15_000,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
    queryFn: async (): Promise<AgentRow[]> => {
      // 1) Pull all active rent requests (drives exposure + expected daily collections)
      const { data: active } = await supabase
        .from('rent_requests')
        .select('id, agent_id, tenant_id, total_repayment, amount_repaid, daily_repayment, status, repayment_frequency')
        .in('status', ACTIVE_RENT_STATUSES)
        .not('agent_id', 'is', null);

      // Drop rent_requests the agent has fully "Marked not funded"
      // (reversal exists AND no remaining net repayment) so those tenants
      // don't count toward the agent's expected response denominator.
      const allActiveIds = (active || []).map((r: any) => r.id);
      const unfundedIds = new Set<string>();
      const unfundedTenantsByAgent = new Map<string, Set<string>>();
      const fallbackBlockedByUnpaidLandlordIds = new Set<string>();
      if (allActiveIds.length > 0) {
        const BATCH_REV = 200;
        for (let i = 0; i < allActiveIds.length; i += BATCH_REV) {
          const slice = allActiveIds.slice(i, i + BATCH_REV);
          const { data: revs } = await supabase
            .from('agent_tenant_float_reversals')
            .select('rent_request_id')
            .in('rent_request_id', slice);
          const reversedSet = new Set((revs || []).map((r: any) => r.rent_request_id));
          (active || [])
            .filter((r: any) => slice.includes(r.id))
            .forEach((r: any) => {
              if (reversedSet.has(r.id) && (Number(r.amount_repaid) || 0) <= 0) {
                unfundedIds.add(r.id);
                let s = unfundedTenantsByAgent.get(r.agent_id);
                if (!s) { s = new Set(); unfundedTenantsByAgent.set(r.agent_id, s); }
                if (r.tenant_id) s.add(r.tenant_id);
              }
            });
        }

        const BATCH_ALLOC = 200;
        const blockedStatuses = new Set(['open', 'partially_paid', 'return_pending']);
        for (let i = 0; i < allActiveIds.length; i += BATCH_ALLOC) {
          const slice = allActiveIds.slice(i, i + BATCH_ALLOC);
          const { data: allocs } = await supabase
            .from('agent_landlord_float_allocations')
            .select('rent_request_id, status, paid_out_amount')
            .in('rent_request_id', slice);
          (allocs || []).forEach((a: any) => {
            const paidOut = Number(a.paid_out_amount) || 0;
            if (blockedStatuses.has(String(a.status || '')) && paidOut <= 0) {
              fallbackBlockedByUnpaidLandlordIds.add(a.rent_request_id);
            }
          });
        }
      }

      const exposureMap = new Map<string, { used: number; count: number }>();
      const expectedDailyMap = new Map<string, number>();
      const activeIdToAgent = new Map<string, string>();
      const activeIdToTenant = new Map<string, string>();
      const activeTenantsByAgent = new Map<string, Set<string>>();
      (active || []).forEach((r: any) => {
        if (!r.agent_id) return;
        if (unfundedIds.has(r.id)) return; // marked not funded → excluded
        const owed = Math.max(
          (Number(r.total_repayment) || 0) - (Number(r.amount_repaid) || 0),
          0,
        );
        const prev = exposureMap.get(r.agent_id) || { used: 0, count: 0 };
        exposureMap.set(r.agent_id, { used: prev.used + owed, count: prev.count + 1 });
        const isWeekly = String(r.repayment_frequency || 'daily').toLowerCase() === 'weekly';
        const fundedAndOwing =
          (r.status === 'funded' || r.status === 'repaying') &&
          owed > 0 &&
          !isWeekly &&
          !fallbackBlockedByUnpaidLandlordIds.has(r.id);
        if (fundedAndOwing) {
          expectedDailyMap.set(
            r.agent_id,
            (expectedDailyMap.get(r.agent_id) || 0) + (Number(r.daily_repayment) || 0),
          );
        }
        activeIdToAgent.set(r.id, r.agent_id);
        if (r.tenant_id) {
          activeIdToTenant.set(r.id, r.tenant_id);
          let s = activeTenantsByAgent.get(r.agent_id);
          if (!s) { s = new Set(); activeTenantsByAgent.set(r.agent_id, s); }
          s.add(r.tenant_id);
        }
      });

      // 2) Daily Response Rate — count distinct (rent × day) cells in the
      //    last 7 days where the tenant paid at least UGX 1. Also keep
      //    the UGX total as a secondary stat.
      //    NOTE: today/yesterday day-sums are NO LONGER computed here —
      //    they come from the server-side eligibility view (Kampala TZ,
      //    sourced from agent_collections). See useAgentCapacityMap.ts.
      const weekAgoISO = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const paidByAgent = new Map<string, number>();
      const respondingDaysByAgent = new Map<string, number>();
      const payingTenantsByAgent = new Map<string, Set<string>>();
      const activeIds = Array.from(activeIdToAgent.keys());
      const BATCH_PAY = 200;
      for (let i = 0; i < activeIds.length; i += BATCH_PAY) {
        const slice = activeIds.slice(i, i + BATCH_PAY);
        const { data: pays } = await supabase
          .from('repayments')
          .select('rent_request_id, amount, created_at, tenant_id')
          .in('rent_request_id', slice)
          .gte('created_at', weekAgoISO);
        const dayKeyByRent = new Map<string, Set<string>>();
        (pays || []).forEach((p: any) => {
          const amt = Number(p.amount) || 0;
          const agentId = activeIdToAgent.get(p.rent_request_id);
          if (!agentId) return;
          paidByAgent.set(agentId, (paidByAgent.get(agentId) || 0) + amt);
          if (amt <= 0) return;
          const tenantId = p.tenant_id || activeIdToTenant.get(p.rent_request_id);
          if (tenantId) {
            let pt = payingTenantsByAgent.get(agentId);
            if (!pt) { pt = new Set(); payingTenantsByAgent.set(agentId, pt); }
            pt.add(tenantId);
          }
          const day = (p.created_at as string).slice(0, 10);
          let set = dayKeyByRent.get(p.rent_request_id);
          if (!set) { set = new Set(); dayKeyByRent.set(p.rent_request_id, set); }
          set.add(day);
        });
        dayKeyByRent.forEach((daySet, rentId) => {
          const agentId = activeIdToAgent.get(rentId);
          if (!agentId) return;
          respondingDaysByAgent.set(
            agentId,
            (respondingDaysByAgent.get(agentId) || 0) + daySet.size,
          );
        });
      }

      const agentIds = Array.from(exposureMap.keys());
      if (agentIds.length === 0) return [];

      // 2b) Server-side Daily Eligibility (Kampala TZ, agent_collections).
      const eligByAgent = new Map<string, {
        active_count: number; expected_daily: number;
        paid_today: number; paid_yesterday: number;
        today_pct: number; yesterday_pct: number; effective_pct: number;
      }>();
      {
        const { data: eligRows, error: eligErr } = await supabase.rpc(
          'get_agent_daily_eligibility',
          { p_agent_ids: agentIds },
        );
        const eligibilityRpcSucceeded = !eligErr;
        if (eligErr) console.error('[AgentRentCapacityPanel] eligibility RPC failed', eligErr);
        (eligRows || []).forEach((r: any) => {
          eligByAgent.set(r.agent_id, {
            active_count:   Number(r.active_count)   || 0,
            expected_daily: Number(r.expected_daily) || 0,
            paid_today:     Number(r.paid_today)     || 0,
            paid_yesterday: Number(r.paid_yesterday) || 0,
            today_pct:      Number(r.today_pct)      || 0,
            yesterday_pct:  Number(r.yesterday_pct)  || 0,
            effective_pct:  Number(r.effective_pct)  || 0,
          });
        });
      }

      // 3) Batch fetch profiles
      const profileMap = new Map<string, { name: string; phone: string | null }>();
      const BATCH = 50;
      for (let i = 0; i < agentIds.length; i += BATCH) {
        const { data: profs } = await supabase
          .from('profiles')
          .select('id, full_name, phone')
          .in('id', agentIds.slice(i, i + BATCH));
        (profs || []).forEach((p: any) => {
          profileMap.set(p.id, { name: p.full_name || 'Unknown', phone: p.phone });
        });
      }

      const rows: AgentRow[] = agentIds.map((id) => {
        const exp = exposureMap.get(id) || { used: 0, count: 0 };
        const paid_last_week = paidByAgent.get(id) || 0;
        const expected_tenant_days = exp.count * 7;
        const responding_tenant_days = Math.min(
          respondingDaysByAgent.get(id) || 0,
          expected_tenant_days,
        );
        const response_rate =
          expected_tenant_days > 0
            ? Math.min(1, responding_tenant_days / expected_tenant_days)
            : 0;
        const { tier, per_tenant_max } = classifyAgent(exp.count, response_rate);
        const prof = profileMap.get(id) || { name: id.slice(0, 8), phone: null };
        const elig = eligByAgent.get(id);
        const expected_daily = eligibilityRpcSucceeded
          ? (elig?.expected_daily ?? 0)
          : (expectedDailyMap.get(id) || 0);
        const paid_today_val        = elig?.paid_today     ?? 0;
        const paid_yesterday        = elig?.paid_yesterday ?? 0;
        const today_response_pct    = elig?.today_pct      ?? 0;
        const yesterday_response_pct= elig?.yesterday_pct  ?? 0;
        const effective_daily_pct   = elig?.effective_pct  ?? 0;
        const daily_rating = classifyDailyRating(exp.count, effective_daily_pct);
        const daily_status: AgentCapacity['daily_status'] =
          exp.count <= 0 ? 'starter' : effective_daily_pct >= DAILY_ELIGIBILITY_THRESHOLD ? 'good' : 'blocked';
        return {
          agent_id: id,
          name: prof.name,
          phone: prof.phone,
          used: exp.used,
          active_count: exp.count,
          active_tenant_count: activeTenantsByAgent.get(id)?.size || 0,
          paying_tenants_last_week: payingTenantsByAgent.get(id)?.size || 0,
          unfunded_tenant_count: unfundedTenantsByAgent.get(id)?.size || 0,
          response_rate,
          responding_tenant_days,
          expected_tenant_days,
          paid_last_week,
          paid_today: paid_today_val,
          paid_yesterday,
          expected_daily,
          tier,
          per_tenant_max,
          daily_rating,
          daily_status,
        };
      });

      rows.sort((a, b) => b.used - a.used);
      return rows;
    },
  });

  // Only surface qualifying agents (behaviour-based agent definition) so the
  // capacity list matches "who is an agent" everywhere in the dashboard.
  const rows = useMemo(() => {
    if (!qualifyingReady) return data || [];
    return (data || []).filter((r) => qualifyingIds.has(r.agent_id));
  }, [data, qualifyingIds, qualifyingReady]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return rows;
    return rows.filter(
      (r) =>
        r.name.toLowerCase().includes(term) ||
        (r.phone || '').toLowerCase().includes(term),
    );
  }, [rows, search]);

  // Reset the pagination window whenever the search term changes so the
  // first 15 matches are always what the operator sees.
  useEffect(() => { setVisibleCount(LOAD_STEP); }, [search]);

  const visible = filtered.slice(0, visibleCount);

  // Aggregate KPIs
  const totalUsed = rows.reduce((s, r) => s + r.used, 0);
  const totalCap = rows.length * AGENT_RENT_CAP_UGX;
  const totalHeadroom = Math.max(totalCap - totalUsed, 0);
  // "Active agents" is collection-based: agents who actually collected money
  // today (paid_today > 0 from agent_collections via the eligibility view).
  const activeAgents = rows.filter((r) => r.paid_today > 0).length;
  // Posting eligibility mirrors the exact gate used by the rent-request flow:
  // daily_status 'blocked' cannot post; 'good'/'starter' can.
  const canPostCount = rows.filter((r) => r.daily_status !== 'blocked').length;
  const blockedCount = rows.filter((r) => r.daily_status === 'blocked').length;

  const allVisibleCollapsed = visible.every((r) => isRowCollapsed(r.agent_id));

  const toggleAll = () => {
    const nextGlobal = !allVisibleCollapsed;
    setGlobalCollapsed(nextGlobal);
    // Clear per-row overrides so every row follows the new global state.
    setRowOverrides({});
  };

  return (
    <div className="rounded-2xl border border-border bg-card overflow-hidden">
      <div className="p-3 sm:p-4 bg-gradient-to-br from-primary/10 via-violet-500/5 to-transparent border-b border-border">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="h-8 w-8 rounded-xl bg-primary/15 flex items-center justify-center">
            <Gauge className="h-4 w-4 text-primary" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-sm sm:text-base font-bold text-foreground leading-tight">
              Agent Rent-Request Capacity
            </h3>
            <p className="text-[11px] text-muted-foreground">
              Tier = last 7 days' <strong>tenant response rate</strong> (any payment = a daily response) · Hard cap UGX{' '}
              {formatUGX(AGENT_RENT_CAP_UGX)} per agent
            </p>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <LastUpdatedChip
                updatedAt={dataUpdatedAt}
                isFetching={isFetching}
                onRefresh={() => refetch()}
              />
            </div>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <DailyRatingThresholdPopover />
            <button
              type="button"
              onClick={toggleSectionCollapsed}
              className="inline-flex items-center justify-center h-8 w-8 rounded-lg border border-border bg-background hover:bg-muted transition-colors"
              aria-label={isSectionCollapsed ? 'Expand section' : 'Collapse section'}
              title={isSectionCollapsed ? 'Expand' : 'Collapse'}
            >
              {isSectionCollapsed ? (
                <ChevronDown className="h-4 w-4 text-muted-foreground" />
              ) : (
                <ChevronUp className="h-4 w-4 text-muted-foreground" />
              )}
            </button>
          </div>
        </div>

        {!compact && !isSectionCollapsed && (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-1.5 sm:gap-2 mt-3">
            <Kpi
              icon={<TrendingUp className="h-3.5 w-3.5" />}
              label="Fleet Exposure"
              value={formatUGX(totalUsed)}
              tone="text-primary"
            />
            <Kpi
              icon={<ShieldCheck className="h-3.5 w-3.5" />}
              label="Total Headroom"
              value={formatUGX(totalHeadroom)}
              tone="text-emerald-600"
            />
            <Kpi
              icon={<Gauge className="h-3.5 w-3.5" />}
              label="Active Agents (collected today)"
              value={activeAgents.toLocaleString()}
              tone="text-violet-600"
            />
            <Kpi
              icon={<CheckCircle2 className="h-3.5 w-3.5" />}
              label="Can post rent today"
              value={canPostCount.toLocaleString()}
              tone="text-emerald-600"
            />
            <Kpi
              icon={<XCircle className="h-3.5 w-3.5" />}
              label="Blocked from posting"
              value={blockedCount.toLocaleString()}
              tone={blockedCount > 0 ? 'text-destructive' : 'text-muted-foreground'}
            />
          </div>
        )}

        {!compact && !isSectionCollapsed && <FleetPerformanceStats detailed={showList} />}
      </div>

      {showList && (
      <div className="p-3 sm:p-4 space-y-3">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search agent name or phone…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9 h-9"
            />
          </div>
          {visible.length > 0 && (
            <button
              type="button"
              onClick={toggleAll}
              className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg border border-border bg-background hover:bg-muted text-xs font-semibold shrink-0"
              title={allVisibleCollapsed ? 'Expand all agent cards' : 'Collapse all agent cards'}
              aria-label={allVisibleCollapsed ? 'Expand all' : 'Collapse all'}
            >
              {allVisibleCollapsed ? <Plus className="h-3.5 w-3.5" /> : <Minus className="h-3.5 w-3.5" />}
              <span className="hidden sm:inline">{allVisibleCollapsed ? 'Expand All' : 'Collapse All'}</span>
            </button>
          )}
        </div>

        {isLoading ? (
          <div className="text-center py-6 text-xs text-muted-foreground">
            Loading agent capacity…
          </div>
        ) : visible.length === 0 ? (
          <div className="text-center py-6 text-xs text-muted-foreground">
            No agents with active rent exposure.
          </div>
        ) : (
          <ul className="space-y-2">
            {visible.map((row) => (
              <CapacityRow
                key={row.agent_id}
                row={row}
                collapsed={isRowCollapsed(row.agent_id)}
                onToggle={() => toggleRow(row.agent_id)}
              />
            ))}
          </ul>
        )}

        {filtered.length > 0 && (
          <div className="space-y-1">
            <p className="text-[11px] text-center text-muted-foreground tabular-nums">
              Showing {visible.length.toLocaleString()} of {filtered.length.toLocaleString()} agents
            </p>
            {visibleCount < filtered.length && (
              <button
                type="button"
                onClick={() => setVisibleCount((v) => v + LOAD_STEP)}
                className="w-full text-xs font-semibold text-primary py-2 hover:underline"
              >
                Load more (15 per step)
              </button>
            )}
            {visibleCount > LOAD_STEP && (
              <button
                type="button"
                onClick={() => setVisibleCount(LOAD_STEP)}
                className="w-full text-[11px] font-semibold text-muted-foreground py-1 hover:underline"
              >
                Show fewer
              </button>
            )}
          </div>
        )}
      </div>
      )}
    </div>
  );
}

function Kpi({
  icon,
  label,
  value,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-background/70 p-2 sm:p-2.5 flex flex-col justify-between min-h-[58px]">
      <div className={`flex items-center gap-1 text-[9px] sm:text-[10px] font-semibold uppercase tracking-wide ${tone} leading-tight`}>
        <span className="shrink-0">{icon}</span>
        <span className="truncate">{label}</span>
      </div>
      <div className="mt-1 text-xs sm:text-sm font-bold tabular-nums text-foreground break-words leading-tight">
        {value}
      </div>
    </div>
  );
}

function CapacityRow({
  row,
  collapsed,
  onToggle,
}: {
  row: AgentRow;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const pct = Math.min(100, Math.round((row.used / AGENT_RENT_CAP_UGX) * 100));
  const headroom = Math.max(AGENT_RENT_CAP_UGX - row.used, 0);
  const rateLabel = `${Math.round(row.response_rate * 100)}%`;
  const [printing, setPrinting] = useState(false);
  const tierTone: Record<AgentCapacity['tier'], string> = {
    Positive:   'bg-emerald-500/15 text-emerald-700 border-emerald-500/30',
    Fair:       'bg-amber-500/15 text-amber-700 border-amber-500/30',
    Bad:        'bg-orange-500/15 text-orange-700 border-orange-500/30',
    'Very Bad': 'bg-destructive/15 text-destructive border-destructive/30',
    Starter:    'bg-violet-500/15 text-violet-700 border-violet-500/30',
  };
  const tier = { label: row.tier, tone: tierTone[row.tier], max: row.per_tenant_max };

  const dailyRatingTone: Record<AgentCapacity['daily_rating'], string> = {
    'Very Good': 'bg-emerald-600/20 text-emerald-800 border-emerald-600/40',
    'Good':      'bg-emerald-500/15 text-emerald-700 border-emerald-500/40',
    'Fair':      'bg-amber-500/15 text-amber-700 border-amber-500/40',
    'Bad':       'bg-orange-500/15 text-orange-700 border-orange-500/40',
    'Very Bad':  'bg-destructive/15 text-destructive border-destructive/40',
    'Starter':   'bg-violet-500/15 text-violet-700 border-violet-500/40',
  };
  const dailyLabel =
    row.daily_rating === 'Starter' ? 'New today' : `Today: ${row.daily_rating}`;

  const bar =
    pct >= 95 ? 'bg-destructive' : pct >= 75 ? 'bg-amber-500' : 'bg-emerald-500';
  const expectedWeek = row.expected_daily * 7;
  const todayPct = row.expected_daily > 0
    ? Math.min(100, Math.round((row.paid_today / row.expected_daily) * 100))
    : 0;
  const yesterdayPct = row.expected_daily > 1
    ? Math.min(100, Math.round((row.paid_yesterday / row.expected_daily) * 100))
    : 0;
  const weekPct = expectedWeek > 0
    ? Math.min(100, Math.round((row.paid_last_week / expectedWeek) * 100))
    : 0;
  const todayTone = todayPct >= 100 ? 'text-emerald-700' : todayPct >= 50 ? 'text-amber-700' : 'text-destructive';
  const yesterdayTone = yesterdayPct >= 100 ? 'text-emerald-700' : yesterdayPct >= 50 ? 'text-amber-700' : 'text-destructive';
  const weekTone = weekPct >= 100 ? 'text-emerald-700' : weekPct >= 50 ? 'text-amber-700' : 'text-destructive';

  const handlePrint = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setPrinting(true);
    try {
      const cap: AgentCapacity = {
        used: row.used,
        active_count: row.active_count,
        active_tenant_count: row.active_tenant_count,
        paying_tenants_last_week: row.paying_tenants_last_week,
        unfunded_tenant_count: row.unfunded_tenant_count,
        response_rate: row.response_rate,
        responding_tenant_days: row.responding_tenant_days,
        expected_tenant_days: row.expected_tenant_days,
        paid_last_week: row.paid_last_week,
        paid_today: row.paid_today,
        paid_yesterday: row.paid_yesterday,
        yesterday_response_pct: row.expected_daily > 1 ? row.paid_yesterday / row.expected_daily : 0,
        today_response_pct: row.expected_daily > 1 ? row.paid_today / row.expected_daily : 0,
        effective_daily_pct: row.expected_daily > 1 ? row.paid_today / row.expected_daily : 0,
        daily_status: row.daily_status,
        performance_pct: Math.max(
          (row as any).coverage_today ?? 0,
          (row as any).coverage_yesterday ?? 0,
        ),
        daily_rating: row.daily_rating,
        tenants_due: (row as any).tenants_due ?? 0,
        tenants_paid_today: (row as any).tenants_paid_today ?? 0,
        tenants_paid_yesterday: (row as any).tenants_paid_yesterday ?? 0,
        coverage_today: (row as any).coverage_today ?? 0,
        coverage_yesterday: (row as any).coverage_yesterday ?? 0,
        effective_coverage: (row as any).effective_coverage ?? 1,

        can_post_rent_today: row.daily_status !== 'blocked',
        good_days_last_week: (row as any).good_days_last_week ?? 0,
        unlimited_posting: (row as any).unlimited_posting ?? false,
        is_new_agent: row.active_tenant_count < 10,
        expected_daily: row.expected_daily,
        daily_gate_count: (row as any).daily_gate_count ?? row.active_count,
        weekly_plan_count: (row as any).weekly_plan_count ?? 0,
        weekly_lapsed_count: (row as any).weekly_lapsed_count ?? 0,
        weekly_expected_week: (row as any).weekly_expected_week ?? 0,
        repayment_rate: row.response_rate,
        expected_weekly: 0,
        headroom,
        pct,
        tier: row.tier,
        per_tenant_max: row.per_tenant_max,
      };
      const tenants = await fetchAgentCapacityTenants(row.agent_id, cap);
      const blob = generateAgentCapacityPdf(
        { full_name: row.name, phone: row.phone },
        cap,
        tenants,
      );
      downloadCapacityPdf(blob, row.name);
      toast.success(`Capacity report for ${row.name} downloaded`);
    } catch (err: any) {
      toast.error(err?.message || 'Failed to generate report');
    } finally {
      setPrinting(false);
    }
  };

  // Plain-language status for people who don't read details
  const isStarter = row.daily_status === 'starter';
  const isAllowed = row.daily_status !== 'blocked';
  const statusBg = isStarter
    ? 'bg-violet-50 border-violet-300'
    : isAllowed
      ? 'bg-emerald-50 border-emerald-300'
      : 'bg-red-50 border-red-300';
  const statusText = isStarter ? 'text-violet-800' : isAllowed ? 'text-emerald-800' : 'text-red-800';
  const StatusIcon = isStarter ? Sparkles : isAllowed ? CheckCircle2 : XCircle;
  const statusHeadline = isStarter
    ? 'New agent — can post'
    : isAllowed
      ? 'Can post new rent today'
      : 'Blocked from posting today';
  const statusSub = isStarter
    ? 'No active rents yet'
    : isAllowed
      ? `Collected ${todayPct}% of today's target`
      : `Need at least 20% — at ${todayPct}% so far`;

  return (
    <li className="rounded-xl border border-border bg-background overflow-hidden">
      {collapsed ? (
        /* Compact 1-line bar — name, key status, today's collection, expand chevron */
        <div
          role="button"
          tabIndex={0}
          onClick={onToggle}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}
          className="w-full text-left p-3 active:bg-muted/40 transition-colors touch-manipulation cursor-pointer"
          aria-expanded={false}
        >
          <div className="flex items-center gap-3">
            <div
              className={`shrink-0 h-2.5 w-2.5 rounded-full ${
                isAllowed ? 'bg-emerald-500' : 'bg-destructive'
              }`}
              title={isAllowed ? 'Can post new rent today' : 'Blocked from posting today'}
            />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold text-foreground truncate leading-tight">
                {row.name}
              </p>
              <p className="text-[11px] text-muted-foreground truncate">
                {row.phone || '—'} · {row.active_count} active rent{row.active_count === 1 ? '' : 's'}
                {row.unfunded_tenant_count > 0 && (
                  <span className="text-destructive font-bold">
                    {' · '}{row.unfunded_tenant_count} not funded
                  </span>
                )}
              </p>
            </div>
            <div className="hidden sm:flex items-center gap-4 text-xs tabular-nums">
              <div className="text-right">
                <div className="text-[10px] text-muted-foreground uppercase tracking-wide">Today</div>
                <div className={`font-bold ${todayTone}`}>{formatUGX(row.paid_today)}</div>
              </div>
              <div className="text-right">
                <div className="text-[10px] text-muted-foreground uppercase tracking-wide">Target</div>
                <div className="font-bold text-foreground">{formatUGX(row.expected_daily)}</div>
              </div>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <button
                type="button"
                onClick={handlePrint}
                disabled={printing}
                title={`Print report for ${row.name}`}
                className="inline-flex items-center justify-center h-8 w-8 rounded-lg border border-border hover:bg-muted disabled:opacity-50"
              >
                {printing
                  ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  : <Printer className="h-3.5 w-3.5" />}
              </button>
              <span
                className={`hidden md:inline-flex px-2 py-0.5 rounded-full text-[10px] font-bold border ${
                  isAllowed
                    ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
                    : 'bg-red-50 border-red-200 text-red-700'
                }`}
              >
                {isAllowed ? 'Can post' : 'Blocked'}
              </span>
              <div
                className="inline-flex items-center justify-center h-8 w-8 rounded-lg border border-border"
                aria-hidden
              >
                <ChevronDown className="h-4 w-4" />
              </div>
            </div>
          </div>
        </div>
      ) : (
        <>
          {/* Tap-anywhere header — big, plain-language status */}
          <div
            role="button"
            tabIndex={0}
            onClick={onToggle}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}
            className="w-full text-left p-3 active:bg-muted/40 transition-colors touch-manipulation cursor-pointer"
            aria-expanded={true}
          >
            <div className="flex items-center justify-between gap-2 mb-2">
              <div className="min-w-0 flex-1">
                <p className="text-base font-bold text-foreground truncate leading-tight">
                  {row.name}
                </p>
                <p className="text-[11px] text-muted-foreground truncate">
                  {row.phone || '—'} · {row.active_count} active rent{row.active_count === 1 ? '' : 's'}
                  {row.unfunded_tenant_count > 0 && (
                    <span className="text-destructive font-bold">
                      {' · '}{row.unfunded_tenant_count} not funded
                    </span>
                  )}
                </p>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button
                  type="button"
                  onClick={handlePrint}
                  disabled={printing}
                  title={`Print report for ${row.name}`}
                  className="inline-flex items-center justify-center h-9 w-9 rounded-lg border border-border hover:bg-muted disabled:opacity-50"
                >
                  {printing
                    ? <Loader2 className="h-4 w-4 animate-spin" />
                    : <Printer className="h-4 w-4" />}
                </button>
                <div
                  className="inline-flex items-center justify-center h-9 w-9 rounded-lg border border-border"
                  aria-hidden
                >
                  <ChevronUp className="h-4 w-4" />
                </div>
              </div>
            </div>

            {/* BIG status banner — the only thing a busy person needs to see */}
            <div className={`rounded-xl border-2 ${statusBg} p-3 flex items-center gap-3`}>
              <StatusIcon className={`h-8 w-8 shrink-0 ${statusText}`} strokeWidth={2.5} />
              <div className="min-w-0 flex-1">
                <p className={`text-base font-extrabold leading-tight ${statusText}`}>
                  {statusHeadline}
                </p>
                <p className={`text-xs font-semibold mt-0.5 ${statusText} opacity-90`}>
                  {statusSub}
                </p>
              </div>
            </div>

            {/* Today's collection — large numbers everyone can read */}
            {!isStarter && (
              <div className="mt-2 grid grid-cols-2 gap-2">
                <div className="rounded-lg border border-border bg-background/70 p-2">
                  <div className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Collected today</div>
                  <div className={`text-base font-extrabold tabular-nums ${todayTone}`}>
                    {formatUGX(row.paid_today)}
                  </div>
                  <div className="text-[10px] text-muted-foreground tabular-nums">
                    of {formatUGX(row.expected_daily)} target
                  </div>
                </div>
                <div className="rounded-lg border border-border bg-background/70 p-2">
                  <div className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Tenants paid (7d)</div>
                  <div className="text-base font-extrabold tabular-nums text-foreground">
                    {row.paying_tenants_last_week}<span className="text-muted-foreground font-semibold text-xs"> / {row.active_tenant_count}</span>
                  </div>
                  <div className="text-[10px] text-muted-foreground">in the last 7 days</div>
                </div>
              </div>
            )}
          </div>

          <div className="px-3 pb-3 border-t border-border/60 pt-3 space-y-2">
            <div className="flex flex-wrap items-center gap-1">
              <span
                className={`px-2 py-0.5 rounded-full text-[10px] font-bold border ${dailyRatingTone[row.daily_rating]}`}
                title={`Today's collection rating — ${formatUGX(row.paid_today)} of ${formatUGX(row.expected_daily)} (${todayPct}%)`}
              >
                {dailyLabel}
              </span>
              <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold border ${tier.tone}`}>
                7d tier: {tier.label}
              </span>
            </div>
            <div className="flex items-center justify-between text-[11px] font-semibold tabular-nums mb-1">
              <span className="text-muted-foreground">
                Used <span className="text-foreground">{formatUGX(row.used)}</span> / {formatUGX(AGENT_RENT_CAP_UGX)}
              </span>
              <span className="text-muted-foreground">{pct}%</span>
            </div>
            <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
              <div className={`h-full ${bar} transition-all`} style={{ width: `${pct}%` }} />
            </div>
            <div className="flex items-center justify-between text-[11px] mt-1.5">
              <span className="text-muted-foreground">
                Headroom <strong className="text-foreground font-mono">{formatUGX(headroom)}</strong>
              </span>
              <span className="text-muted-foreground">
                Response <strong className="text-foreground">{rateLabel}</strong> · Per-tenant max{' '}
                <strong className="text-foreground font-mono">{formatUGX(tier.max)}</strong>
              </span>
            </div>
            <div className="text-[10px] text-muted-foreground mt-1 tabular-nums">
              Last 7d: <strong className="text-foreground">{row.responding_tenant_days}</strong> /{' '}
              <strong className="text-foreground">{row.expected_tenant_days}</strong> tenant-day responses
              {row.paid_last_week > 0 && (
                <> · <span className="text-muted-foreground">{formatUGX(row.paid_last_week)} total</span></>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-1.5 mt-2">
              <div className="rounded-lg border border-border bg-background/70 p-2">
                <div className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Today</div>
                <div className={`text-[12px] font-extrabold tabular-nums ${todayTone}`}>
                  {formatUGX(row.paid_today)}
                  <span className="text-muted-foreground font-semibold"> / {formatUGX(row.expected_daily)}</span>
                </div>
                <div className="text-[10px] text-muted-foreground">{todayPct}% of daily target</div>
              </div>
              <div className="rounded-lg border border-border bg-background/70 p-2">
                <div className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Yesterday</div>
                <div className={`text-[12px] font-extrabold tabular-nums ${yesterdayTone}`}>
                  {formatUGX(row.paid_yesterday)}
                  <span className="text-muted-foreground font-semibold"> / {formatUGX(row.expected_daily)}</span>
                </div>
                <div className="text-[10px] text-muted-foreground">{yesterdayPct}% of daily target</div>
              </div>
              <div className="rounded-lg border border-border bg-background/70 p-2">
                <div className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">This week (7d)</div>
                <div className={`text-[12px] font-extrabold tabular-nums ${weekTone}`}>
                  {formatUGX(row.paid_last_week)}
                  <span className="text-muted-foreground font-semibold"> / {formatUGX(expectedWeek)}</span>
                </div>
                <div className="text-[10px] text-muted-foreground">{weekPct}% of weekly target</div>
              </div>
            </div>

            <AgentEligibilityHistoryStrip agentId={row.agent_id} />
          </div>
        </>
      )}
    </li>
  );
}

export default AgentRentCapacityPanel;