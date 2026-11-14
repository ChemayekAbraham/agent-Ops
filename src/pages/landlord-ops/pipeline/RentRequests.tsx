import { RentPipelineQueue } from '@/components/executive/RentPipelineQueue';

/**
 * `tenant_ops_approved` is the stage sitting on Landlord Ops' desk.
 * Starts with the standalone "Rent Requests waiting to be Approved" hero card;
 * clicking it opens the geographic hierarchy drilldown
 * (Continents -> Countries -> Regions -> Districts -> Counties/Divisions/Wards -> Parishes -> Villages)
 * and filters pending Rent Requests by location.
 */
export default function RentRequests() {
  return <RentPipelineQueue stage="tenant_ops_approved" viewMode="lead-only" />;
}
