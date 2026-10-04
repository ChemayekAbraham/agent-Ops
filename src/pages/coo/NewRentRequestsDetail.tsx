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

interface RentRow {
  tenant: string;
  amount: number;
  fees: number;
  total: number;
  status: string;
  postedBy: string;
  noPhone: boolean;
  date: string;
}

const columns: COOColumn<RentRow>[] = [
  { key: 'tenant', label: 'Tenant', render: (r) => (
    <span>{r.tenant}{r.noPhone ? ' 🚫📱' : ''}</span>
  )},
  { key: 'amount', label: 'Rent', align: 'right', render: (r) => formatUGX(r.amount) },
  { key: 'fees', label: 'Fees', align: 'right', render: (r) => formatUGX(r.fees) },
  { key: 'total', label: 'Repayment', align: 'right', render: (r) => formatUGX(r.total) },
  { key: 'postedBy', label: 'Posted By' },
  { key: 'status', label: 'Status', render: (r) => (
    <span className={r.status === 'funded' ? 'text-emerald-600 font-semibold' : r.status === 'approved' ? 'text-blue-600 font-semibold' : r.status === 'rejected' ? 'text-red-600 font-semibold' : 'text-amber-600 font-semibold'}>
      {r.status}
    </span>
  )},
  { key: 'date', label: 'Date' },
];

export default function NewRentRequestsDetail() {
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
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

      const { data: requests } = await supabase.from('rent_requests')
        .select('id, status, rent_amount, access_fee, request_fee, total_repayment, created_at, approved_at, funded_at, tenant_id, agent_id, tenant_no_smartphone')
        .gte('created_at', thirtyDaysAgo)
        .order('created_at', { ascending: false });

      const items = requests || [];
      const total = items.length;
      const pending = items.filter(r => r.status === 'pending').length;
      const approved = items.filter(r => r.status === 'approved').length;
      const funded = items.filter(r => r.status === 'funded').length;
      const rejected = items.filter(r => r.status === 'rejected').length;
      const conversionRate = total > 0 ? ((funded / total) * 100).toFixed(1) : '0';
      const totalRevenuePotential = items.filter(r => r.status !== 'rejected')
        .reduce((s, r) => s + (r.access_fee || 0) + (r.request_fee || 0), 0);

      const approvedWithTime = items.filter(r => r.approved_at && r.created_at);
      const avgApprovalHrs = approvedWithTime.length > 0
        ? (approvedWithTime.reduce((s, r) => s + (new Date(r.approved_at!).getTime() - new Date(r.created_at).getTime()), 0) / approvedWithTime.length / 3600000).toFixed(1)
        : 'N/A';

      const funnelData = [
        { name: 'Pending', count: pending },
        { name: 'Approved', count: approved },
        { name: 'Funded', count: funded },
        { name: 'Rejected', count: rejected },
      ];

      // Resolve names
      const allIds = [...new Set(items.flatMap(r => [r.tenant_id, r.agent_id].filter(Boolean)))] as string[];
      let nameMap = new Map<string, string>();
      if (allIds.length > 0) {
        const { data: profiles } = await supabase.from('profiles').select('id, full_name').in('id', allIds.slice(0, 50));
        nameMap = new Map((profiles || []).map(p => [p.id, p.full_name]));
      }

      const tableRows: RentRow[] = items.map(r => ({
        tenant: nameMap.get(r.tenant_id) || r.tenant_id.slice(0, 8),
        amount: r.rent_amount || 0,
        fees: (r.access_fee || 0) + (r.request_fee || 0),
        total: r.total_repayment || 0,
        status: r.status || 'pending',
        postedBy: r.agent_id && r.agent_id !== r.tenant_id
          ? `Agent: ${nameMap.get(r.agent_id) || 'Unknown'}`
          : 'Self',
        noPhone: r.tenant_no_smartphone || false,
        date: new Date(r.created_at).toLocaleDateString('en-UG', { day: 'numeric', month: 'short' }),
      }));

      setData({ total, conversionRate, avgApprovalHrs, totalRevenuePotential, funnelData, tableRows });
    } catch (e) { console.error(e); }
    finally { setIsLoading(false); }
  }

  if (isLoading) return <ScreenLoader />;
  if (!data) return null;

  return (
    <COODetailLayout title="New Rent Requests" subtitle="30-Day Funnel Analysis" status={data.total > 0 ? 'green' : 'yellow'}>
      <div className="grid grid-cols-2 gap-3">
        <KPICard label="Total Requests (30D)" value={data.total} status="green" />
        <KPICard label="Conversion Rate" value={`${data.conversionRate}%`} status={Number(data.conversionRate) > 30 ? 'green' : 'yellow'} />
        <KPICard label="Avg Approval Time" value={data.avgApprovalHrs === 'N/A' ? 'N/A' : `${data.avgApprovalHrs}h`} status={data.avgApprovalHrs !== 'N/A' && Number(data.avgApprovalHrs) < 48 ? 'green' : 'yellow'} />
        <KPICard label="Revenue Potential" value={formatUGX(data.totalRevenuePotential)} status="green" />
      </div>

      <SectionTitle>Request Funnel</SectionTitle>
      <div className="rounded-2xl border-2 border-border/60 bg-card p-4 h-48">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data.funnelData} layout="vertical">
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
            <XAxis type="number" tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
            <YAxis dataKey="name" type="category" tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" width={70} />
            <Tooltip />
            <Bar dataKey="count" fill="hsl(var(--primary))" radius={[0, 6, 6, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      <COODataTable
        title="Recent Rent Requests"
        columns={columns}
        data={data.tableRows}
        pageSize={15}
        exportFilename="rent-requests"
      />
    </COODetailLayout>
  );
}
