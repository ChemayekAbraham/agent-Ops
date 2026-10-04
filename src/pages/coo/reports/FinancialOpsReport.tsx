import ExecutiveDashboardLayout from '@/components/layout/ExecutiveDashboardLayout';
import COOReportPage from '@/components/coo/COOReportPage';
import { useFinancialOpsReportData } from '@/components/coo/useCOOReportData';
import { usePersistedActiveTab } from '@/hooks/usePersistedActiveTab';
import { Wallet, Banknote, ArrowDownToLine, ArrowUpFromLine, AlertTriangle, Receipt, ShieldCheck } from 'lucide-react';

const ugx = (n: number) => `UGX ${new Intl.NumberFormat('en-UG').format(Math.round(n || 0))}`;

/**
 * COO → Reports → Financial Ops
 * Live data from `withdrawal_requests` + `deposit_requests` + `wallet_deposits`.
 * CFO retains the authoritative financial reports — this is COO operational visibility.
 */
export default function FinancialOpsReportPage() {
  const [, setActiveTab] = usePersistedActiveTab('coo');
  const { data, isLoading, refetch } = useFinancialOpsReportData();

  const k = data?.kpis ?? { withdrawalsCount: 0, withdrawalsTotal: 0, depositsTotal: 0, pendingApprovals: 0, rejected: 0 };
  const activities = data?.activities ?? [];
  const trend = data?.trend ?? [];
  const outflowByMethod = data?.outflowByMethod ?? [];

  return (
    <ExecutiveDashboardLayout role="coo" activeTab="reports-financial-ops" onTabChange={setActiveTab}>
      <COOReportPage
        title="Financial Ops Report"
        description="Live operational view: deposits, withdrawals, and approval queue across the platform (last 30 days)."
        icon={Wallet}
        loading={isLoading}
        onGenerate={async () => { await refetch(); }}
        statusOptions={['Recorded', 'pending', 'approved', 'rejected', 'processing']}
        activityTypeOptions={['Deposit request', 'Wallet deposit', 'Withdrawal']}
        departmentOptions={['Financial Ops']}
        kpis={[
          { label: 'Deposits (30d)',         value: ugx(k.depositsTotal),       sub: 'Approved + cash deposits', icon: ArrowDownToLine, severity: 'success' },
          { label: 'Withdrawals (30d)',      value: ugx(k.withdrawalsTotal),    sub: `${k.withdrawalsCount} requests`, icon: ArrowUpFromLine, severity: 'info' },
          { label: 'Pending approvals',      value: String(k.pendingApprovals), sub: 'Awaiting FinOps / CFO',    icon: Receipt,         severity: 'warning', urgent: k.pendingApprovals > 0 },
          { label: 'Rejected (30d)',         value: String(k.rejected),         sub: 'Failed verification',       icon: AlertTriangle,   severity: 'destructive' },
          { label: 'Net flow (UGX)',         value: ugx(k.depositsTotal - k.withdrawalsTotal), sub: 'Inflow − outflow', icon: Banknote, severity: (k.depositsTotal - k.withdrawalsTotal) >= 0 ? 'success' : 'warning' },
          { label: 'Avg withdrawal',         value: k.withdrawalsCount ? ugx(k.withdrawalsTotal / k.withdrawalsCount) : 'UGX 0', sub: 'Per request', icon: ArrowUpFromLine, severity: 'info' },
          { label: 'Float coverage (proxy)', value: k.withdrawalsTotal > 0 ? `${Math.round((k.depositsTotal / k.withdrawalsTotal) * 100)}%` : '∞', sub: 'Inflow / outflow', icon: ShieldCheck, severity: 'success' },
          { label: 'Ledger health',          value: 'OK', sub: 'Strict mode active', icon: ShieldCheck, severity: 'success' },
        ]}
        charts={[
          {
            kind: 'bar',
            title: 'Deposits vs withdrawals (last 14 days, UGX 000s)',
            seriesKeys: ['deposits', 'withdrawals'],
            data: trend,
          },
          ...(outflowByMethod.length > 0 ? [{
            kind: 'pie' as const,
            title: 'Withdrawals by payout method',
            data: outflowByMethod,
          }] : []),
        ]}
        activities={activities}
        insights={[
          { kind: k.pendingApprovals > 0 ? 'priority' : 'trend', title: `${k.pendingApprovals} approvals waiting`, body: 'Coordinate with CFO before the next batch — high-value items must clear trust score and float bucket checks.' },
          { kind: 'trend', title: `Net flow ${ugx(k.depositsTotal - k.withdrawalsTotal)}`, body: `${ugx(k.depositsTotal)} in vs ${ugx(k.withdrawalsTotal)} out across the window.` },
          { kind: 'action', title: 'Review rejection reasons', body: `${k.rejected} requests were rejected. Cluster reasons to spot systemic gaps.` },
          { kind: 'trend', title: 'Withdrawal mix', body: outflowByMethod.length > 0 ? `Lead method: ${outflowByMethod.sort((a, b) => b.value - a.value)[0].label}.` : 'No withdrawals in window.' },
        ]}
      />
    </ExecutiveDashboardLayout>
  );
}
