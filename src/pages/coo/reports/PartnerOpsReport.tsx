import ExecutiveDashboardLayout from '@/components/layout/ExecutiveDashboardLayout';
import COOReportPage from '@/components/coo/COOReportPage';
import PartnerOpsBreakdown from '@/components/coo/PartnerOpsBreakdown';
import { usePartnerOpsReportData } from '@/components/coo/useCOOReportData';
import { PromissoryNotesHeaderButton } from '@/components/executive/partner-ops/PromissoryNotesHeaderButton';
import { usePersistedActiveTab } from '@/hooks/usePersistedActiveTab';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Handshake, UserPlus, Clock, CheckCircle2, XCircle, Wallet, Users, ArrowDownToLine } from 'lucide-react';

const ugx = (n: number) => `UGX ${new Intl.NumberFormat('en-UG').format(Math.round(n || 0))}`;

/**
 * COO → Reports → Partner Ops
 * Live data from `investor_portfolios` + `investment_withdrawal_requests`.
 */
export default function PartnerOpsReportPage() {
  const [, setActiveTab] = usePersistedActiveTab('coo');
  const { data, isLoading, refetch } = usePartnerOpsReportData();
  // Server-side aggregate. A partner = a person with one or more portfolios,
  // counted DISTINCT on investor_id straight from the database so the KPI
  // cannot drift with client paging or per-row RLS filtering.
  const { data: totals, refetch: refetchTotals } = useQuery({
    queryKey: ['partner-ops-report-totals'],
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('partner_ops_report_totals');
      if (error) throw error;
      return (data ?? {}) as Record<string, number>;
    },
  });

  const num = (key: string) => Number(totals?.[key] ?? 0);
  const activities = data?.activities ?? [];
  const trend = data?.trend ?? [];

  const k = {
    totalPartners: num('total_partners'),
    newPartners30d: num('new_partners_30d'),
    activePartners30d: num('partners_30d'),
    totalPortfolios: num('total_portfolios'),
    portfolios30d: num('portfolios_30d'),
    totalAum: num('total_aum'),
    aum30d: num('aum_30d'),
    verified: num('verified_portfolios_all'),
    verified30d: num('verified_30d'),
    pendingReview: num('pending_review_all'),
    rejected: num('rejected_all'),
    pendingWithdrawals: num('pending_withdrawals'),
    pendingWithdrawalAmt: num('pending_withdrawal_amount'),
  };

  return (
    <ExecutiveDashboardLayout role="coo" activeTab="reports-partner-ops" onTabChange={setActiveTab}>
      <COOReportPage
        title="Partner Ops Report"
        description="Live monitor of partner portfolios, CFO verifications, and supporter withdrawal requests across the last 30 days."
        icon={Handshake}
        loading={isLoading}
        onGenerate={async () => { await Promise.all([refetch(), refetchTotals()]); }}
        belowKpis={({ from, to }) => <PartnerOpsBreakdown from={from} to={to} />}
        statusOptions={['Verified', 'Pending', 'Rejected', 'pending', 'approved', 'rejected']}
        activityTypeOptions={['New portfolio', 'Withdrawal request']}
        departmentOptions={['Partner Ops', 'Financial Ops']}
        kpis={[
          { label: 'Total partners',        value: String(k.totalPartners),   sub: `${k.newPartners30d} first-time in 30d`, icon: Users, severity: 'neutral' },
          { label: 'Total portfolios',      value: String(k.totalPortfolios), sub: `${k.portfolios30d} created in 30d`, icon: UserPlus, severity: 'info' },
          { label: 'Total AUM raised',      value: ugx(k.totalAum),           sub: 'All portfolios, all time',  icon: Wallet,   severity: 'success' },
          { label: 'AUM raised (30d)',      value: ugx(k.aum30d),             sub: `${k.activePartners30d} partners funded`, icon: Wallet, severity: 'info' },
          { label: 'Pending CFO review',    value: String(k.pendingReview),   sub: 'Portfolios awaiting',       icon: Clock,    severity: 'warning', urgent: k.pendingReview > 0 },
          { label: 'Rejected portfolios',   value: String(k.rejected),        sub: 'CFO rejected',              icon: XCircle,  severity: 'destructive' },
          { label: 'Pending withdrawals',   value: String(k.pendingWithdrawals), sub: 'Awaiting Financial Ops', icon: ArrowDownToLine, severity: 'warning', urgent: k.pendingWithdrawals > 0 },
          { label: 'Pending payout (UGX)',  value: ugx(k.pendingWithdrawalAmt), sub: 'Sum across requests',     icon: Wallet,   severity: 'warning' },
          { label: 'Verified portfolios',   value: String(k.verified),        sub: `${k.verified30d} verified in 30d`, icon: CheckCircle2, severity: 'success' },
        ]}
        charts={[
          {
            kind: 'line',
            title: 'New portfolios per day (last 14 days)',
            seriesKeys: ['count'],
            data: trend,
          },
        ]}
        activities={activities}
        insights={[
          { kind: k.pendingReview > 0 ? 'pending' : 'trend', title: `${k.pendingReview} portfolios pending CFO verification`, body: 'CFO must verify the bank/MoMo proof before AUM is recognised. Long waits stall ROI accrual.' },
          { kind: k.pendingWithdrawals > 0 ? 'priority' : 'trend', title: `${k.pendingWithdrawals} supporter withdrawals awaiting payout`, body: `UGX ${new Intl.NumberFormat('en-UG').format(Math.round(k.pendingWithdrawalAmt))} parked. Confirm 90-day notice has elapsed before clearing.` },
          { kind: 'trend', title: 'AUM raised (last 30 days)', body: `UGX ${new Intl.NumberFormat('en-UG').format(Math.round(k.aum30d))} across ${k.portfolios30d} portfolios from ${k.activePartners30d} partners. All-time: UGX ${new Intl.NumberFormat('en-UG').format(Math.round(k.totalAum))} from ${k.totalPartners} partners.` },
          { kind: 'action', title: 'Reconcile rejected portfolios', body: `${k.rejected} portfolios have a CFO rejection reason — reach out to investors with corrective steps.` },
        ]}
      />
    </ExecutiveDashboardLayout>
  );
}
