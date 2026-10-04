import { useState, useMemo, useEffect, useRef } from 'react';
import { TenantOpsReportToolbar } from './TenantOpsReportToolbar';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { extractFromErrorObject } from '@/lib/extractEdgeFunctionError';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { KPICard } from './KPICard';
import { UserProfileSheet } from './UserProfileSheet';
import { DeleteRentRequestDialog } from './DeleteRentRequestDialog';
import { DeleteHistoryViewer } from './DeleteHistoryViewer';
import { RepaymentTrendChart } from './RepaymentTrendChart';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '@/components/ui/dialog';
import {
  CheckCircle2, XCircle, Search, RefreshCw, Users,
  Banknote, AlertTriangle, TrendingUp, Phone, MessageCircle,
  Download, Loader2, Trash2, Wallet, Clock
} from 'lucide-react';
import { getWhatsAppLink } from '@/lib/phoneUtils';
import { downloadDailyPerformancePdf, shareDailyPerformanceWhatsApp, type DailyPerformanceData } from '@/lib/dailyPerformanceReport';
import { toast } from '@/hooks/use-toast';
import { formatUGX } from '@/lib/rentCalculations';
import { format, formatDistanceToNow } from 'date-fns';

type Filter = 'all' | 'paid' | 'unpaid';
type DeviceFilter = 'all' | 'smartphone' | 'no-smartphone';

