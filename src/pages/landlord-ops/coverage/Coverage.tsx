import { PropertyMapView } from '@/components/executive/landlord-ops/PropertyMapView';
import { LandlordOpsDashboard } from '@/components/executive/LandlordOpsDashboard';

export default function Coverage() {
  return (
    <div className="space-y-4">
      <PropertyMapView />
      <LandlordOpsDashboard view="cities" hideOverview />
    </div>
  );
}
