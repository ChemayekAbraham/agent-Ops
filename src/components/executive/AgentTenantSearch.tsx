import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Search, Loader2, Users, User, Phone, ChevronRight, ArrowLeft, Wallet, AlertTriangle, Share2, Home } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { generateAgentTenantPdf } from '@/lib/generateAgentTenantPdf';
import { UserDrilldownDrawer } from '@/components/ops/UserDrilldownDrawer';

interface AgentResult {
  id: string;
  full_name: string;
  phone: string;
  tenant_count: number;
}

interface TenantEntry {
  tenant_id: string;
  tenant_name: string;
  tenant_phone: string;
  rent_request_id: string;
  status: string;
  rent_amount: number;
  daily_repayment: number;
  amount_repaid: number;
  total_repayment: number;
  outstanding: number;
  wallet_balance: number;
  landlord_id: string | null;
  landlord_name: string | null;
  landlord_phone: string | null;
}

export function AgentTenantSearch() {
  const [query, setQuery] = useState('');
  const [agents, setAgents] = useState<AgentResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState<AgentResult | null>(null);
  const [sharing, setSharing] = useState(false);
  const [drilldown, setDrilldown] = useState<{
    tenantId: string | null;
    agentId: string | null;
    landlordId: string | null;
    tab?: 'tenant' | 'agent' | 'landlord';
  } | null>(null);

  const handleSharePdf = async () => {
    if (!selectedAgent || !tenants || tenants.length === 0) return;
    setSharing(true);
    try {
      const blob = generateAgentTenantPdf(selectedAgent, tenants);
      const fileName = `${selectedAgent.full_name.replace(/\s+/g, '_')}_tenants_${new Date().toISOString().slice(0, 10)}.pdf`;
      const file = new File([blob], fileName, { type: 'application/pdf' });

      // Try native share (works on mobile / WhatsApp)
      if (navigator.share && navigator.canShare?.({ files: [file] })) {
        await navigator.share({
          title: `Tenant Balances - ${selectedAgent.full_name}`,
          text: `Tenant due balances report for agent ${selectedAgent.full_name} (${tenants.length} tenants)`,
          files: [file],
        });
        toast.success('Report shared!');
      } else {
        // Fallback: download PDF then prompt WhatsApp
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        a.click();
        URL.revokeObjectURL(url);

        // Build WhatsApp text summary
        const totalDue = tenants.reduce((s, t) => s + t.outstanding, 0);
        const msg = encodeURIComponent(
          `*Welile Tenant Balances Report*\nAgent: ${selectedAgent.full_name}\nTenants: ${tenants.length}\nTotal Due: UGX ${totalDue.toLocaleString()}\n\n_PDF downloaded — please attach and send._`
        );
        window.open(`https://wa.me/?text=${msg}`, '_blank');
        toast.success('PDF downloaded! Attach it in WhatsApp.');
      }
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        toast.error('Failed to share report');
      }
    } finally {
      setSharing(false);
    }
  };

  // Debounced search for agents
  useEffect(() => {
    if (query.length < 2) { setAgents([]); setSearched(false); return; }
    const timer = setTimeout(async () => {
      setSearching(true);
      setSearched(true);
      try {
        // Find agents matching name or phone
        const cleaned = query.replace(/\D/g, '');
        const isPhone = cleaned.length >= 3;

        let profileQ = supabase.from('profiles').select('id, full_name, phone').limit(50);
        if (isPhone) {
          profileQ = profileQ.ilike('phone', `%${cleaned.slice(-9)}%`);
        } else {
          profileQ = profileQ.ilike('full_name', `%${query}%`);
        }
        const { data: profiles } = await profileQ;
        if (!profiles || profiles.length === 0) { setAgents([]); setSearching(false); return; }

        // Filter to only agent role users
        const ids = profiles.map(p => p.id);
        const { data: roleData } = await supabase
          .from('user_roles')
          .select('user_id')
          .eq('role', 'agent' as any)
          .eq('enabled', true)
          .in('user_id', ids);

        const agentIds = new Set(roleData?.map(r => r.user_id) || []);
        const agentProfiles = profiles.filter(p => agentIds.has(p.id));
        if (agentProfiles.length === 0) { setAgents([]); setSearching(false); return; }

        // Count tenants per agent from active rent_requests
        const agentIdList = agentProfiles.map(a => a.id);
        const { data: rrData } = await supabase
          .from('rent_requests')
          .select('agent_id, tenant_id')
          .in('agent_id', agentIdList)
          .in('status', ['funded', 'disbursed', 'repaying', 'approved', 'tenant_ops_approved', 'agent_verified', 'landlord_ops_approved', 'partner_ops_approved', 'coo_approved']);

        const countMap = new Map<string, Set<string>>();
        rrData?.forEach(r => {
          if (!countMap.has(r.agent_id)) countMap.set(r.agent_id, new Set());
          countMap.get(r.agent_id)!.add(r.tenant_id);
        });

        setAgents(agentProfiles.map(a => ({
          id: a.id,
          full_name: a.full_name || '—',
          phone: a.phone || '—',
          tenant_count: countMap.get(a.id)?.size || 0,
        })).sort((a, b) => b.tenant_count - a.tenant_count));
      } catch (err) {
        console.error('Agent search error:', err);
      }
      setSearching(false);
    }, 350);
    return () => clearTimeout(timer);
  }, [query]);

  // Fetch tenants for selected agent
  const { data: tenants, isLoading: loadingTenants } = useQuery({
    queryKey: ['agent-tenants', selectedAgent?.id],
    enabled: !!selectedAgent,
    queryFn: async () => {
      // Paginated: a hard limit(200) hid tenants of high-volume agents.
      const rrs: any[] = [];
      const page = 1000;
      for (let from = 0; ; from += page) {
        const { data, error } = await supabase
          .from('rent_requests')
          .select('id, tenant_id, landlord_id, status, rent_amount, daily_repayment, amount_repaid, total_repayment, agent_id')
          .eq('agent_id', selectedAgent!.id)
          .in('status', ['funded', 'disbursed', 'repaying', 'approved', 'tenant_ops_approved', 'agent_verified', 'landlord_ops_approved', 'partner_ops_approved', 'coo_approved'])
          .order('created_at', { ascending: false })
          .range(from, from + page - 1);
        if (error) throw error;
        rrs.push(...(data || []));
        if (!data || data.length < page) break;
      }

      if (!rrs || rrs.length === 0) return [];

      const tenantIds = [...new Set(rrs.map(r => r.tenant_id))];
      const landlordIds = Array.from(new Set(rrs.map(r => r.landlord_id).filter(Boolean)));

      // Batched: a hard slice(0, 100) left later tenants nameless, wallet-less
      // and with a UGX 0 due balance.
      const chunkIds = (list: string[], size = 300): string[][] => {
        const out: string[][] = [];
        for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
        return out;
      };
      const batches = chunkIds(tenantIds);
      const [profilesRes, walletsRes, landlordsRes, ledgerRes] = await Promise.all([
        Promise.all(batches.map(ids => supabase.from('profiles').select('id, full_name, phone').in('id', ids)))
          .then(res => ({ data: res.flatMap(r => r.data || []) })),
        Promise.all(batches.map(ids => supabase.from('wallets').select('user_id, balance').in('user_id', ids)))
          .then(res => ({ data: res.flatMap(r => r.data || []) })),
        landlordIds.length
          ? supabase.from('landlords').select('id, name, phone').in('id', landlordIds as any)
          : Promise.resolve({ data: [] as any[] }),
        Promise.all(batches.map(ids => supabase.from('general_ledger')
          .select('user_id, category, direction, amount')
          .in('user_id', ids)
          .in('category', ['rent_obligation', 'tenant_repayment', 'tenant_repayment_collected', 'rent_repayment'])))
          .then(res => ({ data: res.flatMap(r => r.data || []) })),
      ]);

      const profileMap = new Map((profilesRes.data || []).map(p => [p.id, p]));
      const walletMap = new Map((walletsRes.data || []).map(w => [w.user_id, Number(w.balance)]));
      const landlordMap = new Map((landlordsRes.data || []).map((l: any) => [l.id, l]));

      // Outstanding: prefer ledger-derived (rent_obligation - repayments) when present,
      // otherwise fall back to rent_requests (total_repayment - amount_repaid) summed
      // across all active plans for that tenant. Ledger coverage is sparse today, so
      // the fallback ensures the Due Balance column never silently shows UGX 0.
      const ledgerOutstanding = new Map<string, number>();
      const ledgerHasObligation = new Set<string>();
      for (const tid of tenantIds) ledgerOutstanding.set(tid, 0);
      for (const r of (ledgerRes.data || []) as any[]) {
        if (!r.user_id) continue;
        const amt = Number(r.amount || 0);
        const cur = ledgerOutstanding.get(r.user_id) || 0;
        if (r.category === 'rent_obligation' && r.direction === 'cash_out') {
          ledgerOutstanding.set(r.user_id, cur + amt);
          ledgerHasObligation.add(r.user_id);
        } else if (r.direction === 'cash_in') {
          ledgerOutstanding.set(r.user_id, cur - amt);
        }
      }

      const rrOutstanding = new Map<string, number>();
      for (const r of rrs) {
        const due = Math.max(0, Number(r.rent_amount || 0) - Number(r.amount_repaid || 0));
        rrOutstanding.set(r.tenant_id, (rrOutstanding.get(r.tenant_id) || 0) + due);
      }

      const outstandingByTenant = new Map<string, number>();
      for (const tid of tenantIds) {
        const fromLedger = Math.max(0, ledgerOutstanding.get(tid) || 0);
        const fromRr = rrOutstanding.get(tid) || 0;
        // Use the ledger figure when the tenant actually has a booked obligation;
        // otherwise fall back to the rent_request math so the column reflects real debt.
        outstandingByTenant.set(tid, ledgerHasObligation.has(tid) ? fromLedger : fromRr);
      }

      // Deduplicate by tenant - show the most recent active request
      const seen = new Set<string>();
      const results: TenantEntry[] = [];
      for (const r of rrs) {
        if (seen.has(r.tenant_id)) continue;
        seen.add(r.tenant_id);
        const p = profileMap.get(r.tenant_id);
        const l = r.landlord_id ? landlordMap.get(r.landlord_id) : null;
        results.push({
          tenant_id: r.tenant_id,
          tenant_name: p?.full_name || '—',
          tenant_phone: p?.phone || '—',
          rent_request_id: r.id,
          status: r.status,
          rent_amount: Number(r.rent_amount || 0),
          daily_repayment: Number(r.daily_repayment || 0),
          amount_repaid: Number(r.amount_repaid || 0),
          total_repayment: Number(r.total_repayment || 0),
          outstanding: Math.max(0, outstandingByTenant.get(r.tenant_id) || 0),
          wallet_balance: walletMap.get(r.tenant_id) || 0,
          landlord_id: r.landlord_id ?? null,
          landlord_name: l?.name ?? null,
          landlord_phone: l?.phone ?? null,
        });
      }
      return results.sort((a, b) => b.outstanding - a.outstanding);
    },
  });

  if (selectedAgent) {
    return (
      <div className="space-y-3">
        {/* Agent header */}
        <Card className="border-primary/20 bg-primary/5">
          <CardContent className="p-3">
            <div className="flex items-center gap-3">
              <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={() => setSelectedAgent(null)}>
                <ArrowLeft className="h-4 w-4" />
              </Button>
              <div className="flex-1 min-w-0">
                <p className="font-bold text-sm truncate">{selectedAgent.full_name}</p>
                <a href={`tel:${selectedAgent.phone}`} className="text-xs text-primary font-mono">{selectedAgent.phone}</a>
              </div>
              <Badge className="bg-primary/15 text-primary border-primary/30 gap-1">
                <Users className="h-3 w-3" />
                {selectedAgent.tenant_count} tenants
              </Badge>
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5 shrink-0"
                onClick={handleSharePdf}
                disabled={sharing || loadingTenants || !tenants?.length}
              >
                {sharing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Share2 className="h-3.5 w-3.5" />}
                <span className="hidden sm:inline">Share</span>
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Tenant list */}
        {loadingTenants && (
          <div className="flex justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        )}

        {!loadingTenants && (!tenants || tenants.length === 0) && (
          <Card className="border-dashed">
            <CardContent className="p-6 text-center text-sm text-muted-foreground">
              No active tenants found for this agent
            </CardContent>
          </Card>
        )}

        {tenants?.map((t) => (
          <Card
            key={t.rent_request_id}
            className="border hover:shadow-md transition-shadow cursor-pointer active:bg-muted/40"
            onClick={() =>
              setDrilldown({
                tenantId: t.tenant_id,
                agentId: selectedAgent!.id,
                landlordId: t.landlord_id,
                tab: 'tenant',
              })
            }
            title="Tap to view full profile, balances & landlord"
          >
            <CardContent className="p-3 space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  <User className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <p className="font-semibold text-sm truncate">{t.tenant_name}</p>
                </div>
                <Badge variant="outline" className="text-[10px] capitalize shrink-0">
                  {t.status.replace(/_/g, ' ')}
                </Badge>
              </div>

              <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <a href={`tel:${t.tenant_phone}`} className="flex items-center gap-1.5 text-primary font-mono" onClick={(e) => e.stopPropagation()}>
                  <Phone className="h-3 w-3" />
                  {t.tenant_phone}
                </a>
                {t.landlord_name && (
                  <span className="flex items-center gap-1">
                    <Home className="h-3 w-3" />
                    {t.landlord_name}
                  </span>
                )}
              </div>

              <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                <div>
                  <span className="text-muted-foreground">Rent:</span>{' '}
                  <span className="font-semibold">UGX {t.rent_amount.toLocaleString()}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Daily:</span>{' '}
                  <span className="font-medium">UGX {t.daily_repayment.toLocaleString()}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Repaid:</span>{' '}
                  <span className="font-medium text-emerald-600">UGX {t.amount_repaid.toLocaleString()}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Due:</span>{' '}
                  <span className={cn("font-bold", t.outstanding > 0 ? "text-destructive" : "text-emerald-600")}>
                    UGX {t.outstanding.toLocaleString()}
                  </span>
                </div>
              </div>

              <div className="flex items-center justify-between pt-1.5 border-t">
                <div className="flex items-center gap-1.5 text-xs">
                  <Wallet className="h-3 w-3 text-muted-foreground" />
                  <span className="text-muted-foreground">Wallet:</span>
                  <span className={cn("font-bold", t.wallet_balance > 0 ? "text-emerald-600" : "text-destructive")}>
                    UGX {t.wallet_balance.toLocaleString()}
                  </span>
                </div>
                <div className="flex items-center gap-1">
                  {t.outstanding > 0 && t.wallet_balance <= 0 && (
                    <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
                  )}
                  <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                </div>
              </div>
            </CardContent>
          </Card>
        ))}

        <UserDrilldownDrawer
          key={drilldown ? `${drilldown.agentId ?? ''}-${drilldown.tenantId ?? ''}-${drilldown.landlordId ?? ''}-${drilldown.tab ?? 'tenant'}` : 'closed'}
          open={!!drilldown}
          onOpenChange={(o) => !o && setDrilldown(null)}
          tenantId={drilldown?.tenantId ?? null}
          agentId={drilldown?.agentId ?? null}
          landlordId={drilldown?.landlordId ?? null}
          defaultTab={drilldown?.tab ?? 'tenant'}
        />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <Card className="border-primary/20 bg-gradient-to-br from-primary/5 to-primary/[0.02]">
        <CardContent className="p-4 space-y-3">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-lg bg-primary/15">
              <Users className="h-4 w-4 text-primary" />
            </div>
            <div>
              <p className="font-semibold text-sm">Search by Agent</p>
              <p className="text-[10px] text-muted-foreground">Find tenants through their assigned agent</p>
            </div>
          </div>

          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Agent name or phone..."
              value={query}
              onChange={e => setQuery(e.target.value)}
              className="pl-9 h-10"
            />
            {searching && <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-muted-foreground" />}
          </div>
        </CardContent>
      </Card>

      {/* Agent results */}
      {!searching && searched && agents.length === 0 && (
        <Card className="border-dashed">
          <CardContent className="p-4 text-center text-sm text-muted-foreground">
            No agents found matching "{query}"
          </CardContent>
        </Card>
      )}

      {agents.map(agent => (
        <Card
          key={agent.id}
          className="border hover:shadow-md transition-shadow cursor-pointer active:bg-muted/40"
          onClick={() => setSelectedAgent(agent)}
        >
          <CardContent className="p-3 flex items-center gap-3">
            <div className="p-2 rounded-full bg-primary/10 shrink-0">
              <User className="h-4 w-4 text-primary" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-sm truncate">{agent.full_name}</p>
              <p className="text-xs text-muted-foreground font-mono">{agent.phone}</p>
            </div>
            <Badge variant="outline" className="gap-1 shrink-0">
              <Users className="h-3 w-3" />
              {agent.tenant_count}
            </Badge>
            <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
