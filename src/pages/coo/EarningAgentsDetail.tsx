import { useEffect, useState } from 'react';
import ScreenLoader from '@/components/common/ScreenLoader';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { roleToSlug } from '@/lib/roleRoutes';
import { supabase } from '@/integrations/supabase/client';
import COODetailLayout, { KPICard, SectionTitle } from '@/components/coo/COODetailLayout';
import COODataTable, { COOColumn } from '@/components/coo/COODataTable';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { formatUGX } from '@/lib/rentCalculations';

interface AgentRow {
  name: string;
  email: string;
  phone: string;
  totalEarned: number;
  transactions: number;
  avgPerTx: number;
  topType: string;
}

const columns: COOColumn<AgentRow>[] = [
  { key: 'name', label: 'Agent' },
  { key: 'totalEarned', label: 'Total Earned', align: 'right', render: (r) => formatUGX(r.totalEarned) },
  { key: 'transactions', label: 'Txns', align: 'right' },
  { key: 'avgPerTx', label: 'Avg / Txn', align: 'right', render: (r) => formatUGX(r.avgPerTx) },
  { key: 'topType', label: 'Top Type' },
];

const detailColumns: COOColumn<AgentRow>[] = [
  { key: 'email', label: 'Email' },
  { key: 'phone', label: 'Phone' },
];

export default function EarningAgentsDetail() {
  const { user, roles, loading, role } = useAuth();
  const navigate = useNavigate();
  const [data, setData] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (!loading && (!user || !roles.includes('manager'))) { navigate(roleToSlug(role)); return; }
    if (user && roles.includes('manager')) fetchData();
  }, [user, loading, roles]);

  async function fetchData() {
    setIsLoading(true);
    try {
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

      const [earningsRes, allAgentsRes] = await Promise.all([
        supabase.from('agent_earnings').select('agent_id, amount, earning_type, created_at').gte('created_at', sevenDaysAgo),
        supabase.from('user_roles').select('user_id', { count: 'exact', head: true }).eq('role', 'agent'),
      ]);

      const earnings = earningsRes.data || [];
      const totalAgents = allAgentsRes.count || 0;

      // Aggregate by agent
      const agentMap = new Map<string, { total: number; count: number; types: Map<string, number> }>();
      let totalRevenue = 0;
      earnings.forEach(e => {
        const existing = agentMap.get(e.agent_id) || { total: 0, count: 0, types: new Map() };
        existing.total += e.amount;
        existing.count += 1;
        existing.types.set(e.earning_type, (existing.types.get(e.earning_type) || 0) + e.amount);
        agentMap.set(e.agent_id, existing);
        totalRevenue += e.amount;
      });

      const earningAgents = agentMap.size;
      const avgPerAgent = earningAgents > 0 ? totalRevenue / earningAgents : 0;

      // Get names
      const allIds = Array.from(agentMap.keys());
      let profileMap = new Map<string, { name: string; email: string; phone: string }>();
      if (allIds.length > 0) {
        const { data: profiles } = await supabase.from('profiles').select('id, full_name, email, phone').in('id', allIds.slice(0, 50));
        profileMap = new Map((profiles || []).map(p => [p.id, { name: p.full_name, email: p.email, phone: p.phone }]));
      }

      const tableRows: AgentRow[] = Array.from(agentMap.entries())
        .map(([id, agg]) => {
          const prof = profileMap.get(id);
          const topType = Array.from(agg.types.entries()).sort((a, b) => b[1] - a[1])[0];
          return {
            name: prof?.name || id.slice(0, 8),
            email: prof?.email || '—',
            phone: prof?.phone || '—',
            totalEarned: agg.total,
            transactions: agg.count,
            avgPerTx: agg.count > 0 ? Math.round(agg.total / agg.count) : 0,
            topType: topType ? topType[0] : '—',
          };
        })
        .sort((a, b) => b.totalEarned - a.totalEarned);

      // Top 5 for chart
      const chartData = tableRows.slice(0, 5).map(a => ({ name: a.name.split(' ')[0], amount: a.totalEarned }));

      // Type breakdown
      const typeMap = new Map<string, number>();
      earnings.forEach(e => { typeMap.set(e.earning_type, (typeMap.get(e.earning_type) || 0) + e.amount); });
      const typeBreakdown = Array.from(typeMap.entries()).sort((a, b) => b[1] - a[1]);

      setData({ earningAgents, totalAgents, totalRevenue, avgPerAgent, chartData, typeBreakdown, tableRows });
    } catch (e) { console.error(e); }
    finally { setIsLoading(false); }
  }

  if (isLoading) return <ScreenLoader />;
  if (!data) return null;

  const status = data.earningAgents > 5 ? 'green' as const : data.earningAgents > 0 ? 'yellow' as const : 'red' as const;

  return (
    <COODetailLayout title="Earning Agents" subtitle="7-Day Agent Performance" status={status}>
      <div className="grid grid-cols-2 gap-3">
        <KPICard label="Earning Agents" value={data.earningAgents} status={status} />
        <KPICard label="Total Agents" value={data.totalAgents} status="green" />
        <KPICard label="Total Revenue" value={formatUGX(data.totalRevenue)} status="green" />
        <KPICard label="Avg / Agent" value={formatUGX(Math.round(data.avgPerAgent))} status="green" />
      </div>

      {data.chartData.length > 0 && (
        <>
          <SectionTitle>Top Performers</SectionTitle>
          <div className="rounded-2xl border-2 border-border/60 bg-card p-4 h-48">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data.chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="name" tick={{ fontSize: 9 }} stroke="hsl(var(--muted-foreground))" />
                <YAxis tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
                <Tooltip formatter={(v: number) => formatUGX(v)} />
                <Bar dataKey="amount" fill="hsl(var(--primary))" radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </>
      )}

      <COODataTable
        title="Agent Earnings"
        columns={columns}
        detailColumns={detailColumns}
        data={data.tableRows}
        pageSize={15}
        exportFilename="earning-agents"
      />
    </COODetailLayout>
  );
}