/** Batches id lists so large tenant sets are never silently truncated. */
const chunkIds = (list: string[], size = 300): string[][] => {
  const out: string[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};

interface ActiveTenant {
  tenant_id: string;
  tenant_name: string;
  phone: string;
  daily_repayment: number;
  rent_amount: number;
  amount_repaid: number;
  total_repayment: number;
  disbursed_at: string;
  rent_request_id: string;
  agent_id: string;
  agent_name: string;
  agent_phone: string;
  landlord_id: string;
  landlord_name: string;
  landlord_phone: string;
  tenant_wallet: number;
  agent_wallet: number;
  tenant_no_smartphone: boolean;
}

// Removed unused TodayCollection interface

export function DailyPaymentTracker() {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<Filter>('all');
  const [deviceFilter, setDeviceFilter] = useState<DeviceFilter>('all');
  const [search, setSearch] = useState('');
  const [profileSheet, setProfileSheet] = useState<{ userId: string; userName: string; userPhone?: string; userType: 'tenant' | 'agent' | 'landlord' } | null>(null);
  const [pdfLoading, setPdfLoading] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<typeof filtered[0] | null>(null);
  const [collectingId, setCollectingId] = useState<string | null>(null);
  const [collectTarget, setCollectTarget] = useState<{ id: string; name: string; amount: number } | null>(null);
  const [collectReason, setCollectReason] = useState('');
  const [flashId, setFlashId] = useState<string | null>(null);
  const [pulseTotal, setPulseTotal] = useState(false);
  const prevTotalRef = useRef<number>(0);
  const seenIdsRef = useRef<Set<string>>(new Set());

  const collectMutation = useMutation({
    mutationFn: async ({ rentRequestId, collectionReason }: { rentRequestId: string; collectionReason: string }) => {
      setCollectingId(rentRequestId);
      const { data, error } = await supabase.functions.invoke('manual-collect-rent', {
        body: { rent_request_id: rentRequestId, reason: collectionReason },
      });
      if (error) {
        const msg = await extractFromErrorObject(error, 'Collection failed.');
        throw new Error(msg);
      }
      if (data?.error) throw new Error(data.error);
      return data;
    },
    onSuccess: (data) => {
      toast({
        title: '✅ Rent Collected',
        description: `UGX ${Number(data.total_collected).toLocaleString()} deducted. Tenant: ${Number(data.tenant_deducted).toLocaleString()}, Agent: ${Number(data.agent_deducted).toLocaleString()}`,
      });
      setCollectTarget(null);
      setCollectReason('');
      refetch();
      queryClient.invalidateQueries({ queryKey: ['repayment-trend-7d'] });
    },
    onError: (e: any) => toast({ title: 'Collection Failed', description: e.message, variant: 'destructive' }),
    onSettled: () => setCollectingId(null),
  });

  const buildReportData = (): DailyPerformanceData => ({
    date: new Date(),
    totalExpected: totalExpectedToday,
    totalCollected: totalCollectedToday,
    collectionRate,
    paidCount,
    unpaidCount,
    tenants: tenantList.map(t => ({
      tenant_name: t.tenant_name,
      phone: t.phone,
      daily_repayment: t.daily_repayment,
      paidToday: t.paidToday,
      hasPaid: t.hasPaid,
      agent_name: t.agent_name,
      agent_phone: t.agent_phone,
      tenant_wallet: t.tenant_wallet,
    })),
  });

  const handleDownloadPdf = async () => {
    setPdfLoading(true);
    try {
      await downloadDailyPerformancePdf(buildReportData());
      toast({ title: '✅ PDF Downloaded' });
    } catch (e: any) {
      toast({ title: 'PDF Failed', description: e.message, variant: 'destructive' });
    } finally {
      setPdfLoading(false);
    }
  };

  const handleShareWhatsApp = () => {
    shareDailyPerformanceWhatsApp(buildReportData());
  };

  // Today in East Africa Time (the operating day used across the platform),
  // with explicit UTC boundaries so the query is not shifted by the browser tz.
  const todayStr = format(new Date(Date.now() + 3 * 60 * 60 * 1000), 'yyyy-MM-dd');
  const dayStartIso = new Date(`${todayStr}T00:00:00+03:00`).toISOString();
  const dayEndIso = new Date(`${todayStr}T23:59:59.999+03:00`).toISOString();

  // Active rent plans, sourced from the platform's authoritative daily-eligibility
  // view (the same rule that drives agent daily targets and the tool badges):
  // funded/repaying, still owing, not paused, not marked "not paying".
  const { data: activeRequests, isLoading: reqLoading, refetch } = useQuery({
    queryKey: ['daily-tracker-active'],
    queryFn: async () => {
      const all: any[] = [];
      const page = 1000;
      for (let from = 0; ; from += page) {
        const { data, error } = await supabase
          .from('v_tenant_daily_eligibility')
          .select('rent_request_id, tenant_id, agent_id, landlord_id, daily_repayment, rent_amount, amount_repaid, total_repayment, start_at, status, tenant_no_smartphone')
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

  // Fetch tenant + agent profiles for active requests
  const tenantIds = useMemo(() => {
    return [...new Set((activeRequests || []).map(r => r.tenant_id))];
  }, [activeRequests]);

  const agentIds = useMemo(() => {
    return [...new Set((activeRequests || []).map(r => r.agent_id).filter(Boolean))];
  }, [activeRequests]);

  const landlordIds = useMemo(() => {
    return [...new Set((activeRequests || []).map((r: any) => r.landlord_id).filter(Boolean))];
  }, [activeRequests]);

  const allUserIds = useMemo(
    () => [...new Set([...tenantIds, ...agentIds])],
    [tenantIds, agentIds]
  );

  const { data: profiles } = useQuery({
    queryKey: ['daily-tracker-profiles', allUserIds],
    queryFn: async () => {
      if (!allUserIds.length) return [];
      // Batched — a hard slice(0, 200) left most tenants nameless.
      const batches = await Promise.all(
        chunkIds(allUserIds).map(ids =>
          supabase.from('profiles').select('id, full_name, phone').in('id', ids),
        ),
      );
      return batches.flatMap(b => b.data || []);
    },
    enabled: allUserIds.length > 0,
    staleTime: 300000,
  });

  // Landlord names come from the `landlords` table (entered by agents at registration),
  // NOT from `profiles` (landlord_id in rent_requests points to landlords.id).
  const { data: landlordRecords } = useQuery({
    queryKey: ['daily-tracker-landlords', landlordIds],
    queryFn: async () => {
      if (!landlordIds.length) return [];
      const batches = await Promise.all(
        chunkIds(landlordIds).map(ids =>
          supabase.from('landlords').select('id, name, phone').in('id', ids),
        ),
      );
      return batches.flatMap(b => b.data || []);
    },
    enabled: landlordIds.length > 0,
    staleTime: 300000,
  });

  // Fetch wallet balances for tenants and agents
  const { data: wallets } = useQuery({
    queryKey: ['daily-tracker-wallets', allUserIds],
    queryFn: async () => {
      if (!allUserIds.length) return [];
      const batches = await Promise.all(
        chunkIds(allUserIds).map(ids =>
          supabase.from('wallets').select('user_id, balance').in('user_id', ids),
        ),
      );
      return batches.flatMap(b => b.data || []);
    },
    enabled: allUserIds.length > 0,
    staleTime: 120000,
  });

  // Fetch today's collections
  const { data: todayCollections, isLoading: colLoading } = useQuery({
    queryKey: ['daily-tracker-collections', todayStr],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('agent_collections')
        .select('tenant_id, amount').is('reversed_at', null)
        .gte('created_at', dayStartIso)
        .lte('created_at', dayEndIso);
      if (error) throw error;
      // Aggregate by tenant
      const map = new Map<string, number>();
      (data || []).forEach(c => {
        map.set(c.tenant_id, (map.get(c.tenant_id) || 0) + Number(c.amount));
      });
      return map;
    },
    staleTime: 60000,
  });

  // Fetch latest allocations today (with agent + tenant), most recent first
  const { data: latestAllocations } = useQuery({
    queryKey: ['daily-tracker-latest-allocations', todayStr],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('agent_collections')
        .select('id, tenant_id, agent_id, amount, created_at, payment_method, location_name').is('reversed_at', null)
        .gte('created_at', dayStartIso)
        .lte('created_at', dayEndIso)
        .order('created_at', { ascending: false })
        .limit(30);
      if (error) throw error;
      return data || [];
    },
    staleTime: 60000,
  });

  const isLoading = reqLoading || colLoading;

  // Realtime: listen for new agent_collections today and refresh live
  useEffect(() => {
    const channel = supabase
      .channel('daily-tracker-live-allocations')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'agent_collections' },
        (payload: any) => {
          const row = payload?.new;
          if (!row?.created_at) return;
          // Only react to TODAY's allocations
          const created = new Date(row.created_at);
          const now = new Date();
          if (created.toDateString() !== now.toDateString()) return;
          if (row.id) setFlashId(String(row.id));
          setPulseTotal(true);
          setTimeout(() => setPulseTotal(false), 1200);
          queryClient.invalidateQueries({ queryKey: ['daily-tracker-collections', todayStr] });
          queryClient.invalidateQueries({ queryKey: ['daily-tracker-latest-allocations', todayStr] });
          queryClient.invalidateQueries({ queryKey: ['repayment-trend-7d'] });
        }
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [queryClient, todayStr]);

  // Detect new IDs arriving via query refresh and pulse total
  useEffect(() => {
    if (!latestAllocations) return;
    const ids = new Set(latestAllocations.map(a => a.id));
    let newOne: string | null = null;
    for (const id of ids) {
      if (!seenIdsRef.current.has(id)) { newOne = id; break; }
    }
    if (newOne && seenIdsRef.current.size > 0) {
      setFlashId(newOne);
      setPulseTotal(true);
      setTimeout(() => setPulseTotal(false), 1200);
    }
    seenIdsRef.current = ids;
  }, [latestAllocations]);

  const profileMap = useMemo(() => {
    const m = new Map<string, { name: string; phone: string }>();
    (profiles || []).forEach(p => m.set(p.id, { name: p.full_name || 'Unknown', phone: p.phone || '' }));
    return m;
  }, [profiles]);

  const landlordMap = useMemo(() => {
    const m = new Map<string, { name: string; phone: string }>();
    (landlordRecords || []).forEach((l: any) =>
      m.set(l.id, { name: (l.name || '').trim() || 'Unnamed Landlord', phone: l.phone || '' })
    );
    return m;
  }, [landlordRecords]);

  const walletMap = useMemo(() => {
    const m = new Map<string, number>();
    (wallets || []).forEach(w => m.set(w.user_id, Number(w.balance || 0)));
    return m;
  }, [wallets]);

  // Build tenant list with paid/unpaid status
  const tenantList = useMemo(() => {
    if (!activeRequests) return [];

    // Group by tenant — keep the plan with the largest outstanding balance, the
    // same de-duplication the Tenant Ops counters and Missed Days tool use.
    const tenantMap = new Map<string, ActiveTenant>();
    activeRequests.forEach(r => {
      const existing = tenantMap.get(r.tenant_id);
      const profile = profileMap.get(r.tenant_id);
      const agentProfile = r.agent_id ? profileMap.get(r.agent_id) : undefined;
      const landlordProfile = (r as any).landlord_id ? landlordMap.get((r as any).landlord_id) : undefined;
      const entry: ActiveTenant = {
        tenant_id: r.tenant_id,
        tenant_name: profile?.name || profile?.phone || `Tenant ${r.tenant_id.slice(0, 6)}`,
        phone: profile?.phone || '',
        daily_repayment: Number(r.daily_repayment || 0),
        rent_amount: Number(r.rent_amount || 0),
        amount_repaid: Number(r.amount_repaid || 0),
        total_repayment: Number(r.total_repayment || 0),
        // Funding date is the fallback anchor when no disbursement stamp exists.
        disbursed_at: r.disbursed_at || r.funded_at || r.created_at || '',
        rent_request_id: r.id,
        agent_id: r.agent_id || '',
        agent_name: agentProfile?.name || '—',
        agent_phone: agentProfile?.phone || '',
        landlord_id: (r as any).landlord_id || '',
        landlord_name: landlordProfile?.name || landlordProfile?.phone || 'Unnamed Landlord',
        landlord_phone: landlordProfile?.phone || '',
        tenant_wallet: walletMap.get(r.tenant_id) || 0,
        agent_wallet: r.agent_id ? (walletMap.get(r.agent_id) || 0) : 0,
        tenant_no_smartphone: r.tenant_no_smartphone ?? false,
      };
      const outstanding = entry.total_repayment - entry.amount_repaid;
      const existingOutstanding = existing ? existing.total_repayment - existing.amount_repaid : -1;
      if (!existing || outstanding > existingOutstanding) {
        tenantMap.set(r.tenant_id, entry);
      }
    });

    return Array.from(tenantMap.values()).map(t => {
      const paidToday = todayCollections?.get(t.tenant_id) || 0;
      const hasPaid = paidToday >= t.daily_repayment * 0.5;
      return { ...t, paidToday, hasPaid };
    });
  }, [activeRequests, todayCollections, profileMap, landlordMap, walletMap]);

  // Apply filters
  const filtered = useMemo(() => {
    let list = tenantList;
    if (filter === 'paid') list = list.filter(t => t.hasPaid);
    if (filter === 'unpaid') list = list.filter(t => !t.hasPaid);
    if (deviceFilter === 'smartphone') list = list.filter(t => !t.tenant_no_smartphone);
    if (deviceFilter === 'no-smartphone') list = list.filter(t => t.tenant_no_smartphone);
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(t => t.tenant_name.toLowerCase().includes(q) || t.phone.includes(q));
    }
    // Sort: unpaid first, then by daily amount desc
    return list.sort((a, b) => {
      if (a.hasPaid !== b.hasPaid) return a.hasPaid ? 1 : -1;
      return b.daily_repayment - a.daily_repayment;
    });
  }, [tenantList, filter, deviceFilter, search]);

  const paidCount = tenantList.filter(t => t.hasPaid).length;
  const unpaidCount = tenantList.filter(t => !t.hasPaid).length;
  const totalCollectedToday = tenantList.reduce((s, t) => s + t.paidToday, 0);
  const totalExpectedToday = tenantList.reduce((s, t) => s + t.daily_repayment, 0);
  const collectionRate = totalExpectedToday > 0 ? Math.round((totalCollectedToday / totalExpectedToday) * 100) : 0;

  // Pulse the headline total whenever collected actually grows
  useEffect(() => {
    if (totalCollectedToday > prevTotalRef.current && prevTotalRef.current > 0) {
      setPulseTotal(true);
      const t = setTimeout(() => setPulseTotal(false), 1200);
      return () => clearTimeout(t);
    }
    prevTotalRef.current = totalCollectedToday;
  }, [totalCollectedToday]);

  return (
    <div className="space-y-3 sm:space-y-4">
      {/* KPIs */}
      <div className="grid grid-cols-2 gap-2">
        <KPICard title="Paid Today" value={paidCount} icon={CheckCircle2} loading={isLoading} color="bg-emerald-500/10 text-emerald-600" />
        <KPICard title="Not Paid" value={unpaidCount} icon={XCircle} loading={isLoading} color="bg-destructive/10 text-destructive" />
        <KPICard title="Collected Today" value={formatUGX(totalCollectedToday)} icon={Banknote} loading={isLoading} color="bg-primary/10 text-primary" />
        <KPICard title="Collection Rate" value={`${collectionRate}%`} icon={TrendingUp} loading={isLoading}
          color={collectionRate >= 70 ? 'bg-emerald-500/10 text-emerald-600' : collectionRate >= 40 ? 'bg-amber-500/10 text-amber-600' : 'bg-destructive/10 text-destructive'}
        />
      </div>

      <TenantOpsReportToolbar
        tool="daily_payments"
        status="all"
        search={search}
        visibleCount={filtered.length}
        fileSlug="tenant-daily-payments"
      />

      {/* Share Actions */}
      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          className="flex-1 h-10 gap-2 text-xs font-semibold"
          onClick={handleDownloadPdf}
          disabled={pdfLoading || isLoading}
        >
          {pdfLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
          Download PDF
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="flex-1 h-10 gap-2 text-xs font-semibold text-emerald-600 border-emerald-200 hover:bg-emerald-50"
          onClick={handleShareWhatsApp}
          disabled={isLoading}
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
          Share WhatsApp
        </Button>
      </div>

      {/* Search + Filters */}
      <Card className="border shadow-sm">
        <CardContent className="p-3">
          <div className="flex items-center gap-2 mb-3">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search tenant..."
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="pl-9 h-9"
              />
            </div>
            <Button variant="outline" size="icon" onClick={() => refetch()} className="shrink-0 h-9 w-9">
              <RefreshCw className="h-4 w-4" />
            </Button>
          </div>
          <div className="flex gap-1.5">
            {([
              { key: 'all', label: `All (${tenantList.length})`, icon: Users },
              { key: 'paid', label: `Paid (${paidCount})`, icon: CheckCircle2 },
              { key: 'unpaid', label: `Unpaid (${unpaidCount})`, icon: AlertTriangle },
            ] as const).map(f => (
              <button
                key={f.key}
                onClick={() => setFilter(f.key)}
                className={`flex items-center gap-1 px-3 py-1.5 rounded-full text-xs font-medium transition-all ${
                  filter === f.key
                    ? f.key === 'paid' ? 'bg-emerald-500/10 text-emerald-600 ring-1 ring-emerald-500/30'
                    : f.key === 'unpaid' ? 'bg-destructive/10 text-destructive ring-1 ring-destructive/30'
                    : 'bg-primary/10 text-primary ring-1 ring-primary/30'
                    : 'bg-muted/50 text-muted-foreground hover:bg-muted'
                }`}
              >
                <f.icon className="h-3 w-3" />
                {f.label}
              </button>
            ))}
          </div>
          {/* Device filter */}
          <div className="flex gap-1.5 mt-2">
            {([
              { key: 'all' as const, label: 'All Devices' },
              { key: 'smartphone' as const, label: '📱 Smartphone' },
              { key: 'no-smartphone' as const, label: '📵 No Phone' },
            ]).map(f => (
              <button
                key={f.key}
                onClick={() => setDeviceFilter(f.key)}
                className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-medium transition-all ${
                  deviceFilter === f.key
                    ? 'bg-secondary text-foreground ring-1 ring-border'
                    : 'bg-muted/30 text-muted-foreground hover:bg-muted/60'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Latest Allocations By Agents */}
      <Card className="border-2 border-primary/30 bg-gradient-to-br from-primary/5 to-transparent shadow-sm">
        <CardHeader className="pb-2 px-3 sm:px-4">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Clock className="h-4 w-4 text-primary" />
            Latest Payments Allocated by Agents — Today
            <Badge variant="secondary" className="ml-auto text-[10px]">
              {latestAllocations?.length || 0}
            </Badge>
          </CardTitle>
          {/* Live vs Expected progress */}
          <div className="mt-2 space-y-1.5">
            <div className="flex items-center justify-between text-[11px]">
              <span className="inline-flex items-center gap-1.5 font-semibold text-muted-foreground">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-500 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
                </span>
                LIVE · Allocated vs Expected Today
              </span>
              <span className={`font-bold tabular-nums transition-all ${pulseTotal ? 'text-emerald-600 scale-110' : 'text-foreground'}`}>
                {formatUGX(totalCollectedToday)} <span className="text-muted-foreground font-normal">/ {formatUGX(totalExpectedToday)}</span>
              </span>
            </div>
            <Progress
              value={Math.min(100, collectionRate)}
              size="sm"
              variant={collectionRate >= 70 ? 'success' : collectionRate >= 40 ? 'warning' : 'destructive'}
            />
            <div className="flex items-center justify-between text-[10px] text-muted-foreground">
              <span>{collectionRate}% of today's target</span>
              <span>Updates live as agents allocate</span>
            </div>
          </div>
        </CardHeader>
        <CardContent className="px-0 pb-2">
          {!latestAllocations || latestAllocations.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <Banknote className="h-8 w-8 mx-auto mb-2 opacity-40" />
              <p className="text-xs">No agent allocations recorded today yet.</p>
            </div>
          ) : (
            <div className="divide-y divide-border max-h-[40vh] overflow-y-auto">
              {latestAllocations.map((c, i) => {
                const tenant = profileMap.get(c.tenant_id);
                const agent = c.agent_id ? profileMap.get(c.agent_id) : undefined;
                return (
                  <div
                    key={c.id}
                    className={`px-3 sm:px-4 py-2.5 flex items-center gap-3 transition-colors duration-700 ${
                      flashId === c.id ? 'bg-emerald-500/15 ring-1 ring-emerald-500/40' : ''
                    }`}
                  >
                    <div className="w-7 h-7 rounded-full bg-emerald-500/15 flex items-center justify-center shrink-0 text-[10px] font-bold text-emerald-600">
                      {i + 1}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <button
                          onClick={() => setProfileSheet({ userId: c.tenant_id, userName: tenant?.name || 'Tenant', userPhone: tenant?.phone, userType: 'tenant' })}
                          className="text-sm font-semibold truncate text-primary underline underline-offset-2 decoration-primary/30 hover:decoration-primary"
                        >
                          {tenant?.name || c.tenant_id.slice(0, 8)}
                        </button>
                        <span className="text-[10px] text-muted-foreground">paid via</span>
                        {c.agent_id ? (
                          <button
                            onClick={() => setProfileSheet({ userId: c.agent_id!, userName: agent?.name || 'Agent', userPhone: agent?.phone, userType: 'agent' })}
                            className="text-xs font-semibold text-primary underline underline-offset-2 decoration-primary/30 hover:decoration-primary truncate"
                          >
                            {agent?.name || '—'}
                          </button>
                        ) : (
                          <span className="text-xs font-semibold text-muted-foreground">System</span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 text-[10px] text-muted-foreground mt-0.5 flex-wrap">
                        <Clock className="h-2.5 w-2.5" />
                        {formatDistanceToNow(new Date(c.created_at), { addSuffix: true })}
                        {c.payment_method && (<><span>•</span><span className="capitalize">{c.payment_method}</span></>)}
                        {c.location_name && (<><span>•</span><span className="truncate">{c.location_name}</span></>)}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-sm font-bold text-emerald-600">{formatUGX(Number(c.amount))}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Tenant List */}
      <Card className="border shadow-sm">
        <CardHeader className="pb-2 px-3 sm:px-4">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            Daily Payment Status — {format(new Date(), 'dd MMM yyyy')}
            {isLoading && <RefreshCw className="h-3 w-3 animate-spin text-muted-foreground" />}
          </CardTitle>
        </CardHeader>
        <CardContent className="px-0 pb-2">
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <div className="animate-spin rounded-full h-6 w-6 border-2 border-primary/20 border-t-primary" />
            </div>
          ) : !filtered.length ? (
            <div className="text-center py-12 text-muted-foreground">
              <Users className="h-8 w-8 mx-auto mb-2 opacity-40" />
              <p className="text-sm">No active tenants found.</p>
            </div>
          ) : (
            <div className="divide-y divide-border max-h-[60vh] overflow-y-auto">
              {filtered.map(t => {
                const repayPct = t.total_repayment > 0 ? Math.round((t.amount_repaid / t.total_repayment) * 100) : 0;
                return (
                  <div key={t.tenant_id} className="px-3 sm:px-4 py-3 space-y-1.5">
                    <div className="flex items-center gap-3">
                      {/* Status Icon */}
                      <div className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 ${
                        t.hasPaid ? 'bg-emerald-500/15' : 'bg-destructive/15'
                      }`}>
                        {t.hasPaid
                          ? <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                          : <XCircle className="h-4 w-4 text-destructive" />
                        }
                      </div>

                      {/* Info */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => setProfileSheet({ userId: t.tenant_id, userName: t.tenant_name, userPhone: t.phone, userType: 'tenant' })}
                            className="text-sm font-medium truncate text-primary underline underline-offset-2 decoration-primary/30 hover:decoration-primary"
                          >
                            {t.tenant_name}
                          </button>
                          <Badge variant="outline" className={`text-[9px] px-1.5 ${t.hasPaid ? 'border-emerald-500/30 text-emerald-600' : 'border-destructive/30 text-destructive'}`}>
                            {t.hasPaid ? 'Paid' : 'Unpaid'}
                          </Badge>
                          <button
                            onClick={async (e) => {
                              e.stopPropagation();
                              const newVal = !t.tenant_no_smartphone;
                              await supabase.from('rent_requests').update({ tenant_no_smartphone: newVal }).eq('id', t.rent_request_id);
                              refetch();
                              toast({ title: newVal ? '📵 Marked as no smartphone' : '📱 Marked as smartphone user' });
                            }}
                            className={`text-[9px] px-1.5 py-0.5 rounded-md border transition-colors ${
                              t.tenant_no_smartphone
                                ? 'border-warning/30 bg-warning/10 text-warning'
                                : 'border-success/30 bg-success/10 text-success'
                            }`}
                            title="Toggle smartphone status"
                          >
                            {t.tenant_no_smartphone ? '📵 No Phone' : '📱'}
                          </button>
                        </div>
                        <div className="flex items-center gap-2 text-[10px] text-muted-foreground mt-0.5 flex-wrap">
                          <span>Daily: {formatUGX(t.daily_repayment)}</span>
                          <span>•</span>
                          <span>{t.hasPaid ? `Paid: ${formatUGX(t.paidToday)}` : 'No payment yet'}</span>
                          <span>•</span>
                          <span>{repayPct}% repaid</span>
                        </div>
                      </div>

                      {/* Phone + WhatsApp quick actions */}
                      {t.phone && (
                        <div className="flex items-center gap-1 shrink-0">
                          <a
                            href={getWhatsAppLink(t.phone)}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={e => e.stopPropagation()}
                            className="p-2 rounded-full bg-[hsl(142,70%,45%)]/10 hover:bg-[hsl(142,70%,45%)]/20 transition-colors"
                            title="WhatsApp"
                          >
                            <MessageCircle className="h-4 w-4 text-[hsl(142,70%,45%)]" />
                          </a>
                          <a
                            href={`tel:${t.phone}`}
                            onClick={e => e.stopPropagation()}
                            className="p-2 rounded-full bg-primary/10 hover:bg-primary/20 transition-colors"
                            title="Call"
                          >
                            <Phone className="h-4 w-4 text-primary" />
                          </a>
                        </div>
                      )}
                    </div>

                    {/* Agent + Wallet + Delete row */}
                    <div className="ml-12 flex items-start justify-between gap-2">
                      <div className="flex flex-col gap-1 text-[11px] flex-1">
                        {/* Agent contact row */}
                        <div className="inline-flex items-center gap-1.5 flex-wrap px-2 py-1 rounded-md bg-primary/5 border border-primary/15">
                          <span className="font-semibold text-primary">👤 Agent:</span>
                          {t.agent_id ? (
                            <button
                              onClick={() => setProfileSheet({ userId: t.agent_id, userName: t.agent_name, userPhone: t.agent_phone, userType: 'agent' })}
                              className="font-bold text-foreground underline underline-offset-2 decoration-primary/40 hover:decoration-primary"
                            >
                              {t.agent_name}
                            </button>
                          ) : <strong className="text-foreground">{t.agent_name}</strong>}
                          {t.agent_phone && (
                            <span className="inline-flex items-center gap-1 ml-auto">
                              <span className="text-muted-foreground tabular-nums">{t.agent_phone}</span>
                              <a
                                href={getWhatsAppLink(t.agent_phone)}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={e => e.stopPropagation()}
                                className="p-1 rounded-full bg-[hsl(142,70%,45%)]/10 hover:bg-[hsl(142,70%,45%)]/20"
                                title="WhatsApp"
                              >
                                <MessageCircle className="h-3 w-3 text-[hsl(142,70%,45%)]" />
                              </a>
                              <a
                                href={`tel:${t.agent_phone}`}
                                onClick={e => e.stopPropagation()}
                                className="p-1 rounded-full bg-primary/10 hover:bg-primary/20"
                                title="Call"
                              >
                                <Phone className="h-3 w-3 text-primary" />
                              </a>
                            </span>
                          )}
                        </div>
                        {/* Landlord contact row */}
                        <div className="inline-flex items-center gap-1.5 flex-wrap px-2 py-1 rounded-md bg-amber-500/10 border border-amber-500/20">
                          <span className="font-semibold text-amber-700 dark:text-amber-400">🏠 Landlord:</span>
                          {t.landlord_id ? (
                            <button
                              onClick={() => setProfileSheet({ userId: t.landlord_id, userName: t.landlord_name, userPhone: t.landlord_phone, userType: 'landlord' })}
                              className="font-bold text-foreground underline underline-offset-2 decoration-amber-500/40 hover:decoration-amber-500"
                            >
                              {t.landlord_name}
                            </button>
                          ) : <strong className="text-foreground">—</strong>}
                          {t.landlord_phone && (
                            <span className="inline-flex items-center gap-1 ml-auto">
                              <span className="text-muted-foreground tabular-nums">{t.landlord_phone}</span>
                              <a
                                href={getWhatsAppLink(t.landlord_phone)}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={e => e.stopPropagation()}
                                className="p-1 rounded-full bg-[hsl(142,70%,45%)]/10 hover:bg-[hsl(142,70%,45%)]/20"
                                title="WhatsApp"
                              >
                                <MessageCircle className="h-3 w-3 text-[hsl(142,70%,45%)]" />
                              </a>
                              <a
                                href={`tel:${t.landlord_phone}`}
                                onClick={e => e.stopPropagation()}
                                className="p-1 rounded-full bg-primary/10 hover:bg-primary/20"
                                title="Call"
                              >
                                <Phone className="h-3 w-3 text-primary" />
                              </a>
                            </span>
                          )}
                        </div>
                        {/* Wallets row */}
                        <div className="grid grid-cols-2 gap-x-3 text-[10px] text-muted-foreground px-1">
                          <span>Tenant Wallet: <strong className={t.tenant_wallet > 0 ? 'text-emerald-600' : 'text-destructive'}>{formatUGX(t.tenant_wallet)}</strong></span>
                          <span>Agent Wallet: <strong className={t.agent_wallet > 0 ? 'text-emerald-600' : 'text-destructive'}>{formatUGX(t.agent_wallet)}</strong></span>
                        </div>
                      </div>
                      {/* Collect + Delete buttons */}
                      <div className="flex items-center gap-1 shrink-0">
                        {!t.hasPaid && (
                          <Button
                            variant="default"
                            size="sm"
                            disabled={collectingId === t.rent_request_id}
                            onClick={(e) => {
                              e.stopPropagation();
                              setCollectTarget({ id: t.rent_request_id, name: t.tenant_name, amount: t.daily_repayment });
                              setCollectReason('');
                            }}
                            className="h-7 px-2 text-[10px] gap-1"
                          >
                            {collectingId === t.rent_request_id ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <Wallet className="h-3 w-3" />
                            )}
                            Collect
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            setDeleteTarget(t);
                          }}
                          className="h-7 px-2 text-[10px] gap-1 text-destructive hover:bg-destructive/10"
                        >
                          <Trash2 className="h-3 w-3" />
                          Delete
                        </Button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
      {/* Repayment Trend Chart */}
      <RepaymentTrendChart dailyExpected={totalExpectedToday} />

      {/* Delete History */}
      <DeleteHistoryViewer />

      {/* Profile Sheet */}
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

      {/* Delete Confirmation Dialog */}
      {deleteTarget && (
        <DeleteRentRequestDialog
          open={!!deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onDeleted={() => {
            refetch();
            queryClient.invalidateQueries({ queryKey: ['rent-request-deletions'] });
          }}
          tenant={deleteTarget}
        />
      )}

      {/* Collect Reason Dialog */}
      <Dialog open={!!collectTarget} onOpenChange={(open) => { if (!open) { setCollectTarget(null); setCollectReason(''); } }}>
        <DialogContent stable className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-sm">Collect Rent</DialogTitle>
            <DialogDescription className="text-xs">
              {collectTarget?.name} — Daily: {formatUGX(collectTarget?.amount || 0)}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground">
              Reason for collection <span className="text-destructive">*</span>
            </label>
            <Textarea
              value={collectReason}
              onChange={(e) => setCollectReason(e.target.value)}
              placeholder="e.g. Daily rent repayment instalment..."
              className="min-h-[60px] text-sm"
              maxLength={500}
            />
            {collectReason.length > 0 && collectReason.trim().length < 10 && (
              <p className="text-[10px] text-destructive">Minimum 10 characters ({collectReason.trim().length}/10)</p>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => { setCollectTarget(null); setCollectReason(''); }}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={collectReason.trim().length < 10 || collectMutation.isPending}
              onClick={() => {
                if (collectTarget) {
                  collectMutation.mutate({ rentRequestId: collectTarget.id, collectionReason: collectReason.trim() });
                }
              }}
              className="gap-1"
            >
              {collectMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Wallet className="h-3 w-3" />}
              Confirm Collection
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
