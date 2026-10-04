import { useEffect, useState } from 'react';
import ScreenLoader from '@/components/common/ScreenLoader';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { roleToSlug } from '@/lib/roleRoutes';
import { supabase } from '@/integrations/supabase/client';
import COODetailLayout, { KPICard } from '@/components/coo/COODetailLayout';
import COODataTable, { COOColumn } from '@/components/coo/COODataTable';

interface PartnerReqRow {
  name: string;
  email: string;
  phone: string;
  signupDate: string;
  daysAgo: number;
}

const columns: COOColumn<PartnerReqRow>[] = [
  { key: 'name', label: 'Name' },
  { key: 'email', label: 'Email' },
  { key: 'phone', label: 'Phone' },
  { key: 'signupDate', label: 'Signed Up' },
  { key: 'daysAgo', label: 'Days Ago', align: 'right' },
];

export default function NewPartnerRequestsDetail() {
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
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

      const [monthRes, allRes] = await Promise.all([
        supabase.from('user_roles').select('user_id, created_at').eq('role', 'supporter').gte('created_at', thirtyDaysAgo).order('created_at', { ascending: false }),
        supabase.from('user_roles').select('user_id', { count: 'exact', head: true }).eq('role', 'supporter'),
      ]);

      const monthRequests = monthRes.data || [];
      const weekCount = monthRequests.filter(r => r.created_at >= sevenDaysAgo).length;
      const totalSupporters = allRes.count || 0;

      const ids = monthRequests.map(r => r.user_id);
      let profileMap = new Map<string, { name: string; email: string; phone: string }>();
      if (ids.length > 0) {
        const { data: profiles } = await supabase.from('profiles').select('id, full_name, email, phone').in('id', ids.slice(0, 50));
        profileMap = new Map((profiles || []).map(p => [p.id, { name: p.full_name, email: p.email, phone: p.phone }]));
      }

      const now = Date.now();
      const tableRows: PartnerReqRow[] = monthRequests.map(r => {
        const prof = profileMap.get(r.user_id);
        return {
          name: prof?.name || r.user_id.slice(0, 8),
          email: prof?.email || '—',
          phone: prof?.phone || '—',
          signupDate: new Date(r.created_at).toLocaleDateString('en-UG', { day: 'numeric', month: 'short', year: 'numeric' }),
          daysAgo: Math.floor((now - new Date(r.created_at).getTime()) / (24 * 60 * 60 * 1000)),
        };
      });

      setData({ thisWeek: weekCount, thisMonth: monthRequests.length, totalSupporters, tableRows });
    } catch (e) { console.error(e); }
    finally { setIsLoading(false); }
  }

  if (isLoading) return <ScreenLoader />;
  if (!data) return null;

  return (
    <COODetailLayout title="New Partner Requests" subtitle="Supporter Pipeline" status={data.thisWeek > 0 ? 'green' : 'yellow'}>
      <div className="grid grid-cols-2 gap-3">
        <KPICard label="This Week" value={data.thisWeek} status={data.thisWeek > 0 ? 'green' : 'yellow'} />
        <KPICard label="This Month" value={data.thisMonth} status="green" />
        <KPICard label="Total Supporters" value={data.totalSupporters} status="green" />
        <KPICard label="Growth Rate" value={data.totalSupporters > 0 ? `${((data.thisMonth / data.totalSupporters) * 100).toFixed(0)}%` : '0%'} sub="Monthly" status="green" />
      </div>

      <COODataTable
        title="Recent Partner Signups"
        columns={columns}
        data={data.tableRows}
        pageSize={15}
        exportFilename="new-partner-requests"
      />
    </COODetailLayout>
  );
}
