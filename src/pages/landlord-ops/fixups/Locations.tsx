import { LocationReconciliationCard } from '@/components/executive/landlord-ops/LocationReconciliationCard';
import { LocationHierarchyView } from '@/components/executive/landlord-ops/LocationHierarchyView';

export default function Locations() {
  return (
    <div className="space-y-4">
      <LocationReconciliationCard />
      <LocationHierarchyView />
    </div>
  );
}
