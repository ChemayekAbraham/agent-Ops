import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Loader2, Sparkles, ArrowRight, TrendingDown, TrendingUp, Users } from 'lucide-react';

interface SuggestedUser {
  id: string;
  full_name: string;
  phone: string;
}

interface Suggestion {
  tenant: SuggestedUser;
  currentAgent: { id: string; full_name: string } | null;
  suggestedAgent: { id: string; full_name: string; tenants: number; payRate: number };
  outstanding: number;
  payRate: number;
  rentRequestId: string;
}

interface TenantReassignmentSuggestionsProps {
  onApply: (tenant: SuggestedUser, agent: SuggestedUser) => void;
}

export function TenantReassignmentSuggestions({ onApply }: TenantReassignmentSuggestionsProps) {
  const { data, isLoading } = useQuery({
    queryKey: ['tenant-reassignment-suggestions'],
    queryFn: async () => {
      // Pull active rent requests
      const { data: requests } = await supabase
        .from('rent_requests')
        .select('id, tenant_id, agent_id, rent_amount, total_repayment, amount_repaid, status, created_at')
        .in('status', ['funded', 'disbursed', 'repaying'])
        .order('created_at', { ascending: false })
        .limit(500);

      const items = requests || [];
      if (items.length === 0) {
        return { suggestions: [] as Suggestion[], goodAgents: [] as any[], poorTenants: 0 };
      }

      // Collect ids
      const tenantIds = [...new Set(items.map(r => r.tenant_id).filter(Boolean))];
      const agentIds = [...new Set(items.map(r => r.agent_id).filter(Boolean))];

      const [profilesRes, agentsRes] = await Promise.all([
        tenantIds.length
          ? supabase.from('profiles').select('id, full_name, phone').in('id', tenantIds)
          : Promise.resolve({ data: [] as any[] }),
        agentIds.length
          ? supabase.from('profiles').select('id, full_name, phone').in('id', agentIds)
          : Promise.resolve({ data: [] as any[] }),
      ]);

      const tenantMap = new Map((profilesRes.data || []).map((p: any) => [p.id, p]));
      const agentMap = new Map((agentsRes.data || []).map((a: any) => [a.id, a]));

      // Per-agent aggregate: count of tenants and weighted repayment ratio
      const agentStats = new Map<string, {
        id: string;
        full_name: string;
        phone: string;
        tenants: Set<string>;
        totalDue: number;
        totalRepaid: number;
      }>();

      for (const r of items) {
        if (!r.agent_id) continue;
        const agentProfile = agentMap.get(r.agent_id);
        if (!agentProfile) continue;
        const stat = agentStats.get(r.agent_id) || {
          id: r.agent_id,
          full_name: (agentProfile as any).full_name || '—',
          phone: (agentProfile as any).phone || '',
          tenants: new Set<string>(),
          totalDue: 0,
          totalRepaid: 0,
        };
        stat.tenants.add(r.tenant_id);
        stat.totalDue += Number(r.total_repayment || r.rent_amount || 0);
        stat.totalRepaid += Number(r.amount_repaid || 0);
        agentStats.set(r.agent_id, stat);
      }

      const goodAgents = Array.from(agentStats.values())
        .map(a => ({
          ...a,
          tenantsCount: a.tenants.size,
          payRate: a.totalDue > 0 ? a.totalRepaid / a.totalDue : 0,
        }))
        // Good = at least 3 tenants and ≥ 70% payment ratio
        .filter(a => a.tenantsCount >= 3 && a.payRate >= 0.7)
        .sort((a, b) => (b.payRate * 1000 + b.tenantsCount) - (a.payRate * 1000 + a.tenantsCount));

      // Per-tenant aggregate
      const tenantStats = new Map<string, {
        tenant_id: string;
        agent_id: string | null;
        rent_request_id: string;
        totalDue: number;
        totalRepaid: number;
        outstanding: number;
      }>();

      for (const r of items) {
        const stat = tenantStats.get(r.tenant_id) || {
          tenant_id: r.tenant_id,
          agent_id: r.agent_id,
          rent_request_id: r.id,
          totalDue: 0,
          totalRepaid: 0,
          outstanding: 0,
        };
        stat.totalDue += Number(r.total_repayment || r.rent_amount || 0);
        stat.totalRepaid += Number(r.amount_repaid || 0);
        stat.outstanding = stat.totalDue - stat.totalRepaid;
        // Prefer the most-recent active request (items already sorted desc by created_at)
        if (!tenantStats.has(r.tenant_id)) {
          stat.agent_id = r.agent_id;
          stat.rent_request_id = r.id;
        }
        tenantStats.set(r.tenant_id, stat);
      }

      // Poor = < 40% paid AND outstanding > 0
      const poorTenants = Array.from(tenantStats.values())
        .map(t => ({ ...t, payRate: t.totalDue > 0 ? t.totalRepaid / t.totalDue : 0 }))
        .filter(t => t.payRate < 0.4 && t.outstanding > 0);

      // Build suggestions: each poor tenant paired with the best good agent
      // who is NOT already their current agent. Round-robin so we spread load.
      const suggestions: Suggestion[] = [];
      let agentIdx = 0;
      for (const t of poorTenants.sort((a, b) => a.payRate - b.payRate)) {
        if (goodAgents.length === 0) break;
        // Pick next good agent that isn't the tenant's current one
        let pick: typeof goodAgents[0] | null = null;
        for (let i = 0; i < goodAgents.length; i++) {
          const candidate = goodAgents[(agentIdx + i) % goodAgents.length];
          if (candidate.id !== t.agent_id) {
            pick = candidate;
            agentIdx = (agentIdx + i + 1) % goodAgents.length;
            break;
          }
        }
        if (!pick) continue;
        const tenantProfile = tenantMap.get(t.tenant_id);
        if (!tenantProfile) continue;
        const currentAgentProfile = t.agent_id ? agentMap.get(t.agent_id) : null;
        suggestions.push({
          tenant: {
            id: t.tenant_id,
            full_name: (tenantProfile as any).full_name || '—',
            phone: (tenantProfile as any).phone || '',
          },
          currentAgent: currentAgentProfile
            ? { id: t.agent_id!, full_name: (currentAgentProfile as any).full_name || '—' }
            : null,
          suggestedAgent: {
            id: pick.id,
            full_name: pick.full_name,
            tenants: pick.tenantsCount,
            payRate: pick.payRate,
          },
          outstanding: t.outstanding,
          payRate: t.payRate,
          rentRequestId: t.rent_request_id,
        });
      }

      return {
        suggestions: suggestions.slice(0, 25),
        goodAgents: goodAgents.slice(0, 5),
        poorTenants: poorTenants.length,
      };
    },
    staleTime: 300_000,
  });

  const suggestions = data?.suggestions || [];
  const goodAgents = data?.goodAgents || [];

  const summary = useMemo(() => {
    const totalOutstanding = suggestions.reduce((s, x) => s + x.outstanding, 0);
    return { totalOutstanding };
  }, [suggestions]);

  return (
    <Card className="border-amber-500/30 bg-amber-500/5">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-amber-600" />
          Suggested Reassignments
          <Badge variant="outline" className="ml-auto text-[10px] border-amber-500/40">
            Auto-pairing
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Tenants paying poorly (under 40% repaid) paired with top agents
          (≥3 tenants and ≥70% collection rate). Click a row to load it into the linker above.
        </p>

        {isLoading && (
          <div className="flex justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        )}

        {!isLoading && suggestions.length === 0 && (
          <div className="rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">
            No reassignment suggestions right now — either no poor-paying tenants
            or no qualifying high-performing agents available.
          </div>
        )}

        {!isLoading && goodAgents.length > 0 && (
          <div className="rounded-md border bg-background/60 p-2">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1.5 flex items-center gap-1">
              <TrendingUp className="h-3 w-3 text-emerald-600" />
              Top performing agents
            </p>
            <div className="flex flex-wrap gap-1.5">
              {goodAgents.map(a => (
                <Badge
                  key={a.id}
                  variant="outline"
                  className="text-[10px] border-emerald-500/40 text-emerald-700 dark:text-emerald-400"
                >
                  <Users className="h-2.5 w-2.5 mr-1" />
                  {a.full_name} · {a.tenantsCount} tenants · {Math.round(a.payRate * 100)}%
                </Badge>
              ))}
            </div>
          </div>
        )}

        {!isLoading && suggestions.length > 0 && (
          <>
            <div className="grid grid-cols-3 gap-2">
              <div className="rounded-md border bg-background/60 p-2 text-center">
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Suggestions</p>
                <p className="text-lg font-bold text-amber-600">{suggestions.length}</p>
              </div>
              <div className="rounded-md border bg-background/60 p-2 text-center">
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Good agents</p>
                <p className="text-lg font-bold text-emerald-600">{goodAgents.length}</p>
              </div>
              <div className="rounded-md border bg-background/60 p-2 text-center">
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Outstanding</p>
                <p className="text-sm font-bold">UGX {summary.totalOutstanding.toLocaleString()}</p>
              </div>
            </div>

            <div className="rounded-md border overflow-hidden bg-background">
              <div className="grid grid-cols-[1.2fr_1fr_1fr_auto] gap-2 px-2 py-1.5 bg-muted/50 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                <span>Tenant</span>
                <span>Current Agent</span>
                <span>Suggested Agent</span>
                <span className="text-right">Action</span>
              </div>
              <div className="max-h-72 overflow-y-auto divide-y">
                {suggestions.map((s) => (
                  <div
                    key={s.tenant.id + s.suggestedAgent.id}
                    className="grid grid-cols-[1.2fr_1fr_1fr_auto] gap-2 px-2 py-2 text-xs items-center"
                  >
                    <div className="min-w-0">
                      <p className="font-medium truncate" title={s.tenant.full_name}>
                        {s.tenant.full_name}
                      </p>
                      <p className="text-[10px] text-muted-foreground flex items-center gap-1">
                        <TrendingDown className="h-2.5 w-2.5 text-destructive" />
                        {Math.round(s.payRate * 100)}% paid · UGX {s.outstanding.toLocaleString()} due
                      </p>
                    </div>
                    <p className="text-muted-foreground truncate" title={s.currentAgent?.full_name || 'Unassigned'}>
                      {s.currentAgent?.full_name || (
                        <span className="italic">Unassigned</span>
                      )}
                    </p>
                    <div className="min-w-0">
                      <p className="font-medium text-emerald-700 dark:text-emerald-400 truncate" title={s.suggestedAgent.full_name}>
                        {s.suggestedAgent.full_name}
                      </p>
                      <p className="text-[10px] text-muted-foreground">
                        {s.suggestedAgent.tenants} tenants · {Math.round(s.suggestedAgent.payRate * 100)}%
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-[11px] gap-1"
                      onClick={() =>
                        onApply(
                          s.tenant,
                          {
                            id: s.suggestedAgent.id,
                            full_name: s.suggestedAgent.full_name,
                            phone: '',
                          },
                        )
                      }
                    >
                      Use
                      <ArrowRight className="h-3 w-3" />
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}