import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import {
  Loader2, Search, Banknote, Building2, Smartphone, Users,
  ArrowLeft, Phone, Mail, ChevronRight, ListChecks, Wallet, CheckCircle2, Clock, XCircle,
} from 'lucide-react';
import { format } from 'date-fns';
import { formatUGX } from '@/lib/rentCalculations';

type ChannelKey = 'bank' | 'mobile' | 'cash';

function classifyChannel(method: string | null | undefined): ChannelKey {
  const m = (method || '').toLowerCase();
  if (m.includes('bank')) return 'bank';
  if (m.includes('cash')) return 'cash';
  return 'mobile';
}

const COMPLETED_STATUSES = ['approved', 'fin_ops_approved', 'completed'];

export function CashoutAgentActivity() {
  const [search, setSearch] = useState('');
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);

  // Active cashout agents
  const { data: agents = [], isLoading: loadingAgents } = useQuery({
    queryKey: ['cashout-agents-list'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('cashout_agents')
        .select('*, profiles:agent_id(id, full_name, phone)')
        .eq('is_active', true)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data || [];
    },
    staleTime: 30_000,
  });

  const agentIds = useMemo(() => agents.map((a: any) => a.agent_id), [agents]);

  // All withdrawals processed by these cashout agents (completed)
  const { data: payouts = [], isLoading: loadingPayouts } = useQuery({
    queryKey: ['cashout-agent-payouts', agentIds.join(',')],
    queryFn: async () => {
      if (agentIds.length === 0) return [];
      // PostgREST caps any single response at 1,000 rows, and this query used
      // to ask for only 500 — so the KPIs and per-agent stats below were
      // computed from a fraction of the network's payouts. Page through until
      // a short page comes back. The `id` tiebreaker on the sort matters:
      // processed_at is not unique, so without it rows can repeat or vanish
      // across page boundaries.
      const PAGE = 1000;
      const out: any[] = [];
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await supabase
          .from('withdrawal_requests')
          .select('id, user_id, amount, status, payout_method, fin_ops_reference, fin_ops_approved_at, fin_ops_approved_by, fin_ops_verified_by, processed_at, processed_by, created_at')
          .in('processed_by', agentIds)
          .in('status', COMPLETED_STATUSES)
          .order('processed_at', { ascending: false })
          .order('id', { ascending: false })
          .range(from, from + PAGE - 1);
        if (error) throw error;
        const rows = data || [];
        out.push(...rows);
        if (rows.length < PAGE) break;
        // Safety valve against runaway loops.
        if (out.length >= 50_000) break;
      }
      return out;
    },
    enabled: agentIds.length > 0,
    staleTime: 30_000,
  });

  // Beneficiary names lookup for selected agent's transactions
  const beneficiaryIds = useMemo(
    () => Array.from(new Set(payouts.map((p: any) => p.user_id).filter(Boolean))),
    [payouts],
  );
  const { data: beneficiaries = [] } = useQuery({
    queryKey: ['cashout-payout-beneficiaries', beneficiaryIds.join(',')],
    queryFn: async () => {
      if (beneficiaryIds.length === 0) return [];
      // Now that the payout list is complete this spans well over a thousand
      // distinct beneficiaries, which a single .in() cannot carry: the id list
      // overruns the request URL, and the response would be cut at PostgREST's
      // 1,000-row ceiling anyway. Look them up in chunks and stitch together.
      const CHUNK = 200;
      const out: any[] = [];
      for (let i = 0; i < beneficiaryIds.length; i += CHUNK) {
        const { data, error } = await supabase
          .from('profiles')
          .select('id, full_name, phone')
          .in('id', beneficiaryIds.slice(i, i + CHUNK));
        if (error) throw error;
        out.push(...(data || []));
      }
      return out;
    },
    enabled: beneficiaryIds.length > 0,
    staleTime: 60_000,
  });
  const beneficiaryMap = useMemo(() => {
    const m = new Map<string, { full_name?: string; phone?: string }>();
    for (const b of beneficiaries as any[]) m.set(b.id, b);
    return m;
  }, [beneficiaries]);

  // Aggregate per-agent stats
  const agentStats = useMemo(() => {
    const stats = new Map<string, { count: number; volume: number; bank: number; mobile: number; cash: number }>();
    for (const p of payouts as any[]) {
      const key = p.processed_by;
      if (!key) continue;
      const cur = stats.get(key) || { count: 0, volume: 0, bank: 0, mobile: 0, cash: 0 };
      cur.count += 1;
      cur.volume += Number(p.amount || 0);
      cur[classifyChannel(p.payout_method)] += Number(p.amount || 0);
      stats.set(key, cur);
    }
    return stats;
  }, [payouts]);

  // Top KPIs
  const totals = useMemo(() => {
    let volume = 0, bank = 0, mobile = 0, cash = 0;
    for (const p of payouts as any[]) {
      const amt = Number(p.amount || 0);
      volume += amt;
      const ch = classifyChannel(p.payout_method);
      if (ch === 'bank') bank += amt;
      else if (ch === 'cash') cash += amt;
      else mobile += amt;
    }
    return { volume, bank, mobile, cash };
  }, [payouts]);

  const selectedAgent = useMemo(
    () => agents.find((a: any) => a.agent_id === selectedAgentId) || null,
    [agents, selectedAgentId],
  );
  const selectedAgentPayouts = useMemo(
    () => (selectedAgentId ? (payouts as any[]).filter(p => p.processed_by === selectedAgentId) : []),
    [payouts, selectedAgentId],
  );

  // Filtered agent list (search by name/phone)
  const filteredAgents = useMemo(() => {
    if (!search.trim()) return agents;
    const q = search.toLowerCase();
    return (agents as any[]).filter(a =>
      (a.profiles?.full_name || '').toLowerCase().includes(q) ||
      (a.profiles?.phone || '').toLowerCase().includes(q) ||
      (a.label || '').toLowerCase().includes(q),
    );
  }, [agents, search]);

  return (
    <div className="space-y-4">
      {/* KPI ROW — always visible */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
        <KPI
          label="Cashout Agents"
          value={agents.length.toString()}
          icon={<Users className="h-4 w-4" />}
          tone="primary"
        />
        <KPI
          label="Amount Paid"
          value={formatUGX(totals.volume)}
          icon={<Wallet className="h-4 w-4" />}
          tone="success"
        />
        <KPI
          label="Bank"
          value={formatUGX(totals.bank)}
          icon={<Building2 className="h-4 w-4" />}
          tone="info"
        />
        <KPI
          label="Mobile / Cash"
          value={`${formatUGX(totals.mobile)} · ${formatUGX(totals.cash)}`}
          icon={<Smartphone className="h-4 w-4" />}
          tone="warning"
        />
      </div>

      {/* Channel breakdown chips */}
      <div className="flex flex-wrap gap-2">
        <ChannelChip icon={<Building2 className="h-3 w-3" />} label="Bank" amount={totals.bank} />
        <ChannelChip icon={<Smartphone className="h-3 w-3" />} label="Mobile" amount={totals.mobile} />
        <ChannelChip icon={<Banknote className="h-3 w-3" />} label="Cash" amount={totals.cash} />
      </div>

      {/* Detail or list view */}
      {selectedAgent ? (
        <AgentDetailPanel
          agent={selectedAgent}
          payouts={selectedAgentPayouts}
          beneficiaryMap={beneficiaryMap}
          onBack={() => setSelectedAgentId(null)}
        />
      ) : (
        <Card>
          <CardContent className="p-3 sm:p-4 space-y-3">
            <div className="flex items-center gap-2">
              <ListChecks className="h-4 w-4 text-primary" />
              <h3 className="text-sm font-bold">Assigned Cash-Out Agents</h3>
            </div>
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search agent name, phone or label..."
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="pl-9 h-9"
              />
            </div>
            {loadingAgents || loadingPayouts ? (
              <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
            ) : filteredAgents.length === 0 ? (
              <p className="text-center text-xs text-muted-foreground py-6">No cash-out agents assigned</p>
            ) : (
              <div className="space-y-2">
                {filteredAgents.map((a: any) => {
                  const st = agentStats.get(a.agent_id) || { count: 0, volume: 0, bank: 0, mobile: 0, cash: 0 };
                  return (
                    <button
                      key={a.id}
                      onClick={() => setSelectedAgentId(a.agent_id)}
                      className="w-full text-left rounded-lg p-3 bg-muted/40 hover:bg-muted transition-colors flex items-center gap-3"
                    >
                      <div className="h-9 w-9 rounded-full bg-primary/10 text-primary flex items-center justify-center font-bold text-sm shrink-0">
                        {(a.profiles?.full_name || 'A').charAt(0).toUpperCase()}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold truncate">{a.profiles?.full_name || 'Cash-out Agent'}</p>
                        <p className="text-[11px] text-muted-foreground truncate">
                          {a.label || 'Cashout Agent'} · {a.handles_cash && a.handles_bank ? 'Cash + Bank' : a.handles_cash ? 'Cash' : 'Bank'}
                        </p>
                      </div>
                      <div className="text-right shrink-0">
                        <p className="text-sm font-bold text-foreground">{formatUGX(st.volume)}</p>
                        <p className="text-[10px] text-muted-foreground">{st.count} payout{st.count !== 1 ? 's' : ''}</p>
                      </div>
                      <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                    </button>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function AgentDetailPanel({
  agent, payouts, beneficiaryMap, onBack,
}: {
  agent: any;
  payouts: any[];
  beneficiaryMap: Map<string, { full_name?: string; phone?: string }>;
  onBack: () => void;
}) {
  const stats = useMemo(() => {
    let volume = 0, bank = 0, mobile = 0, cash = 0;
    for (const p of payouts) {
      const amt = Number(p.amount || 0);
      volume += amt;
      const ch = classifyChannel(p.payout_method);
      if (ch === 'bank') bank += amt;
      else if (ch === 'cash') cash += amt;
      else mobile += amt;
    }
    return { volume, bank, mobile, cash, count: payouts.length };
  }, [payouts]);

  return (
    <Card>
      <CardContent className="p-3 sm:p-4 space-y-3">
        {/* Header */}
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onBack} className="h-8 px-2">
            <ArrowLeft className="h-4 w-4 mr-1" /> Back
          </Button>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-bold truncate">{agent.profiles?.full_name || 'Cash-out Agent'}</p>
            <p className="text-[11px] text-muted-foreground truncate">
              {agent.label || 'Cashout Agent'}
            </p>
          </div>
        </div>

        {/* Per-agent KPIs */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <MiniKPI label="Completed" value={stats.count.toString()} icon={<CheckCircle2 className="h-3.5 w-3.5" />} />
          <MiniKPI label="Volume" value={formatUGX(stats.volume)} icon={<Wallet className="h-3.5 w-3.5" />} />
          <MiniKPI label="Bank" value={formatUGX(stats.bank)} icon={<Building2 className="h-3.5 w-3.5" />} />
          <MiniKPI label="Mobile/Cash" value={`${formatUGX(stats.mobile + stats.cash)}`} icon={<Smartphone className="h-3.5 w-3.5" />} />
        </div>

        {/* Tabs */}
        <Tabs defaultValue="transactions">
          <TabsList className="w-full">
            <TabsTrigger value="transactions" className="flex-1 text-xs">Transactions</TabsTrigger>
            <TabsTrigger value="profile" className="flex-1 text-xs">Profile</TabsTrigger>
          </TabsList>

          <TabsContent value="transactions" className="mt-3">
            {payouts.length === 0 ? (
              <p className="text-center text-xs text-muted-foreground py-6">No completed payouts yet</p>
            ) : (
              <div className="space-y-2 max-h-[55vh] overflow-y-auto">
                {payouts.map(p => {
                  const beneficiary = beneficiaryMap.get(p.user_id);
                  const ch = classifyChannel(p.payout_method);
                  return (
                    <div key={p.id} className="rounded-lg p-3 bg-muted/30">
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-semibold truncate">{beneficiary?.full_name || 'Unknown beneficiary'}</p>
                          <p className="text-[11px] text-muted-foreground truncate">{beneficiary?.phone || '—'}</p>
                        </div>
                        <p className="text-sm font-bold text-foreground shrink-0">{formatUGX(p.amount)}</p>
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5 mt-2">
                        <StatusBadge status={p.status} />
                        <Badge variant="outline" className="text-[10px] gap-1">
                          {ch === 'bank' && <Building2 className="h-3 w-3" />}
                          {ch === 'cash' && <Banknote className="h-3 w-3" />}
                          {ch === 'mobile' && <Smartphone className="h-3 w-3" />}
                          {p.payout_method || 'mobile'}
                        </Badge>
                        {p.fin_ops_reference && (
                          <Badge variant="secondary" className="text-[10px] font-mono">
                            REF: {p.fin_ops_reference}
                          </Badge>
                        )}
                        <span className="text-[10px] text-muted-foreground ml-auto">
                          {p.processed_at ? format(new Date(p.processed_at), 'MMM d, HH:mm') : '—'}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </TabsContent>

          <TabsContent value="profile" className="mt-3 space-y-2">
            <ProfileRow icon={<Users className="h-3.5 w-3.5" />} label="Name" value={agent.profiles?.full_name || '—'} />
            <ProfileRow icon={<Phone className="h-3.5 w-3.5" />} label="Phone" value={agent.profiles?.phone || '—'} />
            <ProfileRow icon={<Mail className="h-3.5 w-3.5" />} label="Label" value={agent.label || 'Cashout Agent'} />
            <ProfileRow icon={<Wallet className="h-3.5 w-3.5" />} label="Channels" value={[
              agent.handles_cash ? 'Cash' : null,
              agent.handles_bank ? 'Bank' : null,
              agent.handles_mobile_money ? 'Mobile' : null,
            ].filter(Boolean).join(' · ') || '—'} />
            <ProfileRow icon={<Clock className="h-3.5 w-3.5" />} label="Active since" value={agent.created_at ? format(new Date(agent.created_at), 'MMM d, yyyy') : '—'} />
            <ProfileRow icon={<Wallet className="h-3.5 w-3.5" />} label="Daily limit" value={agent.daily_limit ? formatUGX(agent.daily_limit) : '—'} />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}

function KPI({ label, value, icon, tone }: { label: string; value: string; icon: React.ReactNode; tone: 'primary' | 'success' | 'info' | 'warning' }) {
  const toneClass = {
    primary: 'bg-primary/10 text-primary',
    success: 'bg-success/10 text-success',
    info: 'bg-info/10 text-info',
    warning: 'bg-warning/10 text-warning',
  }[tone];
  return (
    <Card>
      <CardContent className="p-3 flex items-center gap-2">
        <div className={`h-8 w-8 rounded-md flex items-center justify-center ${toneClass}`}>{icon}</div>
        <div className="min-w-0">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wider truncate">{label}</p>
          <p className="text-sm font-bold truncate">{value}</p>
        </div>
      </CardContent>
    </Card>
  );
}

function ChannelChip({ icon, label, amount }: { icon: React.ReactNode; label: string; amount: number }) {
  return (
    <Badge variant="secondary" className="gap-1 px-2 py-1 text-[11px] font-medium">
      {icon}
      {label}: <span className="font-mono ml-0.5">{formatUGX(amount)}</span>
    </Badge>
  );
}

function MiniKPI({ label, value, icon }: { label: string; value: string; icon: React.ReactNode }) {
  return (
    <div className="rounded-md bg-muted/40 p-2.5">
      <div className="flex items-center gap-1.5 text-muted-foreground">
        {icon}
        <span className="text-[10px] uppercase tracking-wider truncate">{label}</span>
      </div>
      <p className="text-sm font-bold truncate">{value}</p>
    </div>
  );
}

function ProfileRow({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md bg-muted/30 px-3 py-2">
      <div className="flex items-center gap-2 text-muted-foreground">
        {icon}
        <span className="text-xs">{label}</span>
      </div>
      <span className="text-xs font-semibold text-right truncate">{value}</span>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; tone: 'default' | 'secondary' | 'destructive' | 'outline'; icon: React.ReactNode }> = {
    approved: { label: 'Approved', tone: 'default', icon: <CheckCircle2 className="h-3 w-3" /> },
    fin_ops_approved: { label: 'Fin-Ops Approved', tone: 'default', icon: <CheckCircle2 className="h-3 w-3" /> },
    completed: { label: 'Completed', tone: 'default', icon: <CheckCircle2 className="h-3 w-3" /> },
    pending: { label: 'Pending', tone: 'secondary', icon: <Clock className="h-3 w-3" /> },
    rejected: { label: 'Rejected', tone: 'destructive', icon: <XCircle className="h-3 w-3" /> },
  };
  const cfg = map[status] || { label: status, tone: 'outline' as const, icon: <Clock className="h-3 w-3" /> };
  return (
    <Badge variant={cfg.tone} className="text-[10px] gap-1">{cfg.icon}{cfg.label}</Badge>
  );
}
