import { useEffect, useState } from 'react';
import ScreenLoader from '@/components/common/ScreenLoader';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { roleToSlug } from '@/lib/roleRoutes';
import { supabase } from '@/integrations/supabase/client';
import COODetailLayout, { KPICard, SectionTitle } from '@/components/coo/COODetailLayout';
import COODataTable, { COOColumn } from '@/components/coo/COODataTable';
import { formatUGX } from '@/lib/rentCalculations';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';

type HealthStatus = 'green' | 'yellow' | 'red';

interface ObligationRow {
  tenant: string;
  rentAmount: number;
  totalRepayment: number;
  amountRepaid: number;
  outstanding: number;
  progress: string;
  status: string;
}

const columns: COOColumn<ObligationRow>[] = [
  { key: 'tenant', label: 'Tenant' },
  { key: 'rentAmount', label: 'Rent', align: 'right', render: (r) => formatUGX(r.rentAmount) },
  { key: 'totalRepayment', label: 'Total Due', align: 'right', render: (r) => formatUGX(r.totalRepayment) },
  { key: 'amountRepaid', label: 'Repaid', align: 'right', render: (r) => formatUGX(r.amountRepaid) },
  { key: 'outstanding', label: 'Outstanding', align: 'right', render: (r) => formatUGX(r.outstanding) },
  { key: 'progress', label: 'Progress', align: 'right' },
  { key: 'status', label: 'Risk', render: (r) => (
    <span className={r.status === 'High' ? 'text-red-600 font-bold' : r.status === 'Medium' ? 'text-amber-600 font-semibold' : 'text-emerald-600 font-semibold'}>
      {r.status}
    </span>
  )},
];

export default function RentCoverageDetail() {
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
      const [activeRes, repaymentRes] = await Promise.all([
        supabase.from('rent_requests').select('id, tenant_id, total_repayment, amount_repaid, rent_amount, access_fee, request_fee, funded_at, status')
          .in('status', ['funded', 'approved'])
          .order('created_at', { ascending: false }),
        supabase.from('repayments').select('amount, created_at').order('created_at', { ascending: true }),
      ]);

      const active = activeRes.data || [];
      const repayments = repaymentRes.data || [];

      const totalObligations = active.reduce((s, r) => s + (r.total_repayment || 0), 0);
      const totalRepaid = active.reduce((s, r) => s + (r.amount_repaid || 0), 0);
      const outstanding = totalObligations - totalRepaid;
      const totalFees = active.reduce((s, r) => s + (r.access_fee || 0) + (r.request_fee || 0), 0);
      const coverageRatio = totalObligations > 0 ? (totalRepaid / totalObligations) : 1;

      let coverageStatus: HealthStatus = 'green';
      let coverageLabel = 'Safe';
      if (coverageRatio < 0.3) { coverageStatus = 'red'; coverageLabel = 'Dangerous'; }
      else if (coverageRatio < 0.6) { coverageStatus = 'yellow'; coverageLabel = 'Tight'; }

      // Repayment trend
      const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
      const dailyMap = new Map<string, number>();
      repayments.filter(r => new Date(r.created_at).getTime() > thirtyDaysAgo).forEach(r => {
        const day = r.created_at.split('T')[0];
        dailyMap.set(day, (dailyMap.get(day) || 0) + r.amount);
      });
      const trendData = Array.from(dailyMap.entries())
        .sort((a, b) => a[0].localeCompare(b[0]))
        .slice(-14)
        .map(([date, amount]) => ({
          name: new Date(date).toLocaleDateString('en-UG', { day: 'numeric', month: 'short' }),
          amount,
        }));

      // Resolve tenant names
      const tenantIds = [...new Set(active.map(r => r.tenant_id))];
      let nameMap = new Map<string, string>();
      if (tenantIds.length > 0) {
        const { data: profiles } = await supabase.from('profiles').select('id, full_name').in('id', tenantIds.slice(0, 50));
        nameMap = new Map((profiles || []).map(p => [p.id, p.full_name]));
      }

      const tableRows: ObligationRow[] = active.map(r => {
        const out = (r.total_repayment || 0) - (r.amount_repaid || 0);
        const prog = r.total_repayment ? ((r.amount_repaid || 0) / r.total_repayment * 100).toFixed(0) : '0';
        return {
          tenant: nameMap.get(r.tenant_id) || r.tenant_id.slice(0, 8),
          rentAmount: r.rent_amount || 0,
          totalRepayment: r.total_repayment || 0,
          amountRepaid: r.amount_repaid || 0,
          outstanding: out,
          progress: `${prog}%`,
          status: Number(prog) < 20 ? 'High' : Number(prog) < 60 ? 'Medium' : 'Low',
        };
      }).sort((a, b) => b.outstanding - a.outstanding);

      setData({
        coverageRatio: (coverageRatio * 100).toFixed(1),
        coverageStatus,
        coverageLabel,
        totalObligations,
        totalRepaid,
        outstanding,
        totalFees,
        activeCount: active.length,
        trendData,
        tableRows,
      });
    } catch (e) { console.error(e); }
    finally { setIsLoading(false); }
  }

  if (isLoading) return <ScreenLoader />;
  if (!data) return null;

  return (
    <COODetailLayout title="Rent Coverage" subtitle="Solvency & Liquidity" status={data.coverageStatus}>
      <div className="grid grid-cols-2 gap-3">
        <KPICard label="Coverage Ratio" value={`${data.coverageRatio}%`} status={data.coverageStatus} sub={data.coverageLabel} />
        <KPICard label="Active Obligations" value={data.activeCount} status="green" />
        <KPICard label="Outstanding" value={formatUGX(data.outstanding)} status={data.coverageStatus} />
        <KPICard label="Total Fees Earned" value={formatUGX(data.totalFees)} status="green" />
      </div>

      {data.trendData.length > 0 && (
        <>
          <SectionTitle>Repayment Trend (14D)</SectionTitle>
          <div className="rounded-2xl border-2 border-border/60 bg-card p-4 h-48">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data.trendData}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="name" tick={{ fontSize: 9 }} stroke="hsl(var(--muted-foreground))" />
                <YAxis tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
                <Tooltip formatter={(v: number) => formatUGX(v)} />
                <Area type="monotone" dataKey="amount" stroke="hsl(var(--primary))" fill="hsl(var(--primary)/0.2)" strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </>
      )}

      {data.coverageStatus === 'red' && (
        <div className="rounded-2xl border-2 border-destructive/40 bg-destructive/8 p-4">
          <p className="text-sm font-semibold text-destructive">
            ⚠️ Coverage ratio is critically low. Consider pausing new rent approvals until repayment collection improves.
          </p>
        </div>
      )}

      <COODataTable
        title="Active Obligations"
        columns={columns}
        data={data.tableRows}
        pageSize={15}
        exportFilename="rent-coverage"
      />
    </COODetailLayout>
  );
}
