import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { fetchOpsWalletBuckets } from '@/hooks/ops/useOpsDataLayer';
import { useAuth } from '@/hooks/useAuth';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ScrollArea } from '@/components/ui/scroll-area';
import { formatUGX } from '@/lib/rentCalculations';
import { format } from 'date-fns';
import {
  Loader2, Building2, TrendingUp,
  Scale, Download, AlertTriangle, ChevronRight
} from 'lucide-react';
import { toast } from 'sonner';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { CalendarIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

// ─── Tab 1: Float Transfers ───────────────────────────────────────────────────
function FloatTransfersTab() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [selectedAgent, setSelectedAgent] = useState('');
  const [amount, setAmount] = useState('');
  const [bankRef, setBankRef] = useState('');
  const [bankName, setBankName] = useState('Equity Bank Uganda');
  const [notes, setNotes] = useState('');

  const { data: agents = [], isLoading: agentsLoading } = useQuery({
    queryKey: ['cashout-agents-for-float'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('cashout_agents')
        .select('agent_id, label, profiles:agent_id(id, full_name, phone)')
        .eq('is_active', true);
      if (error) throw error;
      return data || [];
    },
  });

  const { data: transfers = [], isLoading: transfersLoading } = useQuery({
    queryKey: ['float-transfers-history'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('agent_float_funding')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(100);
      if (error) throw error;

      const agentIds = [...new Set((data || []).map((t: any) => t.agent_id))];
      const profiles: Record<string, any> = {};
      for (const id of agentIds) {
        const { data: p } = await supabase.from('profiles').select('full_name, phone').eq('id', id).single();
        if (p) profiles[id] = p;
      }
      return (data || []).map((t: any) => ({ ...t, profile: profiles[t.agent_id] }));
    },
  });

  const sendMutation = useMutation({
    mutationFn: async () => {
      if (!selectedAgent) throw new Error('Select an agent');
      if (!amount || Number(amount) <= 0) throw new Error('Enter valid amount');
      if (!bankRef.trim()) throw new Error('Bank reference (TID) is mandatory');

      // Backend-only flow — edge function inserts the funding row, writes a
      // balanced ledger pair (allowlisted category), and posts the audit log.
      // Wallet UI refreshes via the realtime `wallets` subscription.
      const { data, error } = await supabase.functions.invoke('record-bank-float-transfer', {
        body: {
          agent_id: selectedAgent,
          amount: Number(amount),
          bank_reference: bankRef.trim(),
          bank_name: bankName || 'Equity Bank Uganda',
          notes: notes || null,
        },
      });
      if (error) throw new Error(error.message || 'Float transfer failed');
      if (data?.error) throw new Error(data.error);
    },
    onSuccess: () => {
      toast.success('Float sent to agent successfully');
      setAmount(''); setBankRef(''); setNotes(''); setSelectedAgent('');
      qc.invalidateQueries({ queryKey: ['float-transfers-history'] });
      qc.invalidateQueries({ queryKey: ['agent-float-balances'] });
    },
    onError: (e: any) => toast.error(e.message),
  });

  const totalProcessed = transfers.reduce((s: number, t: any) => s + Number(t.amount), 0);

  return (
    <div className="space-y-4">
      {/* Record Form */}
      <Card className="rounded-2xl">
        <CardContent className="p-5 space-y-4">
          <div>
            <h3 className="text-base font-bold">Record Bank Float Transfer</h3>
            <p className="text-xs text-muted-foreground mt-0.5">Initiate and document bank-to-agent float settlements.</p>
          </div>

          <div className="space-y-3">
            <div>
              <Label className="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold">Cash-Out Agent</Label>
              <select
                className="w-full h-11 rounded-xl border border-input bg-background px-3 text-sm mt-1.5 focus:outline-none focus:ring-2 focus:ring-ring"
                value={selectedAgent}
                onChange={e => setSelectedAgent(e.target.value)}
              >
                <option value="">Select agent…</option>
                {agents.map((a: any) => (
                  <option key={a.agent_id} value={a.agent_id}>
                    {(a.profiles as any)?.full_name || 'Unknown'} — {a.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <Label className="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold">Amount (UGX)</Label>
              <Input type="number" placeholder="500,000" value={amount} onChange={e => setAmount(e.target.value)} className="mt-1.5 rounded-xl h-11" />
            </div>

            <div>
              <Label className="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold">Bank Reference (TID) *</Label>
              <Input placeholder="TRF-12345" value={bankRef} onChange={e => setBankRef(e.target.value)} className="mt-1.5 rounded-xl h-11" />
            </div>

            <div>
              <Label className="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold">Bank Name</Label>
              <Input value={bankName} onChange={e => setBankName(e.target.value)} className="mt-1.5 rounded-xl h-11" />
            </div>

            <div>
              <Label className="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold">Notes</Label>
              <Textarea placeholder="Optional notes…" className="h-16 mt-1.5 rounded-xl" value={notes} onChange={e => setNotes(e.target.value)} />
            </div>

            <Button
              onClick={() => sendMutation.mutate()}
              disabled={sendMutation.isPending}
              className="w-full bg-gradient-to-r from-purple-600 via-purple-500 to-pink-500 hover:from-purple-700 hover:via-purple-600 hover:to-pink-600 text-white rounded-full h-12 text-sm tracking-widest uppercase font-semibold shadow-lg"
            >
              {sendMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Record Float Transfer <ChevronRight className="h-4 w-4 ml-1" />
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Transfer History */}
      <div>
        <div className="flex items-center justify-between mb-3 px-1">
          <h3 className="text-sm font-bold">Transfer History</h3>
          <button className="text-xs font-semibold text-purple-600 uppercase tracking-widest">View All</button>
        </div>

        {transfersLoading ? (
          <div className="flex justify-center py-4"><Loader2 className="h-5 w-5 animate-spin" /></div>
        ) : transfers.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-4">No float transfers recorded yet</p>
        ) : (
          <ScrollArea className="max-h-[40vh]">
            <div className="space-y-2">
              {transfers.map((t: any) => (
                <div key={t.id} className="flex items-center gap-3 p-3 rounded-xl bg-card border border-border/40">
                  <div className="h-10 w-10 rounded-full bg-purple-100 flex items-center justify-center shrink-0">
                    <Building2 className="h-5 w-5 text-purple-600" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-sm truncate">{t.profile?.full_name || 'Unknown'}</p>
                    <p className="text-[11px] text-muted-foreground truncate">
                      {t.bank_name || 'Bank'} · TID: {t.bank_reference || 'N/A'}
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="font-bold text-sm">{formatUGX(t.amount)}</p>
                    <Badge className={`text-[9px] px-2 py-0 rounded-full mt-0.5 ${
                      t.status === 'completed'
                        ? 'bg-emerald-100 text-emerald-700 border-emerald-200'
                        : 'bg-amber-100 text-amber-700 border-amber-200'
                    }`}>
                      {(t.status || 'COMPLETED').toUpperCase()}
                    </Badge>
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>
        )}
      </div>

      {/* Summary Card */}
      <div className="rounded-2xl bg-gradient-to-r from-purple-600 via-purple-500 to-pink-500 p-5 text-white">
        <p className="text-[10px] uppercase tracking-widest opacity-80 font-semibold">Total Float Processed</p>
        <p className="text-2xl font-bold mt-1">{formatUGX(totalProcessed)}</p>
        <div className="flex items-center gap-1 mt-1">
          <TrendingUp className="h-3 w-3" />
          <span className="text-xs opacity-90">+12% from last week</span>
        </div>
      </div>
    </div>
  );
}

// ─── Tab 2: Agent Float Balances ──────────────────────────────────────────────
function AgentFloatBalancesTab() {
  const { data: balances = [], isLoading } = useQuery({
    queryKey: ['agent-float-balances'],
    queryFn: async () => {
      const { data: agents } = await supabase
        .from('cashout_agents')
        .select('agent_id, label, profiles:agent_id(full_name, phone)')
        .eq('is_active', true);
      if (!agents) return [];

      const results = await Promise.all(agents.map(async (agent: any) => {
        const { data: funding } = await supabase
          .from('agent_float_funding')
          .select('amount')
          .eq('agent_id', agent.agent_id);
        const totalFunded = (funding || []).reduce((s: number, f: any) => s + Number(f.amount), 0);

        const { data: withdrawals } = await supabase
          .from('withdrawal_requests')
          .select('amount')
          .eq('assigned_cashout_agent_id', agent.agent_id)
          .eq('status', 'completed');
        const totalDisbursed = (withdrawals || []).reduce((s: number, w: any) => s + Number(w.amount), 0);

        const balance = totalFunded - totalDisbursed;
        const commission = totalDisbursed * 0.01;
        const healthPct = totalFunded > 0 ? (balance / totalFunded) * 100 : 0;

        return { ...agent, totalFunded, totalDisbursed, balance, commission, healthPct };
      }));

      return results;
    },
  });

  return (
    <div className="space-y-3">
      {isLoading ? (
        <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin" /></div>
      ) : balances.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-6">No cashout agents found</p>
      ) : (
        balances.map((a: any) => (
          <Card key={a.agent_id} className={`rounded-2xl border-2 ${
            a.healthPct > 20 ? 'border-emerald-500/50 bg-emerald-500/5' :
            a.healthPct > 0 ? 'border-amber-500/50 bg-amber-500/5' :
            'border-destructive/50 bg-destructive/5'
          }`}>
            <CardContent className="p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-full bg-purple-100 flex items-center justify-center shrink-0">
                    <Building2 className="h-5 w-5 text-purple-600" />
                  </div>
                  <div>
                    <p className="font-bold text-sm">{(a.profiles as any)?.full_name || 'Unknown'}</p>
                    <p className="text-[11px] text-muted-foreground">{a.label} · {(a.profiles as any)?.phone}</p>
                  </div>
                </div>
                <Badge className={`text-[10px] rounded-full px-2.5 ${
                  a.healthPct > 20 ? 'bg-emerald-100 text-emerald-700 border-emerald-200' :
                  a.healthPct > 0 ? 'bg-amber-100 text-amber-700 border-amber-200' :
                  'bg-red-100 text-red-700 border-red-200'
                }`}>
                  {a.healthPct.toFixed(0)}%
                </Badge>
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="p-2.5 rounded-xl bg-muted/50">
                  <p className="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold">Float Sent</p>
                  <p className="font-bold mt-0.5">{formatUGX(a.totalFunded)}</p>
                </div>
                <div className="p-2.5 rounded-xl bg-muted/50">
                  <p className="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold">Disbursed</p>
                  <p className="font-bold mt-0.5">{formatUGX(a.totalDisbursed)}</p>
                </div>
                <div className="p-2.5 rounded-xl bg-muted/50">
                  <p className="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold">Available</p>
                  <p className={`font-bold mt-0.5 ${a.balance < 0 ? 'text-destructive' : 'text-emerald-600'}`}>{formatUGX(a.balance)}</p>
                </div>
                <div className="p-2.5 rounded-xl bg-muted/50">
                  <p className="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold">Commission</p>
                  <p className="font-bold mt-0.5 text-purple-600">{formatUGX(a.commission)}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}

// ─── Tab 3: Float Reconciliation ──────────────────────────────────────────────
function FloatReconciliationTab() {
  const [dateFrom, setDateFrom] = useState<Date | undefined>(undefined);
  const [dateTo, setDateTo] = useState<Date | undefined>(undefined);

  const { data: reconciliation = [], isLoading, refetch } = useQuery({
    queryKey: ['float-reconciliation', dateFrom?.toISOString(), dateTo?.toISOString()],
    queryFn: async () => {
      const { data: agents } = await supabase
        .from('cashout_agents')
        .select('agent_id, label, profiles:agent_id(full_name)')
        .eq('is_active', true);
      if (!agents) return [];

      return Promise.all(agents.map(async (agent: any) => {
        let openingFunded = 0;
        let openingDisbursed = 0;

        if (dateFrom) {
          const { data: preFunding } = await supabase
            .from('agent_float_funding')
            .select('amount')
            .eq('agent_id', agent.agent_id)
            .lt('created_at', dateFrom.toISOString());
          openingFunded = (preFunding || []).reduce((s: number, f: any) => s + Number(f.amount), 0);

          const { data: preWithdrawals } = await supabase
            .from('withdrawal_requests')
            .select('amount')
            .eq('assigned_cashout_agent_id', agent.agent_id)
            .eq('status', 'completed')
            .lt('updated_at', dateFrom.toISOString());
          openingDisbursed = (preWithdrawals || []).reduce((s: number, w: any) => s + Number(w.amount), 0);
        }

        const openingBalance = openingFunded - openingDisbursed;

        let fundingQuery = supabase.from('agent_float_funding').select('amount').eq('agent_id', agent.agent_id);
        let withdrawQuery = supabase.from('withdrawal_requests').select('amount').eq('assigned_cashout_agent_id', agent.agent_id).eq('status', 'completed');

        if (dateFrom) {
          fundingQuery = fundingQuery.gte('created_at', dateFrom.toISOString());
          withdrawQuery = withdrawQuery.gte('updated_at', dateFrom.toISOString());
        }
        if (dateTo) {
          const endDate = new Date(dateTo);
          endDate.setHours(23, 59, 59, 999);
          fundingQuery = fundingQuery.lte('created_at', endDate.toISOString());
          withdrawQuery = withdrawQuery.lte('updated_at', endDate.toISOString());
        }

        const [{ data: periodFunding }, { data: periodWithdrawals }] = await Promise.all([fundingQuery, withdrawQuery]);
        const received = (periodFunding || []).reduce((s: number, f: any) => s + Number(f.amount), 0);
        const executed = (periodWithdrawals || []).reduce((s: number, w: any) => s + Number(w.amount), 0);
        const expectedClosing = openingBalance + received - executed;

        return {
          agent_id: agent.agent_id,
          name: (agent.profiles as any)?.full_name || 'Unknown',
          label: agent.label,
          openingBalance,
          received,
          executed,
          expectedClosing,
        };
      }));
    },
    enabled: true,
  });

  const exportCSV = () => {
    if (reconciliation.length === 0) return;
    const headers = 'Agent,Opening Balance,Float Received,Withdrawals Executed,Expected Closing\n';
    const rows = reconciliation.map((r: any) =>
      `"${r.name}",${r.openingBalance},${r.received},${r.executed},${r.expectedClosing}`
    ).join('\n');
    const blob = new Blob([headers + rows], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const filename = `float-reconciliation-${format(new Date(), 'yyyy-MM-dd')}.csv`;
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);

    // Bulk export of every agent's float reconciliation at once, not
    // logged before this. Plain client-side insert so the audit_logs
    // IP-capture trigger sees the real browser IP directly. Never blocks
    // the actual download.
    (async () => {
      try {
        const { data: { user } } = await supabase.auth.getUser();
        await supabase.from('audit_logs').insert({
          user_id: user?.id ?? null,
          action_type: 'csv_exported',
          table_name: 'export',
          record_id: null,
          metadata: { filename, row_count: reconciliation.length },
        });
      } catch (e) {
        console.warn('[AgentFloatManagement] audit log insert failed:', e);
      }
    })();
  };

  return (
    <div className="space-y-4">
      <Card className="rounded-2xl">
        <CardContent className="p-5 space-y-4">
          <div>
            <h3 className="text-base font-bold">Float Reconciliation</h3>
            <p className="text-xs text-muted-foreground mt-0.5">Compare opening and closing balances per agent.</p>
          </div>
          <div className="space-y-3">
            <div>
              <Label className="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold">From Date</Label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" className={cn("w-full justify-start text-left text-sm mt-1.5 rounded-xl h-11", !dateFrom && "text-muted-foreground")}>
                    <CalendarIcon className="h-4 w-4 mr-2" />
                    {dateFrom ? format(dateFrom, 'dd MMM yyyy') : 'Select start date'}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar mode="single" selected={dateFrom} onSelect={setDateFrom} className="p-3 pointer-events-auto" />
                </PopoverContent>
              </Popover>
            </div>
            <div>
              <Label className="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold">To Date</Label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" className={cn("w-full justify-start text-left text-sm mt-1.5 rounded-xl h-11", !dateTo && "text-muted-foreground")}>
                    <CalendarIcon className="h-4 w-4 mr-2" />
                    {dateTo ? format(dateTo, 'dd MMM yyyy') : 'Select end date'}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar mode="single" selected={dateTo} onSelect={setDateTo} className="p-3 pointer-events-auto" />
                </PopoverContent>
              </Popover>
            </div>
            <div className="flex gap-2">
              <Button
                onClick={() => refetch()}
                className="flex-1 bg-gradient-to-r from-purple-600 via-purple-500 to-pink-500 hover:from-purple-700 hover:via-purple-600 hover:to-pink-600 text-white rounded-full h-11 text-xs tracking-widest uppercase font-semibold"
              >
                <Scale className="h-4 w-4 mr-2" /> Reconcile
              </Button>
              <Button variant="outline" onClick={exportCSV} disabled={reconciliation.length === 0} className="rounded-full h-11 px-5">
                <Download className="h-4 w-4 mr-1" /> CSV
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {isLoading ? (
        <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin" /></div>
      ) : reconciliation.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-6">No agents to reconcile</p>
      ) : (
        <ScrollArea className="max-h-[50vh]">
          <div className="space-y-2">
            {reconciliation.map((r: any) => {
              const hasVariance = r.expectedClosing < 0;
              return (
                <Card key={r.agent_id} className={`rounded-2xl border ${hasVariance ? 'border-destructive/50' : 'border-border/40'}`}>
                  <CardContent className="p-4">
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-3">
                        <div className="h-10 w-10 rounded-full bg-purple-100 flex items-center justify-center shrink-0">
                          <Building2 className="h-5 w-5 text-purple-600" />
                        </div>
                        <p className="font-bold text-sm">{r.name}</p>
                      </div>
                      {hasVariance && (
                        <Badge className="text-[9px] rounded-full bg-red-100 text-red-700 border-red-200">
                          <AlertTriangle className="h-3 w-3 mr-1" /> VARIANCE
                        </Badge>
                      )}
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <div className="p-2.5 rounded-xl bg-muted/50">
                        <p className="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold">Opening</p>
                        <p className="font-bold mt-0.5">{formatUGX(r.openingBalance)}</p>
                      </div>
                      <div className="p-2.5 rounded-xl bg-emerald-500/10">
                        <p className="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold">+ Received</p>
                        <p className="font-bold mt-0.5 text-emerald-600">{formatUGX(r.received)}</p>
                      </div>
                      <div className="p-2.5 rounded-xl bg-amber-500/10">
                        <p className="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold">− Executed</p>
                        <p className="font-bold mt-0.5 text-amber-600">{formatUGX(r.executed)}</p>
                      </div>
                      <div className="p-2.5 rounded-xl bg-purple-500/10">
                        <p className="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold">Expected</p>
                        <p className={`font-bold mt-0.5 ${r.expectedClosing < 0 ? 'text-destructive' : 'text-purple-600'}`}>
                          {formatUGX(r.expectedClosing)}
                        </p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}

// ─── Tab 4: All Agents Float vs Commission ───────────────────────────────────
function AllAgentsBreakdownTab() {
  const [search, setSearch] = useState('');

  const { data: agents = [], isLoading } = useQuery({
    queryKey: ['all-agents-float-commission'],
    queryFn: async () => {
      // 1. Get all agent user IDs
      const { data: roles } = await supabase
        .from('user_roles')
        .select('user_id')
        .eq('role', 'agent');
      if (!roles?.length) return [];

      const ids = roles.map(r => r.user_id);

      // 2. Fetch profiles, wallets, and ledger commission data in parallel
      const [{ data: profiles }, walletBuckets, { data: ledger }] = await Promise.all([
        supabase.from('profiles').select('id, full_name, phone').in('id', ids),
        fetchOpsWalletBuckets(ids),
        supabase
          .from('general_ledger')
          .select('user_id, amount, direction, category')
          .in('user_id', ids)
          .eq('ledger_scope', 'wallet')
          .in('category', [
            'agent_commission_earned', 'agent_commission', 'agent_bonus',
            'referral_bonus', 'proxy_investment_commission',
            'agent_commission_withdrawal', 'agent_commission_used_for_rent',
          ]),
      ]);
      const wallets = walletBuckets.map(w => ({ user_id: w.user_id, balance: w.balance }));

      const EARN_CATS = ['agent_commission_earned', 'agent_commission', 'agent_bonus', 'referral_bonus', 'proxy_investment_commission'];
      const SPEND_CATS = ['agent_commission_withdrawal', 'agent_commission_used_for_rent'];

      // Aggregate commission per agent
      const commMap: Record<string, { earned: number; spent: number }> = {};
      for (const e of (ledger || [])) {
        if (!commMap[e.user_id]) commMap[e.user_id] = { earned: 0, spent: 0 };
        const isPositive = e.direction === 'credit' || e.direction === 'cash_in';
        if (EARN_CATS.includes(e.category) && isPositive) commMap[e.user_id].earned += Number(e.amount);
        if (SPEND_CATS.includes(e.category) && !isPositive) commMap[e.user_id].spent += Number(e.amount);
      }

      const walletMap: Record<string, number> = {};
      for (const w of (wallets || [])) walletMap[w.user_id] = w.balance ?? 0;

      return (profiles || []).map(p => {
        const wallet = walletMap[p.id] ?? 0;
        const comm = commMap[p.id] ?? { earned: 0, spent: 0 };
        const commissionBalance = Math.max(0, comm.earned - comm.spent);
        const floatBalance = wallet - commissionBalance;
        return {
          id: p.id,
          name: p.full_name || 'Unknown',
          phone: p.phone || '',
          wallet,
          commissionBalance,
          floatBalance,
        };
      }).sort((a, b) => a.floatBalance - b.floatBalance);
    },
    staleTime: 60_000,
  });

  const filtered = agents.filter(a =>
    !search || a.name.toLowerCase().includes(search.toLowerCase()) || a.phone.includes(search)
  );

  const totalFloat = agents.reduce((s, a) => s + a.floatBalance, 0);
  const totalComm = agents.reduce((s, a) => s + a.commissionBalance, 0);
  const needsTopUp = agents.filter(a => a.floatBalance <= 0).length;

  return (
    <div className="space-y-3">
      {/* Summary */}
      <div className="grid grid-cols-3 gap-2">
        <div className="p-3 rounded-xl bg-primary/5 border border-primary/20 text-center">
          <p className="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold">Total Float</p>
          <p className="font-bold text-sm mt-0.5">{formatUGX(totalFloat)}</p>
        </div>
        <div className="p-3 rounded-xl bg-purple-500/5 border border-purple-500/20 text-center">
          <p className="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold">Total Comm.</p>
          <p className="font-bold text-sm mt-0.5 text-purple-600">{formatUGX(totalComm)}</p>
        </div>
        <div className="p-3 rounded-xl bg-destructive/5 border border-destructive/20 text-center">
          <p className="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold">Need Top-Up</p>
          <p className="font-bold text-sm mt-0.5 text-destructive">{needsTopUp}</p>
        </div>
      </div>

      <Input
        placeholder="Search agent name or phone…"
        value={search}
        onChange={e => setSearch(e.target.value)}
        className="rounded-xl h-10"
      />

      {isLoading ? (
        <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin" /></div>
      ) : filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-6">No agents found</p>
      ) : (
        <ScrollArea className="max-h-[55vh]">
          <div className="space-y-2">
            {filtered.map(a => (
              <Card key={a.id} className={`rounded-xl border ${
                a.floatBalance <= 0 ? 'border-destructive/40 bg-destructive/5' :
                a.floatBalance < 50000 ? 'border-amber-500/40 bg-amber-500/5' :
                'border-border/40'
              }`}>
                <CardContent className="p-3">
                  <div className="flex items-center justify-between mb-2">
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold text-sm truncate">{a.name}</p>
                      <p className="text-[11px] text-muted-foreground">{a.phone}</p>
                    </div>
                    {a.floatBalance <= 0 && (
                      <AlertTriangle className="h-4 w-4 text-destructive shrink-0" />
                    )}
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-xs">
                    <div className="p-2 rounded-lg bg-muted/50">
                      <p className="text-[9px] uppercase tracking-widest text-muted-foreground font-semibold">Wallet</p>
                      <p className="font-bold mt-0.5">{formatUGX(a.wallet)}</p>
                    </div>
                    <div className="p-2 rounded-lg bg-muted/50">
                      <p className="text-[9px] uppercase tracking-widest text-muted-foreground font-semibold">Float</p>
                      <p className={`font-bold mt-0.5 ${a.floatBalance <= 0 ? 'text-destructive' : 'text-emerald-600'}`}>
                        {formatUGX(Math.max(0, a.floatBalance))}
                      </p>
                    </div>
                    <div className="p-2 rounded-lg bg-muted/50">
                      <p className="text-[9px] uppercase tracking-widest text-muted-foreground font-semibold">Comm.</p>
                      <p className="font-bold mt-0.5 text-purple-600">{formatUGX(a.commissionBalance)}</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────
export function AgentFloatManagement() {
  return (
    <div className="space-y-5">
      <div className="px-1">
        <p className="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold">Agent Float Management</p>
        <h1 className="text-xl font-bold mt-0.5">Agent Float Management</h1>
      </div>
      <Tabs defaultValue="all-agents" className="space-y-4">
        <TabsList variant="underline" className="w-full justify-start">
          <TabsTrigger value="all-agents" variant="underline" className="text-sm font-semibold">
            All Agents
          </TabsTrigger>
          <TabsTrigger value="transfers" variant="underline" className="text-sm font-semibold">
            Transfers
          </TabsTrigger>
          <TabsTrigger value="balances" variant="underline" className="text-sm font-semibold">
            Cashout Agents
          </TabsTrigger>
          <TabsTrigger value="reconciliation" variant="underline" className="text-sm font-semibold">
            Reconciliation
          </TabsTrigger>
        </TabsList>
        <TabsContent value="all-agents"><AllAgentsBreakdownTab /></TabsContent>
        <TabsContent value="transfers"><FloatTransfersTab /></TabsContent>
        <TabsContent value="balances"><AgentFloatBalancesTab /></TabsContent>
        <TabsContent value="reconciliation"><FloatReconciliationTab /></TabsContent>
      </Tabs>
    </div>
  );
}
