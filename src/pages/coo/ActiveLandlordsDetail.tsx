import { useEffect, useState } from 'react';
import ScreenLoader from '@/components/common/ScreenLoader';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { roleToSlug } from '@/lib/roleRoutes';
import { supabase } from '@/integrations/supabase/client';
import COODetailLayout, { KPICard } from '@/components/coo/COODetailLayout';
import COODataTable, { COOColumn } from '@/components/coo/COODataTable';
import { formatUGX } from '@/lib/rentCalculations';

interface LandlordRow {
  name: string;
  property: string;
  monthlyRent: number;
  rooms: number;
  revenue30d: number;
  verified: string;
}

const columns: COOColumn<LandlordRow>[] = [
  { key: 'name', label: 'Landlord' },
  { key: 'property', label: 'Property' },
  { key: 'monthlyRent', label: 'Monthly Rent', align: 'right', render: (r) => formatUGX(r.monthlyRent) },
  { key: 'rooms', label: 'Rooms', align: 'right' },
  { key: 'revenue30d', label: 'Revenue (30D)', align: 'right', render: (r) => formatUGX(r.revenue30d) },
  { key: 'verified', label: 'Status', render: (r) => (
    <span className={r.verified === 'Yes' ? 'text-emerald-600 font-semibold' : 'text-amber-600 font-semibold'}>{r.verified === 'Yes' ? 'Verified' : 'Pending'}</span>
  )},
];

export default function ActiveLandlordsDetail() {
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

      const [landlordRes, activeRentRes] = await Promise.all([
        supabase.from('landlords').select('id, name, property_address, monthly_rent, number_of_rooms, verified')
          .order('created_at', { ascending: false }),
        supabase.from('rent_requests').select('landlord_id, rent_amount')
          .in('status', ['funded', 'disbursed']).gte('funded_at', thirtyDaysAgo),
      ]);

      const landlords = landlordRes.data || [];
      const rentData = activeRentRes.data || [];

      const revenueMap = new Map<string, number>();
      rentData.forEach(r => { revenueMap.set(r.landlord_id, (revenueMap.get(r.landlord_id) || 0) + (r.rent_amount || 0)); });

      const activeLandlordIds = new Set(revenueMap.keys());
      const totalRevenue = rentData.reduce((s, r) => s + (r.rent_amount || 0), 0);
      const totalRooms = landlords.reduce((s, l) => s + (l.number_of_rooms || 0), 0);
      const verifiedCount = landlords.filter(l => l.verified).length;

      const tableRows: LandlordRow[] = landlords
        .map(l => ({
          name: l.name,
          property: l.property_address,
          monthlyRent: l.monthly_rent || 0,
          rooms: l.number_of_rooms || 0,
          revenue30d: revenueMap.get(l.id) || 0,
          verified: l.verified ? 'Yes' : 'No',
        }))
        .sort((a, b) => b.revenue30d - a.revenue30d);

      setData({
        activeLandlords: activeLandlordIds.size,
        totalLandlords: landlords.length,
        totalRevenue,
        totalRooms,
        verifiedCount,
        tableRows,
      });
    } catch (e) { console.error(e); }
    finally { setIsLoading(false); }
  }

  if (isLoading) return <ScreenLoader />;
  if (!data) return null;

  const status = data.activeLandlords > 3 ? 'green' as const : data.activeLandlords > 0 ? 'yellow' as const : 'red' as const;

  return (
    <COODetailLayout title="Active Landlords" subtitle="Landlord Performance (30D)" status={status}>
      <div className="grid grid-cols-2 gap-3">
        <KPICard label="Active (30D)" value={data.activeLandlords} status={status} />
        <KPICard label="Total Landlords" value={data.totalLandlords} status="green" />
        <KPICard label="Revenue (30D)" value={formatUGX(data.totalRevenue)} status="green" />
        <KPICard label="Verified" value={data.verifiedCount} status="green" sub={`of ${data.totalLandlords}`} />
      </div>

      <COODataTable
        title="Landlord Directory"
        columns={columns}
        data={data.tableRows}
        pageSize={15}
        exportFilename="active-landlords"
      />
    </COODetailLayout>
  );
}
