import ExecutiveDashboardLayout from '@/components/layout/ExecutiveDashboardLayout';
import COOReportPage from '@/components/coo/COOReportPage';
import { useAgentOpsReportData } from '@/components/coo/useCOOReportData';
import { usePersistedActiveTab } from '@/hooks/usePersistedActiveTab';
import { Users, Clock, Wallet, Banknote, TrendingUp, ShieldCheck } from 'lucide-react';

const ugx = (n: number) => `UGX ${new Intl.NumberFormat('en-UG').format(Math.round(n || 0))}`;

/**
 * COO → Reports → Agent Ops
 * Live data from `agent_collections` + `agent_advance_requests` + `wallet_deposits`.
 */
export default function AgentOpsReportPage() {
  const [, setActiveTab] = usePersistedActiveTab('coo');
  const { data, isLoading, refetch } = useAgentOpsReportData();

  const k = data?.kpis ?? { collectionsCount: 0, collectionsTotal: 0, depositsCount: 0, depositsTotal: 0, advancesPending: 0, advancesApproved: 0, uniqueAgents: 0 };
  const activities = data?.activities ?? [];
  const trend = data?.trend ?? [];
  const topAgents = data?.topAgents ?? [];

  return (
    <ExecutiveDashboardLayout role="coo" activeTab="reports-agent-ops" onTabChange={setActiveTab}>
      <COOReportPage
        title="Agent Ops Report"
        description="Live agent activity: rent collections, wallet deposits, and credit advance requests across the last 30 days."
        icon={Users}
        loading={isLoading}
        onGenerate={async () => { await refetch(); }}
        statusOptions={['Recorded', 'pending', 'approved', 'rejected']}
        activityTypeOptions={['Rent collection', 'Wallet deposit', 'Advance request']}
        departmentOptions={['Agent Ops']}
        kpis={[
          { label: 'Active agents (30d)',   value: String(k.uniqueAgents),     sub: 'Recorded a collection',  icon: Users,        severity: 'info' },
          { label: 'Rent collections',      value: String(k.collectionsCount), sub: 'Last 30 days',            icon: TrendingUp,   severity: 'success' },
          { label: 'Collected volume',      value: ugx(k.collectionsTotal),    sub: 'Total rent collected',    icon: Banknote,     severity: 'success' },
          { label: 'Wallet deposits',       value: String(k.depositsCount),    sub: ugx(k.depositsTotal),      icon: Wallet,       severity: 'neutral' },
          { label: 'Advances pending',      value: String(k.advancesPending),  sub: 'Awaiting Agent Ops',      icon: Clock,        severity: 'warning', urgent: k.advancesPending > 0 },
          { label: 'Advances approved',     value: String(k.advancesApproved), sub: 'Last 30 days',            icon: ShieldCheck,  severity: 'success' },
          { label: 'Avg per active agent',  value: k.uniqueAgents ? ugx(k.collectionsTotal / k.uniqueAgents) : 'UGX 0', sub: 'Collection avg.', icon: Banknote, severity: 'info' },
          { label: 'Trust signals',         value: String(k.collectionsCount + k.depositsCount), sub: 'Field actions emitted', icon: ShieldCheck, severity: 'success' },
        ]}
        charts={[
          {
            kind: 'bar',
            title: 'Daily rent collections (last 14 days)',
            seriesKeys: ['count'],
            data: trend,
          },
          ...(topAgents.length > 0 ? [{
            kind: 'pie' as const,
            title: 'Top agents by collected volume',
            data: topAgents,
          }] : []),
        ]}
        activities={activities}
        insights={[
          { kind: k.advancesPending > 0 ? 'pending' : 'trend', title: `${k.advancesPending} advance requests pending approval`, body: 'Agent Ops must triage these before they block field operations. SLA target is 4h.' },
          { kind: 'trend', title: `${k.collectionsCount} collections recorded`, body: `Total volume ${ugx(k.collectionsTotal)} across ${k.uniqueAgents} active agents.` },
          { kind: 'action', title: 'Compare top performers', body: topAgents.length > 0 ? `Lead: ${topAgents[0].label} (${ugx(topAgents[0].value)} collected).` : 'Not enough data in window.' },
          { kind: 'trend', title: `${k.depositsCount} wallet deposits facilitated`, body: `Field deposits totalling ${ugx(k.depositsTotal)}. Confirm float coverage before tomorrow's runs.` },
        ]}
      />
    </ExecutiveDashboardLayout>
  );
}
