import { useEffect, useState } from 'react';
import ScreenLoader from '@/components/common/ScreenLoader';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { roleToSlug } from '@/lib/roleRoutes';
import { supabase } from '@/integrations/supabase/client';
import COODetailLayout, { KPICard, SectionTitle } from '@/components/coo/COODetailLayout';
import COODataTable, { COOColumn } from '@/components/coo/COODataTable';
import { formatUGX } from '@/lib/rentCalculations';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';

interface PipelineRow {
  name: string;
  property: string;
  monthlyRent: number;
  desiredRent: number;
  daysInPipeline: number;
  stage: string;
}

const columns: COOColumn<PipelineRow>[] = [
  { key: 'name', label: 'Landlord' },
  { key: 'property', label: 'Property' },
  { key: 'monthlyRent', label: 'Monthly Rent', align: 'right', render: (r) => formatUGX(r.monthlyRent) },
  { key: 'desiredRent', label: 'Desired from Welile', align: 'right', render: (r) => formatUGX(r.desiredRent) },
  { key: 'daysInPipeline', label: 'Days', align: 'right' },
  { key: 'stage', label: 'Stage', render: (r) => (
    <span className={r.daysInPipeline > 30 ? 'text-red-600 font-bold' : r.daysInPipeline > 7 ? 'text-amber-600 font-semibold' : 'text-emerald-600 font-semibold'}>
      {r.stage}
    </span>
  )},
];

export default function PipelineLandlordsDetail() {
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
      const [unverifiedRes, verifiedRes] = await Promise.all([
        supabase.from('landlords').select('id, name, property_address, monthly_rent, created_at, desired_rent_from_welile')
          .eq('verified', false).order('created_at', { ascending: false }),
        supabase.from('landlords').select('id', { count: 'exact', head: true }).eq('verified', true),
      ]);

      const pipeline = unverifiedRes.data || [];
      const verifiedCount = verifiedRes.count || 0;
      const estimatedRevenue = pipeline.reduce((s, l) => s + (l.desired_rent_from_welile || l.monthly_rent || 0), 0);

      const now = Date.now();
      let age = { week: 0, month: 0, older: 0 };
      pipeline.forEach(l => {
        const days = (now - new Date(l.created_at).getTime()) / (24 * 60 * 60 * 1000);
        if (days <= 7) age.week++;
        else if (days <= 30) age.month++;
        else age.older++;
      });

      const stageData = [
        { name: '< 7 days', count: age.week },
        { name: '7-30 days', count: age.month },
        { name: '30+ days', count: age.older },
      ];

      const tableRows: PipelineRow[] = pipeline.map(l => {
        const days = Math.floor((now - new Date(l.created_at).getTime()) / (24 * 60 * 60 * 1000));
        return {
          name: l.name,
          property: l.property_address,
          monthlyRent: l.monthly_rent || 0,
          desiredRent: l.desired_rent_from_welile || 0,
          daysInPipeline: days,
          stage: days > 30 ? 'Stuck' : days > 7 ? 'In Progress' : 'New',
        };
      });

      setData({ totalInPipeline: pipeline.length, verifiedCount, estimatedRevenue, stageData, tableRows, bottleneckOlder: age.older });
    } catch (e) { console.error(e); }
    finally { setIsLoading(false); }
  }

  if (isLoading) return <ScreenLoader />;
  if (!data) return null;

  return (
    <COODetailLayout title="Landlords in Pipeline" subtitle="Onboarding Progress" status={data.totalInPipeline > 0 ? 'green' : 'yellow'}>
      <div className="grid grid-cols-2 gap-3">
        <KPICard label="In Pipeline" value={data.totalInPipeline} status={data.totalInPipeline > 0 ? 'green' : 'yellow'} />
        <KPICard label="Already Verified" value={data.verifiedCount} status="green" />
        <KPICard label="Est. Revenue" value={formatUGX(data.estimatedRevenue)} sub="Monthly potential" status="green" />
        <KPICard label="Bottleneck (30d+)" value={data.bottleneckOlder} status={data.bottleneckOlder > 3 ? 'red' : 'green'} sub="Stuck in pipeline" />
      </div>

      <SectionTitle>Onboarding Stage Breakdown</SectionTitle>
      <div className="rounded-2xl border-2 border-border/60 bg-card p-4 h-44">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data.stageData}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
            <XAxis dataKey="name" tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
            <YAxis tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
            <Tooltip />
            <Bar dataKey="count" fill="hsl(var(--primary))" radius={[6, 6, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      <COODataTable
        title="Pipeline Landlords"
        columns={columns}
        data={data.tableRows}
        pageSize={15}
        exportFilename="pipeline-landlords"
      />
    </COODetailLayout>
  );
}
