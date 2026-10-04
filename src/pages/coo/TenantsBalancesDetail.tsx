import { useEffect, useState } from 'react';
import ScreenLoader from '@/components/common/ScreenLoader';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { roleToSlug } from '@/lib/roleRoutes';
import { supabase } from '@/integrations/supabase/client';
import COODetailLayout, { KPICard, SectionTitle } from '@/components/coo/COODetailLayout';
import COODataTable, { COOColumn } from '@/components/coo/COODataTable';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';
import { formatUGX } from '@/lib/rentCalculations';

const COLORS = ['hsl(142, 71%, 45%)', 'hsl(45, 93%, 47%)', 'hsl(0, 84%, 60%)'];

interface TenantRow {
  name: string;
  outstanding: number;
  repaid: number;
  total: number;
  status: string;
  fundedDate: string;
  ageDays: number;
}

const tenantColumns: COOColumn<TenantRow>[] = [
  { key: 'name', label: 'Tenant' },
  { key: 'outstanding', label: 'Outstanding', align: 'right', render: (r) => formatUGX(r.outstanding) },
  { key: 'repaid', label: 'Repaid', align: 'right', render: (r) => formatUGX(r.repaid) },
  { key: 'total', label: 'Total', align: 'right', render: (r) => formatUGX(r.total) },
  { key: 'ageDays', label: 'Age', align: 'right', render: (r) => `${r.ageDays}d` },
  { key: 'status', label: 'Status', render: (r) => (
    <span className={r.ageDays > 60 ? 'text-red-600 font-bold' : r.ageDays > 30 ? 'text-amber-600 font-semibold' : 'text-emerald-600 font-semibold'}>
      {r.ageDays > 60 ? 'High Risk' : r.ageDays > 30 ? 'Monitor' : 'Current'}
    </span>
  )},
];

const detailCols: COOColumn<TenantRow>[] = [
  { key: 'fundedDate', label: 'Funded Date' },
];

export default function TenantsBalancesDetail() {
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
      const { data: requests } = await supabase.from('rent_requests')
        .select('id, tenant_id, total_repayment, amount_repaid, created_at, funded_at, status, rent_amount')
        .in('status', ['funded', 'approved'])
        .order('created_at', { ascending: false });

      const items = requests || [];
      const totalOutstanding = items.reduce((s, r) => s + ((r.total_repayment || 0) - (r.amount_repaid || 0)), 0);
      const totalRepaid = items.reduce((s, r) => s + (r.amount_repaid || 0), 0);
      const totalExpected = items.reduce((s, r) => s + (r.total_repayment || 0), 0);
      const collectionRate = totalExpected > 0 ? ((totalRepaid / totalExpected) * 100).toFixed(1) : '0';

      const now = Date.now();
      let aging = { current: 0, days30: 0, days60plus: 0 };
      items.forEach(r => {
        const outstanding = (r.total_repayment || 0) - (r.amount_repaid || 0);
        if (outstanding <= 0) return;
        const fundedAt = r.funded_at ? new Date(r.funded_at).getTime() : now;
        const daysSince = (now - fundedAt) / (24 * 60 * 60 * 1000);
        if (daysSince <= 30) aging.current += outstanding;
        else if (daysSince <= 60) aging.days30 += outstanding;
        else aging.days60plus += outstanding;
      });

      const agingChart = [
        { name: '0-30 days', value: aging.current },
        { name: '31-60 days', value: aging.days30 },
        { name: '60+ days', value: aging.days60plus },
      ].filter(a => a.value > 0);

      // Build tenant table rows
      const tenantAgg = new Map<string, { outstanding: number; repaid: number; total: number; fundedAt: number }>();
      items.forEach(r => {
        const existing = tenantAgg.get(r.tenant_id) || { outstanding: 0, repaid: 0, total: 0, fundedAt: now };
        existing.outstanding += (r.total_repayment || 0) - (r.amount_repaid || 0);
        existing.repaid += (r.amount_repaid || 0);
        existing.total += (r.total_repayment || 0);
        if (r.funded_at) existing.fundedAt = Math.min(existing.fundedAt, new Date(r.funded_at).getTime());
        tenantAgg.set(r.tenant_id, existing);
      });

      const tenantIds = Array.from(tenantAgg.keys());
      let nameMap = new Map<string, string>();
      if (tenantIds.length > 0) {
        const { data: profiles } = await supabase.from('profiles').select('id, full_name').in('id', tenantIds.slice(0, 50));
        nameMap = new Map((profiles || []).map(p => [p.id, p.full_name]));
      }

      const tableRows: TenantRow[] = Array.from(tenantAgg.entries())
        .map(([id, agg]) => ({
          name: nameMap.get(id) || id.slice(0, 8),
          outstanding: agg.outstanding,
          repaid: agg.repaid,
          total: agg.total,
          status: '',
          fundedDate: new Date(agg.fundedAt).toLocaleDateString('en-UG', { day: 'numeric', month: 'short' }),
          ageDays: Math.floor((now - agg.fundedAt) / (24 * 60 * 60 * 1000)),
        }))
        .filter(r => r.outstanding > 0)
        .sort((a, b) => b.outstanding - a.outstanding);

      // "count" must match the deduped, outstanding>0 tenant rows shown in the
      // table (and the COO dashboard KPI) — not the raw rent_request row count.
      setData({ count: tableRows.length, totalOutstanding, collectionRate, agingChart, totalRepaid, tableRows });
    } catch (e) { console.error(e); }
    finally { setIsLoading(false); }
  }

  if (isLoading) return <ScreenLoader />;
  if (!data) return null;

  return (
    <COODetailLayout title="Tenants With Balances" subtitle="Outstanding Obligations" status={data.count > 0 ? 'green' : 'yellow'}>
      <div className="grid grid-cols-2 gap-3">
        <KPICard label="Active Obligations" value={data.count} status="green" />
        <KPICard label="Total Outstanding" value={formatUGX(data.totalOutstanding)} status={data.totalOutstanding > 5000000 ? 'yellow' : 'green'} />
        <KPICard label="Collection Rate" value={`${data.collectionRate}%`} status={Number(data.collectionRate) > 50 ? 'green' : 'red'} />
        <KPICard label="Total Repaid" value={formatUGX(data.totalRepaid)} status="green" />
      </div>

      {data.agingChart.length > 0 && (
        <>
          <SectionTitle>Aging Breakdown</SectionTitle>
          <div className="rounded-2xl border-2 border-border/60 bg-card p-4 h-48 flex items-center justify-center">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={data.agingChart} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={65} label={({ name }) => name}>
                  {data.agingChart.map((_: any, i: number) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                </Pie>
                <Tooltip formatter={(v: number) => formatUGX(v)} />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </>
      )}

      <COODataTable
        title="Tenant Balances"
        columns={tenantColumns}
        detailColumns={detailCols}
        data={data.tableRows}
        pageSize={15}
        exportFilename="tenants-with-balances"
      />
    </COODetailLayout>
  );
}
