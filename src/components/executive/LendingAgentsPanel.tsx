import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent } from '@/components/ui/card';
import { useAgentCapacityMap } from '@/hooks/useAgentCapacityMap';
import { AgentCapacityBadge } from './AgentCapacityBadge';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Search, ShieldCheck, HandCoins, AlertTriangle, TrendingUp, FileText, Calendar, Phone, User } from 'lucide-react';
import { BorrowerVouchBadge } from './BorrowerVouchBadge';
import { format } from 'date-fns';
import { formatUGX } from '@/lib/rentCalculations';
import { cn } from '@/lib/utils';

type LoanRow = {
  id: string;
  lender_agent_id: string;
  borrower_ai_id: string;
  borrower_display_name: string | null;
  borrower_phone: string | null;
  principal_ugx: number;
  interest_rate_pct: number | null;
  amount_repaid_ugx: number;
  status: string;
  expected_repayment_date: string | null;
  created_at: string;
  platform_fee_ugx: number;
  notes: string | null;
};

type AgreementRow = {
  agent_user_id: string;
  agreement_version: string;
  trust_score_at_acceptance: number | null;
  accepted_at: string;
};

type LendingAgent = {
  user_id: string;
  full_name: string;
  phone: string | null;
  trust_score: number | null;
  signed_at: string;
  agreement_version: string;
  loans: LoanRow[];
  total_lent: number;
  total_repaid: number;
  outstanding: number;
  active_count: number;
  defaulted_count: number;
};

const STATUS_VARIANTS: Record<string, 'primary' | 'success' | 'warning' | 'destructive' | 'muted' | 'outline'> = {
  active: 'primary',
  partially_repaid: 'warning',
  repaid: 'success',
  defaulted: 'destructive',
  written_off: 'destructive',
  cancelled: 'muted',
};

