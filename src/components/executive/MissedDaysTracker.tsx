import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import {} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { KPICard } from './KPICard';
import { UserProfileSheet } from './UserProfileSheet';
import {
  CalendarX2, Search, RefreshCw, Users, Banknote,
  AlertTriangle, Phone, TrendingDown, Clock, PhoneCall
} from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { differenceInDays, parseISO, format } from 'date-fns';
import { TenantOpsReportToolbar } from './TenantOpsReportToolbar';
import { useTenantCallSummaries, type TenantCallSummary } from '@/hooks/useTenantCallReports';
import { LogTenantCallDialog } from './LogTenantCallDialog';

/** Fetches in batches so large tenant sets are never silently truncated. */
const chunk = <T,>(list: T[], size = 300): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};

/**
 * Repayment clock anchor. `disbursed_at` is missing on most repaying plans
 * (funding was recorded without it), so fall back to the funding date and then
 * to creation — otherwise the majority of active plans disappear from this tool.
 */
const startAnchor = (r: { disbursed_at?: string | null; funded_at?: string | null; created_at?: string | null }) =>
  r.disbursed_at || r.funded_at || r.created_at || null;

type SortBy = 'missed_days' | 'balance' | 'name';

interface TenantMissedData {
  tenant_id: string;
  tenant_name: string;
  rent_request_id: string;
  phone: string;
  daily_repayment: number;
  rent_amount: number;
  amount_repaid: number;
  total_repayment: number;
  outstanding_balance: number;
  disbursed_at: string;
  days_since_disbursed: number;
  expected_repaid: number;
  missed_days: number;
  repayment_pct: number;
  agent_id: string;
  agent_name: string;
  agent_phone: string;
  tenant_wallet: number;
  agent_wallet: number;
}

