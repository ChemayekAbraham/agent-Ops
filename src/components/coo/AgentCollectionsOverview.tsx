import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { CompactAmount } from '@/components/ui/CompactAmount';
import { Loader2, Users, TrendingUp, Wallet, Banknote, Activity, Home, UserCheck } from 'lucide-react';
import { startOfDay, startOfWeek, startOfMonth } from 'date-fns';

interface AgentSummary {
  agentId: string;
  agentName: string;
  todayAmount: number;
  weekAmount: number;
  monthAmount: number;
  totalAmount: number;
  tenantCollections: number;
  landlordPayouts: number;
}

export default function AgentCollectionsOverview() {
  const [period, setPeriod] = useState<'7d' | '30d' | '90d'>('30d');

  const todayISO = startOfDay(new Date()).toISOString();
  const weekISO = startOfWeek(new Date(), { weekStartsOn: 1 }).toISOString();
  const monthISO = startOfMonth(new Date()).toISOString();

  const { data, isLoading } = useQuery({
    queryKey: ['coo-agent-collections-kpis-v4', period],
    queryFn: async () => {
      const [collectionsRes, landlordPayoutsRes, assignmentsRes, subagentsRes] = await Promise.all([
        supabase.from('agent_collections').select('agent_id, amount, created_at').is('reversed_at', null),
        supabase.from('agent_landlord_payouts').select('agent_id, amount, created_at, status')
          .in('status', ['completed', 'delivered', 'approved', 'pending']),
        supabase.from('agent_landlord_assignments').select('agent_id').eq('status', 'active'),
        supabase.from('agent_subagents').select('parent_agent_id, sub_agent_id').eq('status', 'approved'),
      ]);

      const collections = collectionsRes.data || [];
      const landlordPayouts = landlordPayoutsRes.data || [];
      const assignments = assignmentsRes.data || [];
      const subagents = subagentsRes.data || [];

      const agentIdSet = new Set<string>();
      collections.forEach(c => agentIdSet.add(c.agent_id));
      landlordPayouts.forEach(p => { if (p.agent_id) agentIdSet.add(p.agent_id); });
      assignments.forEach(a => agentIdSet.add(a.agent_id));
      subagents.forEach(s => { agentIdSet.add(s.parent_agent_id); agentIdSet.add(s.sub_agent_id); });

      const activeAgentIds = [...agentIdSet];

      if (activeAgentIds.length === 0) {
        return { kpis: { totalToday: 0, totalMonth: 0, totalAll: 0, activeAgents: 0, activeCollecting: 0, avgPerAgent: 0, topAgent: '—', tenantCollTotal: 0, landlordPayTotal: 0 } };
      }

      const profilesRes = await supabase.from('profiles').select('id, full_name').in('id', activeAgentIds);
      const profileMap = new Map((profilesRes.data || []).map(p => [p.id, p.full_name || 'Unknown Agent']));

      const agentMap = new Map<string, AgentSummary>();
      for (const id of activeAgentIds) {
        agentMap.set(id, {
          agentId: id,
          agentName: profileMap.get(id) || 'Unknown Agent',
          todayAmount: 0,
          weekAmount: 0,
          monthAmount: 0,
          totalAmount: 0,
          tenantCollections: 0,
          landlordPayouts: 0,
        });
      }

      for (const c of collections) {
        const agent = agentMap.get(c.agent_id);
        if (!agent) continue;
        const d = c.created_at;
        agent.totalAmount += c.amount;
        agent.tenantCollections += c.amount;
        if (d >= monthISO) agent.monthAmount += c.amount;
        if (d >= weekISO) agent.weekAmount += c.amount;
        if (d >= todayISO) agent.todayAmount += c.amount;
      }

      for (const p of landlordPayouts) {
        if (!p.agent_id) continue;
        const agent = agentMap.get(p.agent_id);
        if (!agent) continue;
        const d = p.created_at;
        agent.totalAmount += p.amount;
        agent.landlordPayouts += p.amount;
        if (d >= monthISO) agent.monthAmount += p.amount;
        if (d >= weekISO) agent.weekAmount += p.amount;
        if (d >= todayISO) agent.todayAmount += p.amount;
      }

      const agents = [...agentMap.values()];
      const totalToday = agents.reduce((s, a) => s + a.todayAmount, 0);
      const totalMonth = agents.reduce((s, a) => s + a.monthAmount, 0);
      const totalAll = agents.reduce((s, a) => s + a.totalAmount, 0);
      const tenantCollTotal = agents.reduce((s, a) => s + a.tenantCollections, 0);
      const landlordPayTotal = agents.reduce((s, a) => s + a.landlordPayouts, 0);
      const activeWithCollections = agents.filter(a => a.tenantCollections > 0 || a.landlordPayouts > 0).length;
      const topAgent = [...agents].sort((a, b) => b.monthAmount - a.monthAmount)[0]?.agentName || '—';

      return {
        kpis: {
          totalToday,
          totalMonth,
          totalAll,
          activeAgents: activeAgentIds.length,
          activeCollecting: activeWithCollections,
          avgPerAgent: activeWithCollections > 0 ? Math.round(totalMonth / activeWithCollections) : 0,
          topAgent,
          tenantCollTotal,
          landlordPayTotal,
        },
      };
    },
    staleTime: 5 * 60 * 1000,
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  const kpis = data?.kpis;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold flex items-center gap-2">
          <Activity className="h-5 w-5 text-primary" />
          Agent Collections Dashboard
        </h2>
        <Select value={period} onValueChange={(v: '7d' | '30d' | '90d') => setPeriod(v)}>
          <SelectTrigger className="w-[130px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="7d">Last 7 days</SelectItem>
            <SelectItem value="30d">Last 30 days</SelectItem>
            <SelectItem value="90d">Last 90 days</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <Card className="border-l-4 border-l-primary">
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground flex items-center gap-1">
              <Banknote className="h-3 w-3" /> Today
            </p>
            <p className="text-xl font-bold text-primary mt-1">
              <CompactAmount value={kpis?.totalToday || 0} />
            </p>
          </CardContent>
        </Card>
        <Card className="border-l-4 border-l-accent">
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground flex items-center gap-1">
              <TrendingUp className="h-3 w-3" /> This Month
            </p>
            <p className="text-xl font-bold mt-1">
              <CompactAmount value={kpis?.totalMonth || 0} />
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground flex items-center gap-1">
              <UserCheck className="h-3 w-3" /> Tenant Collections
            </p>
            <p className="text-xl font-bold mt-1">
              <CompactAmount value={kpis?.tenantCollTotal || 0} />
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground flex items-center gap-1">
              <Home className="h-3 w-3" /> Landlord Payouts
            </p>
            <p className="text-xl font-bold mt-1">
              <CompactAmount value={kpis?.landlordPayTotal || 0} />
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground flex items-center gap-1">
              <Users className="h-3 w-3" /> Active Agents
            </p>
            <p className="text-xl font-bold mt-1">{kpis?.activeAgents || 0}</p>
            <p className="text-[10px] text-muted-foreground">{kpis?.activeCollecting || 0} collecting</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground flex items-center gap-1">
              <Wallet className="h-3 w-3" /> Avg/Agent
            </p>
            <p className="text-xl font-bold mt-1">
              <CompactAmount value={kpis?.avgPerAgent || 0} />
            </p>
            <p className="text-[10px] text-muted-foreground truncate">Top: {kpis?.topAgent}</p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
