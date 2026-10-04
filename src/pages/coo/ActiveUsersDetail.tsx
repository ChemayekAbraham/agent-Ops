import { useEffect, useState } from 'react';
import ScreenLoader from '@/components/common/ScreenLoader';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { roleToSlug } from '@/lib/roleRoutes';
import { supabase } from '@/integrations/supabase/client';
import COODetailLayout, { KPICard, SectionTitle } from '@/components/coo/COODetailLayout';
import COODataTable, { COOColumn } from '@/components/coo/COODataTable';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';

interface UserRow {
  name: string;
  email: string;
  phone: string;
  city: string;
  lastActive: string;
  daysAgo: number;
  verified: string;
  createdAt: string;
}

const columns: COOColumn<UserRow>[] = [
  { key: 'name', label: 'Name' },
  { key: 'email', label: 'Email' },
  { key: 'city', label: 'City' },
  { key: 'lastActive', label: 'Last Active' },
  { key: 'daysAgo', label: 'Days Ago', align: 'right' },
  { key: 'verified', label: 'Verified', render: (r) => (
    <span className={r.verified === 'Yes' ? 'text-emerald-600 font-semibold' : 'text-amber-600 font-semibold'}>{r.verified}</span>
  )},
];

const detailColumns: COOColumn<UserRow>[] = [
  { key: 'phone', label: 'Phone' },
  { key: 'createdAt', label: 'Joined' },
];

export default function ActiveUsersDetail() {
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
      const now = new Date();
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString();

      const [totalRes, active7dRes, active14dRes, usersRes] = await Promise.all([
        supabase.from('profiles').select('id', { count: 'exact', head: true }),
        supabase.from('profiles').select('id', { count: 'exact', head: true }).gte('last_active_at', sevenDaysAgo),
        supabase.from('profiles').select('id', { count: 'exact', head: true }).gte('last_active_at', fourteenDaysAgo),
        supabase.from('profiles')
          .select('id, full_name, email, phone, city, last_active_at, verified, created_at')
          .order('last_active_at', { ascending: false })
          .limit(100),
      ]);

      const total = totalRes.count || 0;
      const active7d = active7dRes.count || 0;
      const active14d = active14dRes.count || 0;
      const activationRate = total > 0 ? ((active7d / total) * 100).toFixed(1) : '0';
      const prevWeekActive = Math.max(0, (active14d || 0) - (active7d || 0));
      const growthRate = prevWeekActive > 0 ? (((active7d - prevWeekActive) / prevWeekActive) * 100).toFixed(1) : 'N/A';

      const users = usersRes.data || [];
      const nowMs = Date.now();

      // Daily trend from actual user activity
      const periods = Array.from({ length: 7 }, (_, i) => {
        const d = new Date(now.getTime() - (6 - i) * 24 * 60 * 60 * 1000);
        const dayStr = d.toISOString().split('T')[0];
        const activeOnDay = users.filter(u => u.last_active_at && u.last_active_at.startsWith(dayStr)).length;
        return { name: d.toLocaleDateString('en-UG', { weekday: 'short' }), users: activeOnDay };
      });

      const tableRows: UserRow[] = users.map(u => ({
        name: u.full_name,
        email: u.email,
        phone: u.phone || '—',
        city: u.city || 'Unknown',
        lastActive: u.last_active_at ? new Date(u.last_active_at).toLocaleDateString('en-UG', { day: 'numeric', month: 'short' }) : 'Never',
        daysAgo: u.last_active_at ? Math.floor((nowMs - new Date(u.last_active_at).getTime()) / (24 * 60 * 60 * 1000)) : 999,
        verified: u.verified ? 'Yes' : 'No',
        createdAt: new Date(u.created_at).toLocaleDateString('en-UG', { day: 'numeric', month: 'short', year: 'numeric' }),
      }));

      setData({ total, active7d, activationRate, growthRate, trendData: periods, tableRows });
    } catch (e) { console.error(e); }
    finally { setIsLoading(false); }
  }

  if (isLoading) return <ScreenLoader />;
  if (!data) return null;

  const status = data.active7d > 10 ? 'green' as const : data.active7d > 0 ? 'yellow' as const : 'red' as const;

  return (
    <COODetailLayout title="Active Users" subtitle="7-Day Activity Analysis" status={status}>
      <div className="grid grid-cols-2 gap-3">
        <KPICard label="Total Users" value={data.total} status="green" />
        <KPICard label="Active (7D)" value={data.active7d} status={status} />
        <KPICard label="Activation Rate" value={`${data.activationRate}%`} sub="Active / Total" status={Number(data.activationRate) > 20 ? 'green' : 'yellow'} />
        <KPICard label="WoW Growth" value={data.growthRate === 'N/A' ? 'N/A' : `${data.growthRate}%`} status={data.growthRate !== 'N/A' && Number(data.growthRate) > 0 ? 'green' : 'yellow'} />
      </div>

      <SectionTitle>7-Day Activity Trend</SectionTitle>
      <div className="rounded-2xl border-2 border-border/60 bg-card p-4 h-48">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data.trendData}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
            <XAxis dataKey="name" tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
            <YAxis tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
            <Tooltip />
            <Line type="monotone" dataKey="users" stroke="hsl(var(--primary))" strokeWidth={2} dot={{ r: 3 }} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <COODataTable
        title="User Directory"
        columns={columns}
        detailColumns={detailColumns}
        data={data.tableRows}
        pageSize={15}
        exportFilename="active-users"
      />
    </COODetailLayout>
  );
}