export function LendingAgentsPanel() {
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<LendingAgent | null>(null);

  const { data: agreements = [], isLoading: loadingAgreements } = useQuery({
    queryKey: ['exec-lending-agreements'],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from('lending_agent_agreement_acceptance')
        .select('agent_user_id, agreement_version, trust_score_at_acceptance, accepted_at, status')
        .eq('status', 'accepted')
        .order('accepted_at', { ascending: false });
      if (error) throw error;
      const map = new Map<string, AgreementRow>();
      for (const row of (data || []) as AgreementRow[]) {
        if (!map.has(row.agent_user_id)) map.set(row.agent_user_id, row);
      }
      return Array.from(map.values());
    },
    staleTime: 60_000,
  });

  const { data: loans = [], isLoading: loadingLoans } = useQuery({
    queryKey: ['exec-lending-loans'],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from('lending_agent_loans')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(2000);
      if (error) throw error;
      return (data || []) as LoanRow[];
    },
    staleTime: 60_000,
  });

  const agentIds = useMemo(() => {
    const set = new Set<string>();
    agreements.forEach(a => set.add(a.agent_user_id));
    loans.forEach(l => set.add(l.lender_agent_id));
    return Array.from(set);
  }, [agreements, loans]);

  const { data: profilesMap = {} } = useQuery({
    queryKey: ['exec-lending-profiles', agentIds.sort().join(',')],
    queryFn: async () => {
      if (agentIds.length === 0) return {};
      const all: any[] = [];
      const BATCH = 100;
      for (let i = 0; i < agentIds.length; i += BATCH) {
        const { data } = await supabase.from('profiles')
          .select('id, full_name, phone')
          .in('id', agentIds.slice(i, i + BATCH));
        if (data) all.push(...data);
      }
      const m: Record<string, { full_name: string; phone: string | null }> = {};
      all.forEach(p => { m[p.id] = { full_name: p.full_name || 'Unknown Agent', phone: p.phone }; });
      return m;
    },
    enabled: agentIds.length > 0,
    staleTime: 300_000,
  });

  const lendingAgents: LendingAgent[] = useMemo(() => {
    const byAgent = new Map<string, LendingAgent>();
    for (const ag of agreements) {
      const p = (profilesMap as any)[ag.agent_user_id];
      byAgent.set(ag.agent_user_id, {
        user_id: ag.agent_user_id,
        full_name: p?.full_name || 'Unknown Agent',
        phone: p?.phone ?? null,
        trust_score: ag.trust_score_at_acceptance,
        signed_at: ag.accepted_at,
        agreement_version: ag.agreement_version,
        loans: [],
        total_lent: 0,
        total_repaid: 0,
        outstanding: 0,
        active_count: 0,
        defaulted_count: 0,
      });
    }
    for (const loan of loans) {
      let entry = byAgent.get(loan.lender_agent_id);
      if (!entry) {
        const p = (profilesMap as any)[loan.lender_agent_id];
        entry = {
          user_id: loan.lender_agent_id,
          full_name: p?.full_name || 'Unknown Agent',
          phone: p?.phone ?? null,
          trust_score: null,
          signed_at: '',
          agreement_version: '—',
          loans: [],
          total_lent: 0,
          total_repaid: 0,
          outstanding: 0,
          active_count: 0,
          defaulted_count: 0,
        };
        byAgent.set(loan.lender_agent_id, entry);
      }
      entry.loans.push(loan);
      entry.total_lent += Number(loan.principal_ugx) || 0;
      entry.total_repaid += Number(loan.amount_repaid_ugx) || 0;
      if (loan.status === 'active' || loan.status === 'partially_repaid') {
        entry.active_count += 1;
        entry.outstanding += Math.max(0, Number(loan.principal_ugx) - Number(loan.amount_repaid_ugx));
      }
      if (loan.status === 'defaulted' || loan.status === 'written_off') entry.defaulted_count += 1;
    }
    return Array.from(byAgent.values()).sort((a, b) => b.total_lent - a.total_lent);
  }, [agreements, loans, profilesMap]);

  const totals = useMemo(() => {
    const total_agents = lendingAgents.length;
    const total_loans = loans.length;
    const total_lent = loans.reduce((s, l) => s + Number(l.principal_ugx || 0), 0);
    const total_outstanding = loans.reduce((s, l) => {
      if (l.status === 'active' || l.status === 'partially_repaid')
        return s + Math.max(0, Number(l.principal_ugx) - Number(l.amount_repaid_ugx));
      return s;
    }, 0);
    const total_defaulted = loans.filter(l => l.status === 'defaulted' || l.status === 'written_off').length;
    const platform_fees = loans.reduce((s, l) => s + Number(l.platform_fee_ugx || 0), 0);
    return { total_agents, total_loans, total_lent, total_outstanding, total_defaulted, platform_fees };
  }, [lendingAgents, loans]);

  const q = search.toLowerCase().trim();
  const filtered = lendingAgents.filter(a =>
    !q || a.full_name.toLowerCase().includes(q) || (a.phone || '').includes(q) || a.user_id.includes(q)
  );
  const visibleAgentIds = useMemo(() => filtered.map(a => a.user_id), [filtered]);
  const { data: capacityMap, isFetching: capacityFetching } = useAgentCapacityMap(visibleAgentIds);

  const isLoading = loadingAgreements || loadingLoans;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        <KPI label="Lending Agents" value={String(totals.total_agents)} icon={ShieldCheck} color="text-emerald-600" />
        <KPI label="Active Loans" value={String(totals.total_loans)} icon={HandCoins} color="text-primary" />
        <KPI label="Total Lent" value={formatUGX(totals.total_lent)} icon={TrendingUp} color="text-blue-600" />
        <KPI label="Outstanding" value={formatUGX(totals.total_outstanding)} icon={FileText} color="text-amber-600" />
        <KPI label="Defaults" value={String(totals.total_defaulted)} icon={AlertTriangle} color="text-red-600" />
        <KPI label="Platform Fees (1%)" value={formatUGX(totals.platform_fees)} icon={TrendingUp} color="text-violet-600" />
      </div>

      <Tabs defaultValue="agents">
        <TabsList variant="pills" className="w-full">
          <TabsTrigger value="agents" variant="pills" className="flex-1">Lending Agents</TabsTrigger>
          <TabsTrigger value="loans" variant="pills" className="flex-1">All Loans</TabsTrigger>
        </TabsList>

        <TabsContent value="agents" className="mt-3 space-y-3">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              placeholder="Search by name, phone..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="pl-8 h-8 text-xs"
            />
          </div>

          {isLoading && <div className="text-center py-8 text-muted-foreground text-sm">Loading lending agents…</div>}
          {!isLoading && filtered.length === 0 && (
            <div className="text-center py-12 text-muted-foreground text-sm">
              {lendingAgents.length === 0 ? 'No lending agents yet. Agents must sign the Lending Agent Agreement to appear here.' : 'No matching lending agents'}
            </div>
          )}

          <div className="space-y-2">
            {filtered.map(a => (
              <Card key={a.user_id} className="border cursor-pointer hover:bg-muted/30 transition-colors" onClick={() => setSelected(a)}>
                <CardContent className="p-3">
                  <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <ShieldCheck className="h-3.5 w-3.5 text-emerald-600 shrink-0" />
                      <span className={`font-medium text-sm truncate ${(() => {
                        const dr = capacityMap?.get(a.user_id)?.daily_rating;
                        return dr === 'Very Good' || dr === 'Good' ? 'text-emerald-700' : '';
                      })()}`}>{a.full_name}</span>
                      {a.trust_score != null && <Badge variant="outline" size="sm">Trust {a.trust_score}</Badge>}
                      <AgentCapacityBadge
                        capacity={capacityMap?.get(a.user_id)}
                        loading={capacityFetching && !capacityMap}
                      />
                    </div>
                      {a.phone && (
                        <div className="flex items-center gap-1.5 mt-0.5 text-xs text-muted-foreground">
                          <Phone className="h-3 w-3" /> {a.phone}
                        </div>
                      )}
                      <div className="flex flex-wrap gap-1 mt-1.5">
                        <Badge variant="primary" size="sm">{a.loans.length} loan{a.loans.length !== 1 ? 's' : ''}</Badge>
                        {a.active_count > 0 && <Badge variant="warning" size="sm">{a.active_count} active</Badge>}
                        {a.defaulted_count > 0 && <Badge variant="destructive" size="sm">{a.defaulted_count} default</Badge>}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-xs text-muted-foreground">Lent</p>
                      <p className="font-bold text-sm">{formatUGX(a.total_lent)}</p>
                      {a.outstanding > 0 && (
                        <p className="text-[11px] text-amber-600 mt-0.5">Out: {formatUGX(a.outstanding)}</p>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </TabsContent>

        <TabsContent value="loans" className="mt-3 space-y-2">
          {isLoading && <div className="text-center py-8 text-muted-foreground text-sm">Loading loans…</div>}
          {!isLoading && loans.length === 0 && (
            <div className="text-center py-12 text-muted-foreground text-sm">No lending loans recorded yet</div>
          )}
          {loans.slice(0, 200).map(l => (
            <Card key={l.id} className="border">
              <CardContent className="p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm truncate">
                        {(profilesMap as any)[l.lender_agent_id]?.full_name || 'Unknown'}
                      </span>
                      <span className="text-xs text-muted-foreground">→</span>
                      <span className="text-xs font-mono">{l.borrower_ai_id}</span>
                      <Badge variant={STATUS_VARIANTS[l.status] || 'muted'} size="sm">
                        {l.status.replace(/_/g, ' ')}
                      </Badge>
                    </div>
                    {l.borrower_display_name && (
                      <p className="text-xs text-muted-foreground mt-0.5">Borrower: {l.borrower_display_name}</p>
                    )}
                    <div className="flex items-center gap-1 text-[11px] text-muted-foreground mt-0.5">
                      <Calendar className="h-3 w-3" />
                      {format(new Date(l.created_at), 'dd MMM yy')}
                      {l.interest_rate_pct ? ` • ${l.interest_rate_pct}% interest` : ''}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="font-bold text-sm">{formatUGX(Number(l.principal_ugx))}</p>
                    {Number(l.amount_repaid_ugx) > 0 && (
                      <p className="text-[11px] text-emerald-600">Repaid: {formatUGX(Number(l.amount_repaid_ugx))}</p>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </TabsContent>
      </Tabs>

      <Sheet open={!!selected} onOpenChange={(o) => { if (!o) setSelected(null); }}>
        <SheetContent side="bottom" className="h-[80vh] rounded-t-2xl overflow-hidden flex flex-col">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-emerald-600" />
              Lending Agent Details
            </SheetTitle>
          </SheetHeader>
          {selected && (
            <div className="space-y-4 mt-4 overflow-y-auto pb-6">
              <Card>
                <CardContent className="p-3 space-y-2">
                  <div className="flex items-center gap-2">
                    <User className="h-4 w-4 text-muted-foreground" />
                    <p className="font-semibold text-base">{selected.full_name}</p>
                  </div>
                  {selected.phone && (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Phone className="h-3.5 w-3.5" /> {selected.phone}
                    </div>
                  )}
                  <div className="flex flex-wrap gap-2 pt-1">
                    {selected.trust_score != null && <Badge variant="outline">Trust Score: {selected.trust_score}</Badge>}
                    <Badge variant="muted">Agreement {selected.agreement_version}</Badge>
                    {selected.signed_at && (
                      <Badge variant="muted">Signed {format(new Date(selected.signed_at), 'dd MMM yy')}</Badge>
                    )}
                  </div>
                </CardContent>
              </Card>

              <div className="grid grid-cols-3 gap-2">
                <MiniStat label="Total Lent" value={formatUGX(selected.total_lent)} />
                <MiniStat label="Repaid" value={formatUGX(selected.total_repaid)} tone="success" />
                <MiniStat label="Outstanding" value={formatUGX(selected.outstanding)} tone="warning" />
              </div>

              <div>
                <p className="text-xs font-medium text-muted-foreground uppercase mb-2">
                  Loans ({selected.loans.length})
                </p>
                <div className="space-y-2">
                  {selected.loans.map(l => (
                    <Card key={l.id} className="border">
                      <CardContent className="p-3">
                        <div className="flex items-center justify-between gap-2">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-mono text-xs">{l.borrower_ai_id}</span>
                              <Badge variant={STATUS_VARIANTS[l.status] || 'muted'} size="sm">
                                {l.status.replace(/_/g, ' ')}
                              </Badge>
                            </div>
                            {l.borrower_display_name && (
                              <p className="text-xs text-muted-foreground mt-0.5 truncate">{l.borrower_display_name}</p>
                            )}
                            <p className="text-[11px] text-muted-foreground mt-0.5">
                              {format(new Date(l.created_at), 'dd MMM yy')}
                              {l.expected_repayment_date && ` • due ${format(new Date(l.expected_repayment_date), 'dd MMM')}`}
                            </p>
                            <BorrowerVouchBadge aiId={l.borrower_ai_id} className="mt-1.5" />
                          </div>
                          <div className="text-right shrink-0">
                            <p className="font-bold text-sm">{formatUGX(Number(l.principal_ugx))}</p>
                            {Number(l.amount_repaid_ugx) > 0 && (
                              <p className="text-[11px] text-emerald-600">↓ {formatUGX(Number(l.amount_repaid_ugx))}</p>
                            )}
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                  {selected.loans.length === 0 && (
                    <p className="text-sm text-muted-foreground text-center py-4">No loans recorded yet</p>
                  )}
                </div>
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function KPI({ label, value, icon: Icon, color }: { label: string; value: string; icon: any; color: string }) {
  return (
    <Card className="border">
      <CardContent className="p-2.5">
        <div className="flex items-center gap-2">
          <Icon className={cn('h-4 w-4', color)} />
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">{label}</p>
        </div>
        <p className="font-bold text-sm mt-1 truncate">{value}</p>
      </CardContent>
    </Card>
  );
}

function MiniStat({ label, value, tone }: { label: string; value: string; tone?: 'success' | 'warning' }) {
  return (
    <Card className="border">
      <CardContent className="p-2.5 text-center">
        <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
        <p className={cn(
          'font-bold text-sm mt-0.5',
          tone === 'success' && 'text-emerald-600',
          tone === 'warning' && 'text-amber-600',
        )}>{value}</p>
      </CardContent>
    </Card>
  );
}