export function MissedDaysTracker() {
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<SortBy>('missed_days');
  const [riskFilter, setRiskFilter] = useState<'all' | 'critical' | 'warning' | 'on_track'>('all');
  // Call tracking (additive — no existing missed-days logic is affected).
  const [callTab, setCallTab] = useState<'to_call' | 'called'>('to_call');
  const [callAgainDays, setCallAgainDays] = useState<3 | 7 | 14>(3);
  const [callTarget, setCallTarget] = useState<TenantMissedData | null>(null);
  const [profileSheet, setProfileSheet] = useState<{ userId: string; userName: string; userPhone?: string; userType: 'tenant' | 'agent' } | null>(null);
  const { data: callSummaries } = useTenantCallSummaries();

  // Active rent plans from the platform's authoritative daily-eligibility view —
  // identical population to the Tenant Ops counters and Daily Payments tool.
  const { data: activeRequests, isLoading: reqLoading, refetch } = useQuery({
    queryKey: ['missed-days-active'],
    queryFn: async () => {
      const all: any[] = [];
      const page = 1000;
      for (let from = 0; ; from += page) {
        const { data, error } = await supabase
          .from('v_tenant_daily_eligibility')
          .select('rent_request_id, tenant_id, agent_id, daily_repayment, rent_amount, amount_repaid, total_repayment, start_at, status')
          .order('start_at', { ascending: false })
          .range(from, from + page - 1);
        if (error) throw error;
        all.push(...(data || []).map((r: any) => ({ ...r, id: r.rent_request_id, disbursed_at: r.start_at })));
        if (!data || data.length < page) break;
      }
      return all;
    },
    staleTime: 120000,
  });

  const tenantIds = useMemo(() => {
    return [...new Set((activeRequests || []).map(r => r.tenant_id))];
  }, [activeRequests]);

  const agentIds = useMemo(() => {
    return [...new Set((activeRequests || []).map(r => r.agent_id).filter(Boolean))];
  }, [activeRequests]);

  const allUserIds = useMemo(() => [...new Set([...tenantIds, ...agentIds])], [tenantIds, agentIds]);

  const { data: profiles } = useQuery({
    queryKey: ['missed-days-profiles', allUserIds],
    queryFn: async () => {
      if (!allUserIds.length) return [];
      const batches = await Promise.all(
        chunk(allUserIds).map(ids =>
          supabase.from('profiles').select('id, full_name, phone').in('id', ids),
        ),
      );
      return batches.flatMap(b => b.data || []);
    },
    enabled: allUserIds.length > 0,
    staleTime: 300000,
  });

  // Fetch wallet balances
  const { data: wallets } = useQuery({
    queryKey: ['missed-days-wallets', allUserIds],
    queryFn: async () => {
      if (!allUserIds.length) return [];
      const batches = await Promise.all(
        chunk(allUserIds).map(ids =>
          supabase.from('wallets').select('user_id, balance').in('user_id', ids),
        ),
      );
      return batches.flatMap(b => b.data || []);
    },
    enabled: allUserIds.length > 0,
    staleTime: 120000,
  });

  // Fetch total collections per tenant (all time)
  const { data: _allCollections, isLoading: colLoading } = useQuery({
    queryKey: ['missed-days-all-collections', tenantIds],
    queryFn: async () => {
      if (!tenantIds.length) return new Map<string, number>();
      const batches = await Promise.all(
        chunk(tenantIds).map(ids =>
          supabase.from('agent_collections').select('tenant_id, amount').is('reversed_at', null).in('tenant_id', ids),
        ),
      );
      const data = batches.flatMap(b => b.data || []);
      const map = new Map<string, number>();
      (data || []).forEach(c => {
        map.set(c.tenant_id, (map.get(c.tenant_id) || 0) + Number(c.amount));
      });
      return map;
    },
    enabled: tenantIds.length > 0,
    staleTime: 120000,
  });

  const isLoading = reqLoading || colLoading;

  const profileMap = useMemo(() => {
    const m = new Map<string, { name: string; phone: string }>();
    (profiles || []).forEach(p => m.set(p.id, { name: p.full_name || 'Unknown', phone: p.phone || '' }));
    return m;
  }, [profiles]);

  const walletMap = useMemo(() => {
    const m = new Map<string, number>();
    (wallets || []).forEach(w => m.set(w.user_id, Number(w.balance || 0)));
    return m;
  }, [wallets]);

  const tenantList = useMemo(() => {
    if (!activeRequests) return [];
    const today = new Date();

    // Group by tenant - aggregate if multiple requests
    const tenantMap = new Map<string, TenantMissedData>();
    activeRequests.forEach(r => {
      const profile = profileMap.get(r.tenant_id);
      const agentProfile = r.agent_id ? profileMap.get(r.agent_id) : undefined;
      const dailyRepayment = Number(r.daily_repayment || 0);
      const totalRepayment = Number(r.total_repayment || 0);
      const amountRepaid = Number(r.amount_repaid || 0);
      const outstandingBalance = totalRepayment - amountRepaid;
      const anchor = startAnchor(r);
      const disbursedAt = anchor ? parseISO(anchor) : today;
      const daysSinceDisbursed = Math.max(1, differenceInDays(today, disbursedAt));
      const expectedRepaid = Math.min(dailyRepayment * daysSinceDisbursed, totalRepayment);
      const missedDays = dailyRepayment > 0
        ? Math.max(0, Math.round((expectedRepaid - amountRepaid) / dailyRepayment))
        : 0;
      const repaymentPct = totalRepayment > 0 ? Math.round((amountRepaid / totalRepayment) * 100) : 0;

      const existing = tenantMap.get(r.tenant_id);
      if (!existing || outstandingBalance > existing.outstanding_balance) {
        tenantMap.set(r.tenant_id, {
          tenant_id: r.tenant_id,
          tenant_name: profile?.name || r.tenant_id.slice(0, 8),
          rent_request_id: r.id,
          phone: profile?.phone || '',
          daily_repayment: dailyRepayment,
          rent_amount: Number(r.rent_amount || 0),
          amount_repaid: amountRepaid,
          total_repayment: totalRepayment,
          outstanding_balance: outstandingBalance,
          disbursed_at: anchor || '',
          days_since_disbursed: daysSinceDisbursed,
          expected_repaid: expectedRepaid,
          missed_days: missedDays,
          repayment_pct: repaymentPct,
          agent_id: r.agent_id || '',
          agent_name: agentProfile?.name || '—',
          agent_phone: agentProfile?.phone || '',
          tenant_wallet: walletMap.get(r.tenant_id) || 0,
          agent_wallet: r.agent_id ? (walletMap.get(r.agent_id) || 0) : 0,
        });
      }
    });

    return Array.from(tenantMap.values());
  }, [activeRequests, profileMap, walletMap]);

  // Risk classification
  const getRisk = (t: TenantMissedData) => {
    if (t.missed_days >= 5) return 'critical';
    if (t.missed_days >= 2) return 'warning';
    return 'on_track';
  };

  const callInfo = (tenantId: string): TenantCallSummary | undefined => callSummaries?.get(tenantId);

  /** Reached and still inside the Call Again window → sits in "Called / Waiting". */
  const isCalled = (tenantId: string) => {
    const s = callInfo(tenantId);
    if (!s || s.last_outcome !== 'picked_up' || !s.last_picked_up_at) return false;
    return differenceInDays(new Date(), parseISO(s.last_picked_up_at)) < callAgainDays;
  };

  const filtered = useMemo(() => {
    let list = tenantList;
    // Call bucket: a tenant is "Called / Waiting" only while the last successful
    // (picked up) call is still inside the selected Call Again window.
    list = list.filter(t => (callTab === 'called' ? isCalled(t.tenant_id) : !isCalled(t.tenant_id)));
    if (callTab === 'called') list = list.filter(t => (callSummaries?.get(t.tenant_id)?.call_count || 0) > 0);
    if (riskFilter !== 'all') list = list.filter(t => getRisk(t) === riskFilter);
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(t => t.tenant_name.toLowerCase().includes(q) || t.phone.includes(q));
    }
    return list.sort((a, b) => {
      if (callTab === 'called') {
        const at = callSummaries?.get(a.tenant_id)?.last_call_at;
        const bt = callSummaries?.get(b.tenant_id)?.last_call_at;
        if (at || bt) return new Date(bt || 0).getTime() - new Date(at || 0).getTime();
      }
      if (sortBy === 'missed_days') return b.missed_days - a.missed_days;
      if (sortBy === 'balance') return b.outstanding_balance - a.outstanding_balance;
      return a.tenant_name.localeCompare(b.tenant_name);
    });
  }, [tenantList, riskFilter, search, sortBy, callTab, callSummaries, callAgainDays]);

  const criticalCount = tenantList.filter(t => getRisk(t) === 'critical').length;
  const warningCount = tenantList.filter(t => getRisk(t) === 'warning').length;
  const onTrackCount = tenantList.filter(t => getRisk(t) === 'on_track').length;
  const totalOutstanding = tenantList.reduce((s, t) => s + t.outstanding_balance, 0);
  const totalMissedDays = tenantList.reduce((s, t) => s + t.missed_days, 0);

  // Collection KPIs
  const totalCollected = tenantList.reduce((s, t) => s + t.amount_repaid, 0);
  const paidTenants = tenantList.filter(t => t.outstanding_balance <= 0);
  const unpaidTenants = tenantList.filter(t => t.outstanding_balance > 0);
  const paidVolume = paidTenants.reduce((s, t) => s + t.amount_repaid, 0);
  const unpaidVolume = unpaidTenants.reduce((s, t) => s + t.outstanding_balance, 0);

  const riskColor = (risk: string) => {
    if (risk === 'critical') return 'bg-destructive/15 text-destructive border-destructive/30';
    if (risk === 'warning') return 'bg-amber-500/15 text-amber-600 border-amber-500/30';
    return 'bg-emerald-500/15 text-emerald-600 border-emerald-500/30';
  };

  const riskLabel = (risk: string) => {
    if (risk === 'critical') return 'Critical';
    if (risk === 'warning') return 'Warning';
    return 'On Track';
  };

  const [expandedTenant, setExpandedTenant] = useState<string | null>(null);

  return (
    <div className="space-y-2">
      {/* KPIs - scrollable horizontal strip on mobile */}
      <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1 snap-x snap-mandatory scrollbar-none">
        <div className="snap-start shrink-0 w-[45%] sm:w-auto sm:flex-1">
          <KPICard
            title="Pending collections"
            value={formatUGX(totalOutstanding)}
            icon={Banknote}
            loading={isLoading}
            color="bg-amber-500/10 text-amber-600"
            subtitle={`${unpaidTenants.length} tenant${unpaidTenants.length === 1 ? '' : 's'} still owing`}
          />
        </div>
        <div className="snap-start shrink-0 w-[45%] sm:w-auto sm:flex-1">
          <KPICard
            title="Collected so far"
            value={formatUGX(totalCollected)}
            icon={TrendingDown}
            loading={isLoading}
            color="bg-emerald-500/10 text-emerald-600"
            subtitle={`${tenantList.length} tenant${tenantList.length === 1 ? '' : 's'} on plan`}
          />
        </div>
        <div className="snap-start shrink-0 w-[45%] sm:w-auto sm:flex-1">
          <KPICard
            title="Paid tenants"
            value={paidTenants.length}
            icon={Users}
            loading={isLoading}
            color="bg-emerald-500/10 text-emerald-600"
            subtitle={formatUGX(paidVolume)}
          />
        </div>
        <div className="snap-start shrink-0 w-[45%] sm:w-auto sm:flex-1">
          <KPICard
            title="Unpaid tenants"
            value={unpaidTenants.length}
            icon={AlertTriangle}
            loading={isLoading}
            color="bg-destructive/10 text-destructive"
            subtitle={formatUGX(unpaidVolume)}
          />
        </div>
      </div>

      <TenantOpsReportToolbar
        tool={callTab === 'called' ? 'calls_made' : 'missed_days'}
        status={riskFilter}
        search={search}
        visibleCount={filtered.length}
        fileSlug={callTab === 'called' ? 'tenant-calls-made' : 'tenants-behind-on-payments'}
      />

      {/* Call workflow: To Call vs Called / Waiting + Call Again window */}
      <div className="flex flex-wrap items-center gap-2 px-1">
        {([
          { key: 'to_call' as const, label: 'To Call' },
          { key: 'called' as const, label: 'Calls Made' },
        ]).map(tab => (
          <button
            key={tab.key}
            onClick={() => setCallTab(tab.key)}
            className={`px-3.5 py-2 rounded-full text-xs font-medium transition-all min-h-[36px] ${
              callTab === tab.key ? 'bg-primary/10 text-primary ring-1 ring-primary/30' : 'bg-muted/50 text-muted-foreground active:bg-muted'
            }`}
          >
            {tab.label}
          </button>
        ))}
        <span className="text-[10px] text-muted-foreground ml-1">Call again after:</span>
        {([3, 7, 14] as const).map(d => (
          <button
            key={d}
            onClick={() => setCallAgainDays(d)}
            className={`px-3 py-1.5 rounded-full text-[11px] font-medium transition-all min-h-[30px] ${
              callAgainDays === d ? 'bg-foreground/10 text-foreground' : 'text-muted-foreground active:text-foreground'
            }`}
          >
            {d}d
          </button>
        ))}
      </div>

      {/* Sticky search + filters */}
      <div className="sticky top-0 z-20 bg-background/95 backdrop-blur-sm pb-2 -mx-1 px-1 space-y-2">
        {/* Search */}
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input placeholder="Search tenant or phone..." value={search} onChange={e => setSearch(e.target.value)} className="pl-9 h-10" />
          </div>
          <Button variant="outline" size="icon" onClick={() => refetch()} className="shrink-0 h-10 w-10">
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>

        {/* Risk filter pills - horizontal scroll */}
        <div className="flex gap-2 overflow-x-auto scrollbar-none -mx-1 px-1">
          {([
            { key: 'all' as const, label: `All (${tenantList.length})`, icon: Users },
            { key: 'critical' as const, label: `Critical (${criticalCount})`, icon: AlertTriangle },
            { key: 'warning' as const, label: `Warning (${warningCount})`, icon: Clock },
            { key: 'on_track' as const, label: `On Track (${onTrackCount})`, icon: TrendingDown },
          ]).map(f => (
            <button
              key={f.key}
              onClick={() => setRiskFilter(f.key)}
              className={`flex items-center gap-1.5 px-3.5 py-2 rounded-full text-xs font-medium whitespace-nowrap transition-all touch-manipulation min-h-[36px] ${
                riskFilter === f.key
                  ? f.key === 'critical' ? 'bg-destructive/10 text-destructive ring-1 ring-destructive/30'
                  : f.key === 'warning' ? 'bg-amber-500/10 text-amber-600 ring-1 ring-amber-500/30'
                  : f.key === 'on_track' ? 'bg-emerald-500/10 text-emerald-600 ring-1 ring-emerald-500/30'
                  : 'bg-primary/10 text-primary ring-1 ring-primary/30'
                  : 'bg-muted/50 text-muted-foreground active:bg-muted'
              }`}
            >
              <f.icon className="h-3.5 w-3.5" />
              {f.label}
            </button>
          ))}
        </div>

        {/* Sort pills */}
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-muted-foreground mr-0.5">Sort:</span>
          {([
            { key: 'missed_days' as const, label: 'Missed Days' },
            { key: 'balance' as const, label: 'Balance' },
            { key: 'name' as const, label: 'Name' },
          ]).map(s => (
            <button
              key={s.key}
              onClick={() => setSortBy(s.key)}
              className={`px-3 py-1.5 rounded-full text-[11px] font-medium transition-all touch-manipulation min-h-[30px] ${
                sortBy === s.key ? 'bg-foreground/10 text-foreground' : 'text-muted-foreground active:text-foreground'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {/* Results count */}
      <p className="text-[11px] text-muted-foreground px-1">
        {filtered.length} tenant{filtered.length !== 1 ? 's' : ''} found
      </p>

      {/* Tenant List - card-based for mobile */}
      {isLoading ? (
        <div className="flex items-center justify-center py-16">
          <div className="animate-spin rounded-full h-6 w-6 border-2 border-primary/20 border-t-primary" />
        </div>
      ) : !filtered.length ? (
        <div className="text-center py-16 text-muted-foreground">
          <Users className="h-10 w-10 mx-auto mb-2 opacity-30" />
          <p className="text-sm">No tenants match the current filter.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map(t => {
            const risk = getRisk(t);
            const isExpanded = expandedTenant === t.tenant_id;
            return (
              <div
                key={t.tenant_id}
                className={`rounded-xl border transition-all ${
                  risk === 'critical' ? 'border-destructive/25 bg-destructive/[0.03]'
                  : risk === 'warning' ? 'border-amber-500/25 bg-amber-500/[0.03]'
                  : 'border-border bg-card'
                }`}
              >
                {/* Tappable main row */}
                <button
                  onClick={() => setExpandedTenant(isExpanded ? null : t.tenant_id)}
                  className="w-full text-left px-3 py-3 touch-manipulation active:bg-muted/30 transition-colors rounded-xl"
                >
                  <div className="flex items-center gap-3">
                    {/* Risk dot */}
                    <div className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${
                      risk === 'critical' ? 'bg-destructive/15' : risk === 'warning' ? 'bg-amber-500/15' : 'bg-emerald-500/15'
                    }`}>
                      <span className={`text-sm font-bold ${
                        risk === 'critical' ? 'text-destructive' : risk === 'warning' ? 'text-amber-600' : 'text-emerald-600'
                      }`}>
                        {t.missed_days}
                      </span>
                    </div>

                    {/* Name + key info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold truncate text-foreground">{t.tenant_name}</span>
                        <Badge variant="outline" className={`text-[9px] px-1.5 shrink-0 ${riskColor(risk)}`}>
                          {riskLabel(risk)}
                        </Badge>
                      </div>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-0.5 text-[11px] text-muted-foreground">
                        <span>Owed: <strong className="text-foreground">{formatUGX(t.outstanding_balance)}</strong></span>
                        <span className="hidden sm:inline">•</span>
                        <span>{t.repayment_pct}% repaid</span>
                      </div>
                      {(() => {
                        const s = callInfo(t.tenant_id);
                        if (!s) return null;
                        return (
                          <div className="mt-1 text-[10px] text-muted-foreground">
                            <span className="font-medium text-foreground">{s.call_count} call{s.call_count === 1 ? '' : 's'}</span>
                            {s.last_call_at && <> · last {format(new Date(s.last_call_at), 'dd MMM HH:mm')}</>}
                            {s.last_outcome && <> · {s.last_outcome === 'picked_up' ? 'Picked up' : 'Missed call'}</>}
                            {s.latest_comment && <p className="italic truncate">“{s.latest_comment}”</p>}
                          </div>
                        );
                      })()}
                    </div>

                    {/* Quick call */}
                    {t.phone && (
                      <a
                        href={`tel:${t.phone}`}
                        onClick={e => e.stopPropagation()}
                        className="shrink-0 w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center active:bg-primary/20 transition-colors"
                      >
                        <Phone className="h-4 w-4 text-primary" />
                      </a>
                    )}
                  </div>

                  {/* Progress bar */}
                  <div className="mt-2 w-full h-1.5 rounded-full bg-muted overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all ${
                        risk === 'critical' ? 'bg-destructive' : risk === 'warning' ? 'bg-amber-500' : 'bg-emerald-500'
                      }`}
                      style={{ width: `${Math.min(100, t.repayment_pct)}%` }}
                    />
                  </div>
                </button>

                {/* Expanded details */}
                {isExpanded && (
                  <div className="px-3 pb-3 pt-1 space-y-2 border-t border-border/50 animate-in slide-in-from-top-1 duration-150">
                    {/* Collection status the Tenant Ops caller needs at a glance.
                        Derived from the same figures already computed above — no
                        new logic, no new queries. */}
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                      <div className="rounded-lg bg-muted/50 p-2 min-w-0">
                        <p className="text-[10px] text-muted-foreground">Days missed</p>
                        <p className={`text-xs font-semibold ${
                          risk === 'critical' ? 'text-destructive' : risk === 'warning' ? 'text-amber-600' : 'text-emerald-600'
                        }`}>
                          {t.missed_days}d
                        </p>
                      </div>
                      <div className="rounded-lg bg-muted/50 p-2 min-w-0">
                        <p className="text-[10px] text-muted-foreground">Daily payment</p>
                        <p className="text-xs font-semibold break-all">{formatUGX(t.daily_repayment)}</p>
                      </div>
                      <div className="rounded-lg bg-muted/50 p-2 min-w-0">
                        <p className="text-[10px] text-muted-foreground">Total missed</p>
                        <p className="text-xs font-semibold break-all text-destructive">
                          {formatUGX(t.daily_repayment * t.missed_days)}
                        </p>
                      </div>
                      <div className="rounded-lg bg-muted/50 p-2 min-w-0">
                        <p className="text-[10px] text-muted-foreground">Total owed</p>
                        <p className="text-xs font-semibold break-all">{formatUGX(t.outstanding_balance)}</p>
                      </div>
                    </div>

                    {/* Financial details grid */}
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                      <div className="rounded-lg bg-muted/50 p-2">
                        <p className="text-[10px] text-muted-foreground">Daily Target</p>
                        <p className="text-xs font-semibold break-all">{formatUGX(t.daily_repayment)}</p>
                      </div>
                      <div className="rounded-lg bg-muted/50 p-2">
                        <p className="text-[10px] text-muted-foreground">Days Active</p>
                        <p className="text-xs font-semibold">{t.days_since_disbursed}d</p>
                      </div>
                      <div className="rounded-lg bg-muted/50 p-2">
                        <p className="text-[10px] text-muted-foreground">Tenant Wallet</p>
                        <p className={`text-xs font-semibold break-all ${t.tenant_wallet > 0 ? 'text-emerald-600' : 'text-destructive'}`}>{formatUGX(t.tenant_wallet)}</p>
                      </div>
                      <div className="rounded-lg bg-muted/50 p-2">
                        <p className="text-[10px] text-muted-foreground">Agent Wallet</p>
                        <p className={`text-xs font-semibold break-all ${t.agent_wallet > 0 ? 'text-emerald-600' : 'text-destructive'}`}>{formatUGX(t.agent_wallet)}</p>
                      </div>
                    </div>

                    {/* Agent info + actions */}
                    <div className="flex items-center gap-2 rounded-lg bg-muted/30 p-2">
                      <div className="flex-1 min-w-0">
                        <p className="text-[10px] text-muted-foreground">Responsible Agent</p>
                        {t.agent_id ? (
                          <button
                            onClick={() => setProfileSheet({ userId: t.agent_id, userName: t.agent_name, userPhone: t.agent_phone, userType: 'agent' })}
                            className="text-xs font-semibold text-primary underline underline-offset-2 decoration-primary/30"
                          >
                            {t.agent_name}
                          </button>
                        ) : (
                          <p className="text-xs font-semibold text-foreground">{t.agent_name}</p>
                        )}
                      </div>
                      {t.agent_phone && (
                        <a
                          href={`tel:${t.agent_phone}`}
                          className="shrink-0 w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center active:bg-primary/20"
                        >
                          <Phone className="h-3.5 w-3.5 text-primary" />
                        </a>
                      )}
                    </div>

                    {/* Call logging + profile */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <Button
                        variant="default"
                        size="sm"
                        className="h-10 text-xs font-medium w-full"
                        onClick={() => setCallTarget(t)}
                      >
                        <PhoneCall className="h-3.5 w-3.5 mr-1.5" /> Log call
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-10 text-xs font-medium w-full"
                        onClick={() => setProfileSheet({ userId: t.tenant_id, userName: t.tenant_name, userPhone: t.phone, userType: 'tenant' })}
                      >
                        View Tenant Profile
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {profileSheet && (
        <UserProfileSheet
          open={!!profileSheet}
          onClose={() => setProfileSheet(null)}
          userId={profileSheet.userId}
          userName={profileSheet.userName}
          userPhone={profileSheet.userPhone}
          userType={profileSheet.userType}
        />
      )}

      {callTarget && (
        <LogTenantCallDialog
          open={!!callTarget}
          onClose={() => setCallTarget(null)}
          tenantId={callTarget.tenant_id}
          tenantName={callTarget.tenant_name}
          tenantPhone={callTarget.phone}
          rentRequestId={callTarget.rent_request_id}
          missedDays={callTarget.missed_days}
          dailyRepayment={callTarget.daily_repayment}
          outstandingBalance={callTarget.outstanding_balance}
        />
      )}
    </div>
  );
}
